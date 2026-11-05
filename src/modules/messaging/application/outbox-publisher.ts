import { randomUUID } from 'node:crypto';
import type { FinancialUnitOfWork } from '../../../shared/application/financial-store';
import type { ClockPort } from '../../../shared/application/clock';
import { internalId } from '../../../shared/application/identifiers';
import { dateCopy, requireText } from '../../../shared/domain/validation';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WorkerConfig } from './worker-config';

export interface OutboxTransport { publish(message: OutboxMessage, signal: AbortSignal): Promise<void> }
export interface PublisherDiagnostic {
  readonly component: 'outbox-publisher'; readonly action: string; readonly code: string; readonly eventId?: string;
}
export interface PublisherOptions {
  readonly workerId: string;
  readonly newToken?: () => string;
  readonly diagnose?: (event: PublisherDiagnostic) => void;
}
export type PublishOutcome = { readonly action: 'idle' }
  | { readonly action: 'published' | 'retry-scheduled' | 'lease-lost' | 'confirmation-pending' | 'retry-pending'; readonly eventId: string };

export class OutboxPublisher {
  private readonly config: WorkerConfig;
  private readonly workerId: string;
  private readonly newToken: () => string;
  private readonly diagnose: (event: PublisherDiagnostic) => void;
  constructor(private readonly uow: FinancialUnitOfWork, private readonly transport: OutboxTransport,
    private readonly clock: ClockPort, config: WorkerConfig, options: PublisherOptions) {
    requireText(options.workerId, 'workerId');
    for (const key of ['outboxLeaseMs', 'sqsSendTimeoutMs', 'outboxBaseRetryMs', 'outboxMaxRetryMs'] as const) {
      if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 2147483647) throw new Error(`Invalid ${key}`);
    }
    if (config.outboxLeaseMs < config.sqsSendTimeoutMs + 1000 || config.outboxMaxRetryMs < config.outboxBaseRetryMs) throw new Error('Unsafe publisher timing configuration');
    this.config = Object.freeze({ ...config }); this.workerId = options.workerId;
    this.newToken = options.newToken ?? randomUUID;
    this.diagnose = options.diagnose ?? (event => console.log(JSON.stringify(event)));
  }
  async publishNext(): Promise<PublishOutcome> {
    const now = dateCopy(this.clock.now());
    const leaseUntil = dateCopy(new Date(now.getTime() + this.config.outboxLeaseMs));
    const claim = await this.uow.run(store => store.claimNextOutbox(this.workerId, internalId(this.newToken()), now, leaseUntil,
      { baseDelayMs: this.config.outboxBaseRetryMs, maxDelayMs: this.config.outboxMaxRetryMs }));
    if (!claim) return { action: 'idle' };
    const eventId = claim.message.id;
    // The claim transaction is committed. Never hold its locks while talking to SQS.
    if (claim.leaseUntil.getTime() - dateCopy(this.clock.now()).getTime() < this.config.sqsSendTimeoutMs + 1000) {
      this.log('lease-lost', 'INSUFFICIENT_LEASE_TIME', eventId); return { action: 'lease-lost', eventId };
    }
    try { await this.send(claim.message); }
    catch (error) {
      const at = dateCopy(this.clock.now());
      const code = error instanceof Error && ['AbortError', 'TimeoutError', 'OutboxSendTimeout'].includes(error.name)
        ? 'SQS_SEND_TIMEOUT' : 'SQS_SEND_FAILED';
      claim.message.scheduleRetry(at);
      try {
        const updated = await this.uow.run(store => store.failOutbox(claim.message, claim.workerId, claim.leaseToken, at, code));
        this.log(updated ? 'retry-scheduled' : 'lease-lost', code, eventId);
        return { action: updated ? 'retry-scheduled' : 'lease-lost', eventId };
      } catch {
        // DB recovery and lease expiration will make the event claimable again. Never discard it.
        this.log('retry-pending', 'RETRY_PERSIST_FAILED', eventId); return { action: 'retry-pending', eventId };
      }
    }
    // Deliberately separate from send catch: uncertain SQL confirmation must not be treated as a failed SQS send.
    try {
      const completed = await this.uow.run(store => store.completeOutbox(eventId, claim.workerId, claim.leaseToken, dateCopy(this.clock.now())));
      this.log(completed ? 'published' : 'lease-lost', completed ? 'PUBLISHED' : 'FENCED', eventId);
      return { action: completed ? 'published' : 'lease-lost', eventId };
    } catch {
      this.log('confirmation-pending', 'CONFIRMATION_PERSIST_FAILED', eventId);
      return { action: 'confirmation-pending', eventId };
    }
  }
  async run(signal: AbortSignal, pollMs = 250): Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60000) throw new Error('Invalid Outbox poll interval');
    while (!signal.aborted) {
      let pause = true;
      try { pause = (await this.publishNext()).action !== 'published'; }
      catch { this.log('retry', 'CLAIM_FAILED'); }
      if (pause && !signal.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, pollMs); signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  private async send(message: OutboxMessage): Promise<void> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Outbox send timed out'); error.name = 'OutboxSendTimeout';
        controller.abort(); reject(error);
      }, this.config.sqsSendTimeoutMs);
    });
    try { await Promise.race([this.transport.publish(message, controller.signal), timeout]); }
    finally { clearTimeout(timer); }
  }
  private log(action: string, code: string, eventId?: string): void {
    try { this.diagnose({ component: 'outbox-publisher', action, code, ...(eventId ? { eventId } : {}) }); } catch { /* diagnostic only */ }
  }
}
