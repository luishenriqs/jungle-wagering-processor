import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../../../../shared/domain/events/integration-event';
import { WagerTransactionStatus, type WagerTransaction } from '../wager-transaction';
import { wagerEventData, type WagerEventData } from './wager-event-data';

export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerEventData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.walletId, data: wagerEventData(tx, WagerTransactionStatus.Processed) });
  }
}
