import { DomainError } from '../../../shared/domain/domain-errors';
import { FailureCode } from './failure-code';

export class InvalidTransactionStateError extends DomainError {}
export class WagerRuleError extends DomainError {
  constructor(public readonly code: FailureCode) { super(code); }
}
