export enum FailureCode {
  InsufficientFundsBet = 'INSUFFICIENT_FUNDS_BET',
  InsufficientFundsReversal = 'INSUFFICIENT_FUNDS_REVERSAL',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceNotFoundTimeout = 'REFERENCE_NOT_FOUND_TIMEOUT',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  InfrastructurePermanent = 'INFRASTRUCTURE_PERMANENT',
}
