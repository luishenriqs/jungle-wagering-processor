import { Money } from '../../../shared/domain/money';
import { CurrencyMismatchError, IdempotencyConflictError, InvalidDomainInputError } from '../../../shared/domain/domain-errors';
import { dateCopy, requireText } from '../../../shared/domain/validation';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { InvalidTransactionStateError, WagerRuleError } from './wager-errors';

export enum WagerTransactionKind { Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK' }
export enum WagerTransactionStatus { Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED' }
export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt: Date;
}
export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly processedAt?: Date | undefined;
  readonly recordedBalance?: Money | undefined;
  readonly attempts?: number | undefined;
  readonly nextRetryAt?: Date | undefined;
  readonly expiresAt?: Date | undefined;
}
export interface PendingReferenceSchedule { readonly nextRetryAt: Date; readonly expiresAt: Date }

export class WagerTransaction {
  #state: WagerTransactionState;
  private constructor(state: WagerTransactionState) {
    this.#state = Object.freeze({ ...state, createdAt: dateCopy(state.createdAt),
      processedAt: state.processedAt && dateCopy(state.processedAt),
      nextRetryAt: state.nextRetryAt && dateCopy(state.nextRetryAt), expiresAt: state.expiresAt && dateCopy(state.expiresAt) });
    Object.freeze(this);
  }
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening || props.providerId === 'SYSTEM') {
      throw new InvalidDomainInputError('OPENING and SYSTEM are internal');
    }
    return WagerTransaction.createPending(props);
  }
  private static createPending(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'] as const) requireText(props[field], field);
    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) throw new InvalidDomainInputError('Expected lowercase SHA-256 payload hash');
    if (!Object.values(WagerTransactionKind).includes(props.kind)) throw new InvalidDomainInputError('Invalid wager kind');
    if (props.money.isNegative() || (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())) {
      throw new InvalidDomainInputError('Amount must be positive, or zero for LOSS');
    }
    const requiresReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if ((props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Loss) && props.referenceExternalTransactionId !== undefined) {
      throw new InvalidDomainInputError('BET and LOSS do not admit references');
    }
    if (requiresReference || props.referenceExternalTransactionId !== undefined) requireText(props.referenceExternalTransactionId ?? '', 'referenceExternalTransactionId');
    if (props.referenceExternalTransactionId === props.externalTransactionId) throw new InvalidDomainInputError('Self reference is invalid');
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending, attempts: 0 });
  }
  static createOpening(props: { id: string; walletId: string; playerId: string; money: Money; payloadHash: string; createdAt: Date }): WagerTransaction {
    const external = `opening:${props.walletId}`;
    const tx = WagerTransaction.createPending({ ...props, providerId: 'SYSTEM', externalTransactionId: external,
      idempotencyKey: `SYSTEM:${external}`, roundId: external, gameId: 'SYSTEM_OPENING', kind: WagerTransactionKind.Opening });
    tx.markProcessed(undefined, props.createdAt, props.money);
    return tx;
  }
  static rehydrate(state: WagerTransactionState): WagerTransaction { return new WagerTransaction(state); }
  get id(): string { return this.#state.id; }
  get providerId(): string { return this.#state.providerId; }
  get externalTransactionId(): string { return this.#state.externalTransactionId; }
  get idempotencyKey(): string { return this.#state.idempotencyKey; }
  get payloadHash(): string { return this.#state.payloadHash; }
  get walletId(): string { return this.#state.walletId; }
  get playerId(): string { return this.#state.playerId; }
  get roundId(): string { return this.#state.roundId; }
  get gameId(): string { return this.#state.gameId; }
  get kind(): WagerTransactionKind { return this.#state.kind; }
  get money(): Money { return this.#state.money; }
  get referenceExternalTransactionId(): string | undefined { return this.#state.referenceExternalTransactionId; }
  get createdAt(): Date { return dateCopy(this.#state.createdAt); }
  get status(): WagerTransactionStatus { return this.#state.status; }
  get referenceTransactionId(): string | undefined { return this.#state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.#state.failureCode; }
  get processedAt(): Date | undefined { return this.#state.processedAt && dateCopy(this.#state.processedAt); }
  get recordedBalance(): Money | undefined { return this.#state.recordedBalance; }
  get attempts(): number { return this.#state.attempts ?? 0; }
  get nextRetryAt(): Date | undefined { return this.#state.nextRetryAt && dateCopy(this.#state.nextRetryAt); }
  get expiresAt(): Date | undefined { return this.#state.expiresAt && dateCopy(this.#state.expiresAt); }

  markProcessed(referenceTransactionId: string | undefined, at: Date, balance: Money): void {
    this.assertMutable();
    this.assertBalance(balance);
    const processedAt = dateCopy(at);
    if (this.expectsReference()) requireText(referenceTransactionId ?? '', 'referenceTransactionId');
    if (!this.expectsReference() && referenceTransactionId !== undefined) throw new InvalidDomainInputError('Unexpected internal reference');
    if (referenceTransactionId !== undefined) requireText(referenceTransactionId, 'referenceTransactionId');
    this.#state = Object.freeze({ ...this.#state, status: WagerTransactionStatus.Processed, referenceTransactionId,
      processedAt, recordedBalance: balance, nextRetryAt: undefined, expiresAt: undefined });
  }
  markPendingReference(balance: Money, schedule: PendingReferenceSchedule): void {
    this.assertMutable();
    if (this.status !== WagerTransactionStatus.Pending || !this.expectsReference()) throw new InvalidTransactionStateError('Only pending dependent transactions can wait for a reference');
    this.assertBalance(balance);
    const nextRetryAt = dateCopy(schedule.nextRetryAt);
    const expiresAt = dateCopy(schedule.expiresAt);
    if (expiresAt.getTime() <= nextRetryAt.getTime()) throw new InvalidDomainInputError('Reference deadline must follow retry time');
    this.#state = Object.freeze({ ...this.#state, status: WagerTransactionStatus.PendingReference, recordedBalance: balance, nextRetryAt, expiresAt });
  }
  reject(code: FailureCode, balance: Money): void {
    this.assertMutable();
    this.assertCode(code);
    // A currency rejection records the wallet's observed balance, not the invalid operation currency.
    if (code === FailureCode.CurrencyMismatch) {
      if (balance.isNegative()) throw new InvalidDomainInputError('Snapshot balance cannot be negative');
    } else this.assertBalance(balance);
    this.#state = Object.freeze({ ...this.#state, status: WagerTransactionStatus.Rejected, failureCode: code,
      recordedBalance: balance, nextRetryAt: undefined, expiresAt: undefined });
  }
  reschedulePendingReference(next: Date): void {
    this.assertMutable();
    if (this.status !== WagerTransactionStatus.PendingReference || !this.#state.nextRetryAt || !this.#state.expiresAt) {
      throw new InvalidTransactionStateError('Only PENDING_REFERENCE can be rescheduled');
    }
    const nextRetryAt = dateCopy(next);
    if (nextRetryAt.getTime() <= this.#state.nextRetryAt.getTime() || nextRetryAt.getTime() >= this.#state.expiresAt.getTime()
      || this.attempts >= 2147483647) throw new InvalidDomainInputError('Invalid retry schedule or attempts overflow');
    this.#state = Object.freeze({ ...this.#state, attempts: this.attempts + 1, nextRetryAt });
  }
  fail(code: FailureCode, balance?: Money): void {
    this.assertMutable();
    this.assertCode(code);
    if (balance) this.assertBalance(balance);
    this.#state = Object.freeze({ ...this.#state, status: WagerTransactionStatus.Failed, failureCode: code,
      recordedBalance: balance ?? this.#state.recordedBalance, nextRetryAt: undefined, expiresAt: undefined });
  }
  isTerminal(): boolean { return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(this.status); }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  expectsReference(): boolean { return this.requiresReference() || (this.kind === WagerTransactionKind.Win && this.referenceExternalTransactionId !== undefined); }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  assertReplay(identity: Pick<CreateWagerTransactionProps, 'providerId' | 'externalTransactionId' | 'idempotencyKey' | 'payloadHash'>): void {
    if (identity.providerId !== this.providerId || identity.externalTransactionId !== this.externalTransactionId
      || identity.idempotencyKey !== this.idempotencyKey || !this.matchesPayload(identity.payloadHash)) {
      throw new IdempotencyConflictError('Wager identity or payload conflicts');
    }
  }
  /** Pure validation; the caller must load the reference and reversal fact under the future DB lock. */
  referenceFailure(reference: WagerTransaction, alreadyReversed: boolean): FailureCode | undefined {
    if (reference.providerId !== this.providerId || reference.playerId !== this.playerId || reference.walletId !== this.walletId
      || reference.roundId !== this.roundId || reference.externalTransactionId !== this.referenceExternalTransactionId) return FailureCode.ReferenceContextMismatch;
    if (reference.money.currency !== this.money.currency) return FailureCode.CurrencyMismatch;
    const allowed = this.kind === WagerTransactionKind.Rollback
      ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund] : [WagerTransactionKind.Bet];
    if (!allowed.includes(reference.kind)) return FailureCode.ReferenceInvalidKind;
    if (reference.isTerminal() && reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    if (this.requiresReference() && !reference.money.equals(this.money)) return FailureCode.ReferenceAmountMismatch;
    if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    return undefined;
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    if (this.kind === WagerTransactionKind.Loss) return undefined;
    if (this.expectsReference()) {
      if (!reference || reference.status !== WagerTransactionStatus.Processed) throw new WagerRuleError(FailureCode.ReferenceNotProcessed);
      const code = this.referenceFailure(reference, false);
      if (code) throw new WagerRuleError(code);
    }
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.kind === WagerTransactionKind.Rollback && reference?.kind !== WagerTransactionKind.Bet) return LedgerDirection.Debit;
    return LedgerDirection.Credit;
  }
  private assertMutable(): void { if (this.isTerminal()) throw new InvalidTransactionStateError(`Terminal transaction: ${this.status}`); }
  private assertCode(code: FailureCode): void { if (!Object.values(FailureCode).includes(code)) throw new InvalidDomainInputError('Unknown failure code'); }
  private assertBalance(balance: Money): void {
    if (balance.currency !== this.money.currency) throw new CurrencyMismatchError('Snapshot currency mismatch');
    if (balance.isNegative()) throw new InvalidDomainInputError('Snapshot balance cannot be negative');
  }
}
