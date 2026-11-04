import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../../../../shared/domain/events/integration-event';
import { InvalidDomainInputError } from '../../../../shared/domain/domain-errors';
import { WagerTransactionStatus, type WagerTransaction } from '../wager-transaction';
import { wagerEventData, type WagerEventData } from './wager-event-data';

export interface WagerTransactionPendingReferenceData extends WagerEventData { readonly referenceExternalTransactionId: string }
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId) throw new InvalidDomainInputError('Pending event requires an external reference');
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: tx.walletId,
      data: { ...wagerEventData(tx, WagerTransactionStatus.PendingReference), referenceExternalTransactionId: tx.referenceExternalTransactionId } });
  }
}
