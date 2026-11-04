import { InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import { InvalidTransactionStateError } from './wager-errors';

export interface WagerEvaluationContext {
  readonly walletId: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly reference?: WagerTransaction;
  readonly referenceAlreadyReversed: boolean;
}
export type WagerDecision = { readonly status: 'PROCESSED'; readonly direction: LedgerDirection | undefined }
  | { readonly status: 'PENDING_REFERENCE' }
  | { readonly status: 'REJECTED'; readonly code: FailureCode };

/** No persistence, caching, state mutation or publication. */
export function evaluateWager(tx: WagerTransaction, context: WagerEvaluationContext): WagerDecision {
  if (tx.isTerminal()) throw new InvalidTransactionStateError('Cannot evaluate a terminal transaction');
  if (context.walletId !== tx.walletId || context.playerId !== tx.playerId || context.balance.isNegative()) throw new InvalidDomainInputError('Invalid wallet context');
  const reject = (code: FailureCode): WagerDecision => ({ status: 'REJECTED', code });
  if (context.balance.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch);
  if (tx.expectsReference()) {
    if (!context.reference) return { status: 'PENDING_REFERENCE' };
    const code = tx.referenceFailure(context.reference, context.referenceAlreadyReversed);
    if (code) return reject(code);
    if (context.reference.status !== WagerTransactionStatus.Processed) return { status: 'PENDING_REFERENCE' };
  }
  const direction = tx.ledgerDirectionFor(context.reference);
  if (direction === LedgerDirection.Debit && context.balance.isLessThan(tx.money)) {
    return reject(tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFundsBet : FailureCode.InsufficientFundsReversal);
  }
  return { status: 'PROCESSED', direction };
}
