import { Migration } from '@mikro-orm/migrations';

export const UP_SQL = `CREATE TABLE wallets (
  id UUID PRIMARY KEY,
  player_id TEXT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance NUMERIC(18,2) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency),
  CONSTRAINT ck_wallet_balance CHECK (balance >= 0),
  CONSTRAINT ck_wallet_version CHECK (version >= 1),
  CONSTRAINT ck_wallet_currency CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE TABLE wager_transactions (
  id UUID PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_transaction_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  player_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  reference_external_transaction_id TEXT NULL,
  reference_transaction_id UUID NULL REFERENCES wager_transactions(id),
  status TEXT NOT NULL,
  failure_code TEXT NULL,
  recorded_balance_amount NUMERIC(18,2) NULL,
  recorded_balance_currency VARCHAR(3) NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT uq_wager_idempotency UNIQUE (idempotency_key),
  CONSTRAINT ck_wager_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT ck_wager_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT ck_wager_amount CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
  CONSTRAINT ck_wager_reference CHECK ((kind NOT IN ('REFUND','ROLLBACK')) OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT ck_wager_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_wager_balance_snapshot CHECK (recorded_balance_amount IS NULL OR recorded_balance_amount >= 0),
  CONSTRAINT ck_wager_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_wager_terminal_snapshot CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED','PENDING_REFERENCE') OR recorded_balance_amount IS NOT NULL),
  CONSTRAINT ck_wager_rejected_code CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
  CONSTRAINT ck_wager_pending_ref_schedule CHECK (status <> 'PENDING_REFERENCE' OR (next_retry_at IS NOT NULL AND expires_at IS NOT NULL))
);

-- Sem duplicar reversão efetivamente aplicada, inclusive REFUND + ROLLBACK da mesma BET.
CREATE UNIQUE INDEX uq_wager_processed_reversal
ON wager_transactions(reference_transaction_id)
WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NOT NULL;
CREATE INDEX idx_wager_pending_ref ON wager_transactions(next_retry_at, id)
WHERE status = 'PENDING_REFERENCE';
CREATE INDEX idx_wager_ref_lookup ON wager_transactions(provider_id, external_transaction_id);

CREATE TABLE wallet_ledger_entries (
  id UUID PRIMARY KEY,
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
  direction TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance_before NUMERIC(18,2) NOT NULL,
  balance_after NUMERIC(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ledger_wallet_tx UNIQUE(wallet_id, transaction_id),
  CONSTRAINT ck_ledger_direction CHECK(direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ck_ledger_amount CHECK(amount > 0),
  CONSTRAINT ck_ledger_balances CHECK(balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ck_ledger_arithmetic CHECK(
    (direction = 'DEBIT' AND balance_after = balance_before - amount)
    OR (direction = 'CREDIT' AND balance_after = balance_before + amount)
  ),
  CONSTRAINT ck_ledger_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX idx_ledger_wallet_cursor
ON wallet_ledger_entries(wallet_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'immutable ledger: % forbidden', TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION protect_terminal_wager() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'terminal wager is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager audit deletion forbidden' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
    RAISE EXCEPTION 'invalid wager transition' USING ERRCODE = '23514';
  END IF;
  -- Identidade e payload nunca mudam durante estados intermediários.
  IF ROW(NEW.id,NEW.created_at,NEW.provider_id,NEW.external_transaction_id,NEW.idempotency_key,NEW.payload_hash,
         NEW.wallet_id,NEW.player_id,NEW.round_id,NEW.game_id,NEW.kind,NEW.amount,NEW.currency,
         NEW.reference_external_transaction_id)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.created_at,OLD.provider_id,OLD.external_transaction_id,OLD.idempotency_key,OLD.payload_hash,
         OLD.wallet_id,OLD.player_id,OLD.round_id,OLD.game_id,OLD.kind,OLD.amount,OLD.currency,
         OLD.reference_external_transaction_id) THEN
    RAISE EXCEPTION 'wager identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_wager_terminal BEFORE UPDATE OR DELETE ON wager_transactions
FOR EACH ROW EXECUTE FUNCTION protect_terminal_wager();

CREATE TABLE inbox_messages (
  consumer_name TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  PRIMARY KEY(consumer_name,message_id)
);

CREATE TABLE outbox_messages (
  id UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT NULL,
  lease_token UUID NULL,
  lease_until TIMESTAMPTZ NULL,
  published_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  CONSTRAINT ck_outbox_attempts CHECK(attempts >= 0),
  CONSTRAINT ck_outbox_lease CHECK(
    (lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL) OR
    (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  )
);
CREATE INDEX idx_outbox_due ON outbox_messages(next_attempt_at, occurred_at, id)
WHERE published_at IS NULL;

ALTER TABLE wallets ADD CONSTRAINT uq_wallet_identity UNIQUE(id, player_id);
ALTER TABLE wallets ADD CONSTRAINT uq_wallet_currency UNIQUE(id, currency);
ALTER TABLE wager_transactions ADD CONSTRAINT uq_wager_wallet_currency UNIQUE(id, wallet_id, currency);
ALTER TABLE wager_transactions ADD CONSTRAINT fk_wager_wallet_player FOREIGN KEY(wallet_id, player_id) REFERENCES wallets(id, player_id);
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_hash CHECK(payload_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_unexpected_reference CHECK(kind NOT IN ('BET','LOSS','OPENING') OR (reference_external_transaction_id IS NULL AND reference_transaction_id IS NULL));
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_processed_reference CHECK(status <> 'PROCESSED' OR NOT (kind IN ('REFUND','ROLLBACK') OR (kind='WIN' AND reference_external_transaction_id IS NOT NULL)) OR reference_transaction_id IS NOT NULL);
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_internal_reference CHECK(reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL);
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_no_self_reference CHECK(reference_external_transaction_id IS DISTINCT FROM external_transaction_id AND reference_transaction_id IS DISTINCT FROM id);
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_snapshot_currency CHECK((recorded_balance_amount IS NULL AND recorded_balance_currency IS NULL) OR (recorded_balance_amount IS NOT NULL AND recorded_balance_currency ~ '^[A-Z]{3}$'));
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_processed_time CHECK(status <> 'PROCESSED' OR processed_at IS NOT NULL);
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_failure_state CHECK(status IN ('REJECTED','FAILED') OR failure_code IS NULL);
ALTER TABLE wager_transactions ADD CONSTRAINT ck_opening_metadata CHECK(kind <> 'OPENING' OR (provider_id='SYSTEM' AND external_transaction_id='opening:'||wallet_id::text AND idempotency_key='SYSTEM:opening:'||wallet_id::text AND round_id='opening:'||wallet_id::text AND game_id='SYSTEM_OPENING' AND status='PROCESSED'));
ALTER TABLE wager_transactions ADD CONSTRAINT ck_system_kind CHECK(provider_id <> 'SYSTEM' OR kind='OPENING');
CREATE UNIQUE INDEX uq_opening_wallet ON wager_transactions(wallet_id) WHERE kind='OPENING';
ALTER TABLE wallet_ledger_entries ADD CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency);
ALTER TABLE wallet_ledger_entries ADD CONSTRAINT fk_ledger_wager_context FOREIGN KEY(transaction_id,wallet_id,currency) REFERENCES wager_transactions(id,wallet_id,currency);
ALTER TABLE inbox_messages ADD CONSTRAINT ck_inbox_hash CHECK(payload_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE outbox_messages ADD CONSTRAINT fk_outbox_aggregate FOREIGN KEY(aggregate_id) REFERENCES wallets(id);

CREATE FUNCTION protect_wallet_identity_version() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.version <> 1 THEN RAISE EXCEPTION 'wallet starts at version 1' USING ERRCODE='23514'; END IF;
  ELSE
    IF ROW(NEW.id,NEW.player_id,NEW.currency,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.player_id,OLD.currency,OLD.created_at) THEN
      RAISE EXCEPTION 'wallet identity immutable' USING ERRCODE='55000';
    END IF;
    IF NEW.version <> OLD.version + (CASE WHEN NEW.balance IS DISTINCT FROM OLD.balance THEN 1 ELSE 0 END) THEN
      RAISE EXCEPTION 'wallet version follows balance' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_wallet_identity_version BEFORE INSERT OR UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION protect_wallet_identity_version();

CREATE FUNCTION verify_wallet_ledger() RETURNS TRIGGER AS $$
DECLARE wid UUID; stored NUMERIC; calculated NUMERIC;
BEGIN
  IF TG_TABLE_NAME='wallets' THEN wid:=NEW.id; ELSE wid:=NEW.wallet_id; END IF;
  SELECT balance INTO stored FROM wallets WHERE id=wid;
  SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0) INTO calculated FROM wallet_ledger_entries WHERE wallet_id=wid;
  IF stored IS DISTINCT FROM calculated THEN RAISE EXCEPTION 'wallet ledger mismatch' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_wallet_ledger_total AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_ledger();
CREATE CONSTRAINT TRIGGER trg_ledger_wallet_total AFTER INSERT ON wallet_ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_ledger();

CREATE FUNCTION verify_wager_ledger_reference() RETURNS TRIGGER AS $$
DECLARE tid UUID; t wager_transactions%ROWTYPE; r wager_transactions%ROWTYPE; e wallet_ledger_entries%ROWTYPE; n BIGINT; wc TEXT; expected TEXT;
BEGIN
  IF TG_TABLE_NAME='wager_transactions' THEN tid:=NEW.id; ELSE tid:=NEW.transaction_id; END IF;
  SELECT * INTO t FROM wager_transactions WHERE id=tid;
  SELECT COUNT(*) INTO n FROM wallet_ledger_entries WHERE transaction_id=tid AND wallet_id=t.wallet_id;
  SELECT currency INTO wc FROM wallets WHERE id=t.wallet_id;
  IF t.recorded_balance_amount IS NOT NULL AND t.recorded_balance_currency IS DISTINCT FROM wc THEN
    RAISE EXCEPTION 'snapshot must use wallet currency' USING ERRCODE='23514';
  END IF;
  IF t.status='PROCESSED' AND t.currency IS DISTINCT FROM wc THEN RAISE EXCEPTION 'processed wager currency mismatch' USING ERRCODE='23514'; END IF;
  IF t.status='PROCESSED' AND t.kind<>'LOSS' THEN
    IF n<>1 THEN RAISE EXCEPTION 'processed financial wager requires ledger' USING ERRCODE='23514'; END IF;
    SELECT * INTO e FROM wallet_ledger_entries WHERE transaction_id=tid AND wallet_id=t.wallet_id;
    expected:=CASE WHEN t.kind='BET' THEN 'DEBIT' ELSE 'CREDIT' END;
    IF t.kind='ROLLBACK' THEN
      SELECT * INTO r FROM wager_transactions WHERE id=t.reference_transaction_id;
      expected:=CASE WHEN r.kind='BET' THEN 'CREDIT' ELSE 'DEBIT' END;
    END IF;
    IF e.amount<>t.amount OR e.direction<>expected THEN RAISE EXCEPTION 'ledger effect differs from wager' USING ERRCODE='23514'; END IF;
  ELSIF n<>0 THEN RAISE EXCEPTION 'nonfinancial or unprocessed wager cannot have ledger' USING ERRCODE='23514';
  END IF;
  IF t.status='PROCESSED' AND t.reference_transaction_id IS NOT NULL THEN
    SELECT * INTO r FROM wager_transactions WHERE id=t.reference_transaction_id;
    IF r.status IS DISTINCT FROM 'PROCESSED' OR ROW(r.provider_id,r.player_id,r.wallet_id,r.round_id,r.currency,r.external_transaction_id)
      IS DISTINCT FROM ROW(t.provider_id,t.player_id,t.wallet_id,t.round_id,t.currency,t.reference_external_transaction_id) THEN
      RAISE EXCEPTION 'invalid reference context/status' USING ERRCODE='23514';
    END IF;
    IF (t.kind IN ('WIN','REFUND') AND r.kind<>'BET') OR (t.kind='ROLLBACK' AND r.kind NOT IN ('BET','WIN','REFUND')) THEN
      RAISE EXCEPTION 'invalid reference kind' USING ERRCODE='23514';
    END IF;
    IF t.kind IN ('REFUND','ROLLBACK') AND t.amount<>r.amount THEN RAISE EXCEPTION 'reference amount mismatch' USING ERRCODE='23514'; END IF;
    IF t.kind='WIN' AND EXISTS(SELECT 1 FROM wager_transactions WHERE reference_transaction_id=r.id AND kind IN ('REFUND','ROLLBACK') AND status='PROCESSED') THEN
      RAISE EXCEPTION 'WIN reference already reversed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_wager_effect AFTER INSERT OR UPDATE ON wager_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wager_ledger_reference();
CREATE CONSTRAINT TRIGGER trg_ledger_effect AFTER INSERT ON wallet_ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wager_ledger_reference();
`;

export const DOWN_SQL = `DROP TABLE outbox_messages;
DROP TABLE inbox_messages;
DROP TABLE wallet_ledger_entries;
DROP TABLE wager_transactions;
DROP TABLE wallets;
DROP FUNCTION verify_wager_ledger_reference();
DROP FUNCTION verify_wallet_ledger();
DROP FUNCTION protect_wallet_identity_version();
DROP FUNCTION protect_terminal_wager();
DROP FUNCTION prevent_ledger_mutation();`;

export class Migration202611040001 extends Migration {
  override async up(): Promise<void> { this.addSql(UP_SQL); }
  override async down(): Promise<void> { this.addSql(DOWN_SQL); }
}
