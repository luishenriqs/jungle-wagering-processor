import { dateCopy, requireText } from '../shared/domain/validation';
import { internalId } from '../shared/application/identifiers';
import { InvalidDomainInputError } from '../shared/domain/domain-errors';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { FinancialStore, LedgerPosition } from '../shared/application/financial-store';
import type { Wallet } from '../modules/wallets/domain/wallet';
import type { WagerTransaction } from '../modules/wagering/domain/wager-transaction';
import type { WalletLedgerEntry } from '../modules/wallets/domain/wallet-ledger-entry';
import type { OutboxMessage, RetryPolicy } from '../modules/messaging/domain/outbox-message';
import type { InboxMessage } from '../modules/messaging/domain/inbox-message';
import { PersistenceInvariantError } from '../shared/application/application-errors';
import { walletRecord, walletDomain, wagerRecord, wagerDomain, ledgerRecord, ledgerDomain, inboxDomain, outboxRecord, outboxDomain } from './mappers';
import type { WalletRecord, WagerRecord, LedgerRecord, InboxRecord, OutboxRecord, PostgresRow } from './records';

/** All statements use the transactional SqlEntityManager, never an independent connection. */
export class PostgresFinancialStore implements FinancialStore {
  constructor(private readonly em: EntityManager) {}
  private async insert(table: string, record: object): Promise<void> {
    const fields = Object.keys(record);
    await this.em.execute(`insert into ${table} (${fields.join(',')}) values (${fields.map(() => '?').join(',')})`, Object.values(record));
  }
  async getWallet(id: string, lock = false): Promise<Wallet | undefined> {
    const rows = await this.em.execute<PostgresRow<WalletRecord>[]>(`select * from wallets where id=?${lock ? ' for update' : ''}`, [id]);
    return rows[0] && walletDomain(rows[0]);
  }
  async insertWallet(w: Wallet): Promise<void> { await this.insert('wallets', walletRecord(w)); }
  async updateWallet(w: Wallet): Promise<void> {
    const rows = await this.em.execute<{ id: string }[]>('update wallets set balance=?,version=?,updated_at=? where id=? returning id', [w.balance.toString(), w.version, w.updatedAt, w.id]);
    if (rows.length !== 1) throw new PersistenceInvariantError('Wallet update did not affect one row');
  }
  async getWager(id: string, lock = false): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<PostgresRow<WagerRecord>[]>(`select * from wager_transactions where id=?${lock ? ' for update' : ''}`, [id]);
    return rows[0] && wagerDomain(rows[0]);
  }
  async findWager(provider: string, external: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<PostgresRow<WagerRecord>[]>('select * from wager_transactions where provider_id=? and external_transaction_id=?', [provider, external]);
    return rows[0] && wagerDomain(rows[0]);
  }
  async findIdentity(key: string, provider: string, external: string): Promise<WagerTransaction[]> {
    const rows = await this.em.execute<PostgresRow<WagerRecord>[]>('select * from wager_transactions where idempotency_key=? or (provider_id=? and external_transaction_id=?)', [key, provider, external]);
    return rows.map(wagerDomain);
  }
  async insertWager(tx: WagerTransaction): Promise<void> { await this.insert('wager_transactions', wagerRecord(tx)); }
  async isReversed(id: string): Promise<boolean> {
    const rows = await this.em.execute<{ id: string }[]>("select id from wager_transactions where reference_transaction_id=? and status='PROCESSED' and kind in ('REFUND','ROLLBACK') limit 1", [id]);
    return rows.length > 0;
  }
  async appendLedger(entry: WalletLedgerEntry): Promise<void> { await this.insert('wallet_ledger_entries', ledgerRecord(entry)); }
  async enqueue(message: OutboxMessage): Promise<void> {
    const record = outboxRecord(message);
    await this.insert('outbox_messages', { ...record, payload: JSON.stringify(record.payload) });
  }
  async claimInbox(message: InboxMessage): Promise<{ inserted: boolean; message: InboxMessage }> {
    const params = [message.consumerName, message.messageId, message.payloadHash, message.receivedAt];
    const rows = await this.em.execute<PostgresRow<InboxRecord>[]>('insert into inbox_messages (consumer_name,message_id,payload_hash,received_at) values (?,?,?,?) on conflict (consumer_name,message_id) do nothing returning *', params);
    if (rows[0]) return { inserted: true, message: inboxDomain(rows[0]) };
    // A new READ COMMITTED statement sees a winner committed while INSERT waited.
    const existing = await this.em.execute<PostgresRow<InboxRecord>[]>('select * from inbox_messages where consumer_name=? and message_id=?', params.slice(0, 2));
    if (!existing[0]) throw new PersistenceInvariantError('Inbox collision winner is missing');
    return { inserted: false, message: inboxDomain(existing[0]) };
  }
  async finishInbox(message: InboxMessage): Promise<void> {
    if (!message.processedAt) throw new PersistenceInvariantError('Inbox must be processed before persistence');
    const rows = await this.em.execute<{ message_id: string }[]>('update inbox_messages set processed_at=? where consumer_name=? and message_id=? and payload_hash=? and processed_at is null returning message_id', [message.processedAt, message.consumerName, message.messageId, message.payloadHash]);
    if (rows.length !== 1) throw new PersistenceInvariantError('Inbox completion did not affect one row');
  }
  async findDuePendingWagers(now: Date, limit: number): Promise<WagerTransaction[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new InvalidDomainInputError('Candidate limit must be 1..1000');
    const at = dateCopy(now);
    // Discovery never locks a wager before its Wallet. Expiration is independently due.
    const rows = await this.em.execute<PostgresRow<WagerRecord>[]>(`select t.* from wager_transactions t
      where t.status='PENDING_REFERENCE' and (t.next_retry_at<=? or t.expires_at<=?)
      order by case when exists (select 1 from wager_transactions r where r.provider_id=t.provider_id
        and r.external_transaction_id=t.reference_external_transaction_id and r.status='PROCESSED') then 0 else 1 end,
        t.next_retry_at,t.id limit ?`, [at, at, limit]);
    return rows.map(wagerDomain);
  }
  async updatePendingWager(tx: WagerTransaction): Promise<boolean> {
    if (!['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'].includes(tx.status)) {
      throw new InvalidDomainInputError('Invalid worker wager transition');
    }
    const r = wagerRecord(tx);
    // No identity/payload/created_at fields are mutable. Caller holds Wallet -> Wager locks.
    const rows = await this.em.execute<{ id: string }[]>(`update wager_transactions set
      status=?,reference_transaction_id=?,failure_code=?,recorded_balance_amount=?,recorded_balance_currency=?,
      attempts=?,next_retry_at=?,expires_at=?,processed_at=? where id=? and status='PENDING_REFERENCE' returning id`,
      [r.status, r.reference_transaction_id, r.failure_code, r.recorded_balance_amount, r.recorded_balance_currency,
        r.attempts, r.next_retry_at, r.expires_at, r.processed_at, r.id]);
    return rows.length === 1;
  }
  async claimNextOutbox(workerId: string, leaseToken: string, now: Date, leaseUntil: Date, retry?: RetryPolicy) {
    requireText(workerId, 'workerId');
    const token = internalId(leaseToken); const at = dateCopy(now); const until = dateCopy(leaseUntil);
    if (until.getTime() <= at.getTime()) throw new InvalidDomainInputError('Lease must expire after claim time');
    const rows = await this.em.execute<PostgresRow<OutboxRecord>[]>(`with candidate as (
      select id from outbox_messages where published_at is null and next_attempt_at<=?
        and (lease_until is null or lease_until<=?)
      order by next_attempt_at,occurred_at,id limit 1 for update skip locked
    ) update outbox_messages o set lease_owner=?,lease_token=?,lease_until=?
      from candidate c where o.id=c.id returning o.*`, [at, at, workerId, token, until]);
    const row = rows[0];
    return row ? { message: outboxDomain(row, retry), workerId, leaseToken: token, leaseUntil: until } : undefined;
  }
  async completeOutbox(id: string, workerId: string, leaseToken: string, publishedAt: Date): Promise<boolean> {
    requireText(workerId, 'workerId');
    const at = dateCopy(publishedAt);
    const rows = await this.em.execute<{ id: string }[]>(`update outbox_messages
      set published_at=?,lease_owner=null,lease_token=null,lease_until=null,last_error=null
      where id=? and published_at is null and lease_owner=? and lease_token=? and lease_until>? returning id`,
      [at, internalId(id), workerId, internalId(leaseToken), at]);
    return rows.length === 1;
  }
  async failOutbox(message: OutboxMessage, workerId: string, leaseToken: string, now: Date, lastError: string): Promise<boolean> {
    requireText(workerId, 'workerId');
    const at = dateCopy(now);
    if (!message.isPending() || message.attempts < 1 || message.nextAttemptAt.getTime() <= at.getTime()) {
      throw new InvalidDomainInputError('Outbox retry must already be scheduled');
    }
    if (!/^[A-Z0-9_.:-]{1,128}$/.test(lastError)) throw new InvalidDomainInputError('Expected safe diagnostic code');
    const rows = await this.em.execute<{ id: string }[]>(`update outbox_messages
      set attempts=?,next_attempt_at=?,last_error=?,lease_owner=null,lease_token=null,lease_until=null
      where id=? and published_at is null and lease_owner=? and lease_token=? and lease_until>?
        and attempts=? returning id`,
      [message.attempts, message.nextAttemptAt, lastError, internalId(message.id), workerId, internalId(leaseToken), at, message.attempts - 1]);
    return rows.length === 1;
  }
  async ledgerPage(walletId: string, limit: number, before?: LedgerPosition) {
    const rows = await this.em.execute<(PostgresRow<LedgerRecord> & { cursor_time: string })[]>(`select *,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time from wallet_ledger_entries where wallet_id=? ${before ? 'and (created_at,id)<(?::timestamptz,?::uuid)' : ''} order by created_at desc,id desc limit ?`, [walletId, ...(before ? [before.createdAt, before.id] : []), limit]);
    return rows.map(row => ({ entry: ledgerDomain(row), position: { createdAt: row.cursor_time, id: row.id } }));
  }
  async ledgerTotal(walletId: string): Promise<{ amount: string; count: number }> {
    const rows = await this.em.execute<{ amount: string; count: string }[]>("select coalesce(sum(case when direction='CREDIT' then amount else -amount end),0)::numeric(18,2)::text as amount,count(*)::text as count from wallet_ledger_entries where wallet_id=?", [walletId]);
    if (!rows[0]) throw new PersistenceInvariantError('Ledger aggregate is missing');
    const count = Number(rows[0].count); // Entry count, never monetary arithmetic.
    if (!Number.isSafeInteger(count)) throw new PersistenceInvariantError('Ledger count overflow');
    return { amount: rows[0].amount, count };
  }
}
