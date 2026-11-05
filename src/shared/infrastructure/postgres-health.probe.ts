import type { MikroORM } from '@mikro-orm/postgresql';
import { readinessTimeoutMs } from './health-readiness';

export const POSTGRES_HEALTH_PROBE = Symbol('POSTGRES_HEALTH_PROBE');
interface ProbeConnection {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  __knex__disposed?: unknown;
}
interface Acquisition { promise: Promise<ProbeConnection>; abort(): void }
interface ProbeClient {
  pool: { acquire(): Acquisition; numPendingCreates(): number; numPendingValidations(): number };
  releaseConnection(connection: ProbeConnection): Promise<void>;
}
/** Restricted Knex/Tarn bridge. No UoW reflection, pool creation or global setting changes.
 * Knex acquireConnection hides Tarn's abort handle; query timeout excludes pool wait.
 * Keeping that handle here permits cancelling only this probe's pending acquisition.
 */
export class PostgresHealthProbe {
  private readonly timeout: number;
  constructor(private readonly orm: MikroORM) { this.timeout = readinessTimeoutMs(); }
  async check(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Health cancelled');
    const deadline = performance.now() + this.timeout;
    const client = this.orm.em.getConnection().getKnex().client as unknown as ProbeClient;
    const acquire = client.pool.acquire();
    const abortAcquire = () => acquire.abort();
    signal.addEventListener('abort', abortAcquire, { once: true });
    if (signal.aborted) acquire.abort();
    let connection: ProbeConnection | undefined;
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reusable = false;
    try {
      connection = await acquire.promise;
      signal.removeEventListener('abort', abortAcquire);
      if (signal.aborted || performance.now() >= deadline) { reusable = true; throw new Error('Health cancelled'); }
      const borrowed = connection;
      // Fallback for a dead transport, not a claim of immediate server cancellation.
      // Keep ownership until query rejection and socket close have actually settled.
      timer = setTimeout(() => {
        borrowed.__knex__disposed = 'Health connection expired';
        closing = borrowed.end();
        void closing.catch(() => {});
      }, Math.max(1, deadline - performance.now()) + 250);
      // Technical read-only transaction only. Server statement timeout is set with
      // margin inside the HTTP budget; ROLLBACK restores session settings.
      await borrowed.query('BEGIN READ ONLY');
      const sqlBudget = Math.max(1, Math.floor(deadline - performance.now() - 50));
      await borrowed.query(`SET LOCAL statement_timeout='${sqlBudget}ms'`);
      await borrowed.query(`SET LOCAL lock_timeout='${sqlBudget}ms'`);
      if (signal.aborted) throw new Error('Health cancelled');
      const result = await borrowed.query('SELECT 1 AS healthy');
      if (result.rows[0]?.['healthy'] !== 1) throw new Error('Invalid health result');
      await borrowed.query('ROLLBACK');
      reusable = true;
      if (signal.aborted) throw new Error('Health cancelled');
    } finally {
      signal.removeEventListener('abort', abortAcquire);
      if (timer) clearTimeout(timer);
      if (connection) {
        try {
          if (!reusable || closing) {
            connection.__knex__disposed = 'Health connection discarded';
            await (closing ?? connection.end());
          }
        } finally { await client.releaseConnection(connection); }
      } else {
        // Aborting an acquire does not cancel Tarn's connection creation/validation.
        // Conservatively retain ownership until those pool operations settle; the
        // existing driver connectionTimeoutMillis bounds connection establishment.
        while (client.pool.numPendingCreates() || client.pool.numPendingValidations()) {
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
      }
    }
  }
}
