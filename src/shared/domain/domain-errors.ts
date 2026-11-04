export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class InvalidMoneyError extends DomainError {}
export class MoneyOverflowError extends DomainError {}
export class CurrencyMismatchError extends DomainError {}
export class InvalidDomainInputError extends DomainError {}
export class InvalidLedgerEntryError extends DomainError {}
export class InvalidMessageStateError extends DomainError {}
export class IdempotencyConflictError extends DomainError {}
