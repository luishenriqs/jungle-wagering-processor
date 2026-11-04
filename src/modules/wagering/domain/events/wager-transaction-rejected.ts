import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../../../../shared/domain/events/integration-event';
import { InvalidDomainInputError } from '../../../../shared/domain/domain-errors';
import type { FailureCode } from '../failure-code';
import { WagerTransactionStatus, type WagerTransaction } from '../wager-transaction';
import { wagerEventData, type WagerEventData } from './wager-event-data';

export interface WagerTransactionRejectedData extends WagerEventData { readonly failureCode: FailureCode }
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new InvalidDomainInputError('Rejected event requires failureCode');
    return new WagerTransactionRejected({ ...ctx, aggregateId: tx.walletId,
      data: { ...wagerEventData(tx, WagerTransactionStatus.Rejected), failureCode: tx.failureCode } });
  }
}
