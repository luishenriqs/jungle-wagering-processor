import type { FinancialUnitOfWork } from '../../../shared/application/financial-store';
import { ConflictError, sqlError } from '../../../shared/application/application-errors';
import { execution, exhausted, isTransient, retryDelay, type ExecutionOptions } from '../../../shared/application/execution';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { requireText } from '../../../shared/domain/validation';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { createWalletOpening } from '../../wagering/domain/wallet-opening';
import { wagerPayloadHash } from '../../wagering/application/wager-payload';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction';

export class CreateWalletUseCase {
  private readonly runtime;
  constructor(private readonly uow: FinancialUnitOfWork, options: ExecutionOptions = {}) { this.runtime = execution(options); }
  async execute(input: { playerId: string; initialBalance: MoneyProps; correlationId: string }) {
    requireText(input.playerId, 'playerId');
    requireText(input.correlationId, 'correlationId');
    const initialBalance = Money.from(input.initialBalance);
    const walletId = this.runtime.newId();
    const bundle = createWalletOpening({ walletId, playerId: input.playerId, initialBalance,
      transactionId: this.runtime.newId(), ledgerEntryId: this.runtime.newId(), processedEventId: this.runtime.newId(), balanceEventId: this.runtime.newId(),
      payloadHash: wagerPayloadHash({ walletId, playerId: input.playerId, providerId: 'SYSTEM', externalTransactionId: `opening:${walletId}`,
        roundId: `opening:${walletId}`, gameId: 'SYSTEM_OPENING', kind: WagerTransactionKind.Opening, money: initialBalance.toJSON() }),
      context: { correlationId: input.correlationId, occurredAt: this.runtime.now() } });
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.uow.run(async store => {
          await store.insertWallet(bundle.wallet);
          await this.runtime.checkpoint('wallet');
          if (bundle.transaction && bundle.entry) {
            await store.insertWager(bundle.transaction); await this.runtime.checkpoint('wager');
            await store.appendLedger(bundle.entry); await this.runtime.checkpoint('ledger');
            for (const event of bundle.events) await store.enqueue(OutboxMessage.enqueue(event));
            await this.runtime.checkpoint('outbox');
          }
          await this.runtime.checkpoint('beforeCommit');
          return bundle.wallet;
        });
      } catch (error) {
        const sql = sqlError(error);
        if (sql.code === '23505' && sql.constraint === 'uq_wallet_player_currency') throw new ConflictError('Wallet already exists for player and currency', { cause: error });
        if (!isTransient(error)) throw error;
        if (attempt + 1 >= this.runtime.maxAttempts) throw exhausted(error);
        await retryDelay(attempt);
      }
    }
  }
}
