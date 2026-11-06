import { createHash } from 'node:crypto';
import { PersistenceInvariantError } from '../../../shared/application/application-errors';
import { WagerTransactionStatus } from '../../wagering/domain/wager-transaction';
import type { ClockPort } from '../../../shared/application/clock';
import type { ProcessWagerTransactionUseCase, ProcessWagerResult } from '../../wagering/application/process-wager-transaction.use-case';
import { consumerRetrySeconds, type ConsumerConfig } from './consumer-config';
import { classifyConsumerError } from './consumer-errors';
import type { ReceivedWagerMessage, SqsConsumerTransport } from './sqs-transport';
import { wagerRequest } from './wager-request';
import { operationalEmitter, type OperationalLoggingOptions } from '../../../shared/application/operational-logging';
import { operationalMetricsEmitter, type OperationalMetricsOptions } from '../../../shared/application/operational-metrics';

export interface ConsumerDiagnostic {
  readonly component: 'sqs-consumer'; readonly action: string; readonly code: string;
  readonly sqsMessageId?: string; readonly receiveCount?: number;
}
export type ConsumerOutcome = { readonly action: 'acked'; readonly result: ProcessWagerResult }
  | { readonly action: 'retry' | 'dead-lettered'; readonly code: string };
export type WagerProcessor = Pick<ProcessWagerTransactionUseCase, 'execute'>;
export class SqsWagerConsumer {
  private readonly observe;
  private readonly emitMetric;
  constructor(private readonly processor: WagerProcessor, private readonly transport: SqsConsumerTransport,
    private readonly clock: ClockPort, private readonly config: ConsumerConfig,
    private readonly diagnose: (event: ConsumerDiagnostic) => void = event => console.log(JSON.stringify(event)),
    options: OperationalLoggingOptions & OperationalMetricsOptions = {}) {
    this.observe = operationalEmitter(options.operationalLog);
    this.emitMetric = operationalMetricsEmitter(options.operationalMetrics);
  }

  async handle(message: ReceivedWagerMessage, stopSignal?: AbortSignal): Promise<ConsumerOutcome> {
    let result: ProcessWagerResult;
    let received = false;
    const context: Record<string, unknown> = { sqsMessageId: message.transportMessageId, receiveCount: message.receiveCount };
    try {
      const input = wagerRequest(message.body, this.config.consumerName, this.clock);
      Object.assign(context, { messageId: input.inbox?.messageId, correlationId: input.correlationId, providerId: input.providerId, walletId: input.walletId });
      this.observe({ component: 'sqs-consumer', event: 'sqs_received', ...context }); received = true;
      // execute resolves only after its PostgreSQL transaction commits (including Inbox/Outbox).
      result = await this.processor.execute(input);
      if (![WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected,
        WagerTransactionStatus.PendingReference, WagerTransactionStatus.Failed].includes(result.status)) {
        throw new PersistenceInvariantError('Unexpected uncommitted processing status');
      }
    } catch (error) {
      if (!received) this.observe({ component: 'sqs-consumer', event: 'sqs_received', ...context });
      const failure = classifyConsumerError(error);
      if (failure.kind === 'permanent') {
        return this.toDlq(message, failure.code, stopSignal, context);
      }
      // Unknown failures may precede any durable financial record. Native redrive preserves
      // the original envelope; a diagnostic-only manual DLQ followed by delete would lose it.
      return this.defer(message, failure.code, stopSignal, context); // RedrivePolicy bounds both transient and unknown deliveries.
    }
    context['transactionId'] = result.transactionId;
    context['idempotentReplay'] = result.idempotentReplay;
    try {
      await this.transport.acknowledge(message.receiptHandle);
      this.observe({ component: 'sqs-consumer', event: 'sqs_acked', ...context });
      return { action: 'acked', result };
    } catch {
      // The financial commit is already durable. Redelivery must replay; never DLQ the operation here.
      this.observe({ component: 'sqs-consumer', event: 'sqs_ack_failed', code: 'ACK_FAILED', level: 'warn', ...context });
      return this.defer(message, 'ACK_FAILED', stopSignal, context);
    }
  }
  async pollOnce(signal?: AbortSignal): Promise<ConsumerOutcome | undefined> {
    const message = await this.transport.receive(signal);
    if (!message) return undefined;
    if (signal?.aborted) {
      try { await this.transport.retry(message.receiptHandle, 0); } catch { this.log('release-failed', 'VISIBILITY_FAILED', message); }
      return { action: 'retry', code: 'POLL_CANCELLED' };
    }
    return this.handle(message, signal);
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.pollOnce(signal); }
      catch {
        if (signal.aborted) break;
        this.log('poll-retry', 'RECEIVE_FAILED');
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, this.config.retryBaseSeconds * 1000);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
  }
  private async defer(message: ReceivedWagerMessage, code: string, stopSignal?: AbortSignal, context: Record<string, unknown> = {}): Promise<ConsumerOutcome> {
    this.log('retry', code, message);
    try {
      await this.transport.retry(message.receiptHandle, stopSignal?.aborted ? 0 : consumerRetrySeconds(message.receiveCount, this.config));
      this.observe({ component: 'sqs-consumer', event: 'sqs_retry_scheduled', code, level: 'warn', ...context });
      this.emitMetric({ type: 'retry-scheduled', target: 'sqsConsumer' });
    }
    catch { this.log('retry', 'VISIBILITY_FAILED', message); } // Original timeout/redrive remains effective.
    return { action: 'retry', code };
  }
  private async toDlq(message: ReceivedWagerMessage, code: string, stopSignal?: AbortSignal, context: Record<string, unknown> = {}): Promise<ConsumerOutcome> {
    const bodyHash = createHash('sha256').update(message.body).digest('hex');
    const deduplicationId = createHash('sha256').update(`wager-dlq:v1\0${message.transportMessageId}\0${bodyHash}`).digest('hex');
    // Intentionally no original body, raw exception, receipt or credentials in diagnostics/DLQ metadata.
    const body = JSON.stringify({ type: 'WagerTransactionDeadLetter', version: 1, sourceMessageId: message.transportMessageId,
      bodyHash, errorCode: code, receiveCount: message.receiveCount, occurredAt: this.clock.now().toISOString() });
    try { await this.transport.deadLetter(body, `dlq-${deduplicationId.slice(0, 32)}`, deduplicationId); }
    catch { return this.defer(message, 'DLQ_SEND_FAILED', stopSignal, context); } // Never delete on unconfirmed SendMessage.
    try { await this.transport.acknowledge(message.receiptHandle); }
    catch { return this.defer(message, 'DLQ_ACK_FAILED', stopSignal, context); }
    this.log('dead-lettered', code, message);
    this.observe({ component: 'sqs-consumer', event: 'sqs_dead_lettered', code, level: 'warn', ...context });
    this.emitMetric({ type: 'dlq-transfer-confirmed' });
    return { action: 'dead-lettered', code };
  }
  private log(action: string, code: string, message?: ReceivedWagerMessage): void {
    // Logging failure cannot change commit/ACK/DLQ semantics.
    try { this.diagnose({ component: 'sqs-consumer', action, code,
      ...(message ? { sqsMessageId: message.transportMessageId, receiveCount: message.receiveCount } : {}) }); } catch { /* diagnostic only */ }
  }
}
