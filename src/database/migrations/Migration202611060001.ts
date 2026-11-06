import { Migration } from '@mikro-orm/migrations';

/** Validate existing rows as well as future writes. Never repair financial history. */
export class Migration202611060001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE wallets ADD CONSTRAINT ck_wallet_all_finite
      CHECK (balance NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
    ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_all_finite
      CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND recorded_balance_amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
    ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ck_ledger_all_finite
      CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND balance_before NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND balance_after NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));`);
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT ck_ledger_all_finite;
    ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_all_finite;
    ALTER TABLE wallets DROP CONSTRAINT ck_wallet_all_finite;`);
  }
}
