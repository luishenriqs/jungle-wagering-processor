import { operationalEmitter, type OperationalSink } from '../application/operational-logging';

/** The writer's receipt is observed independently of synchronous emission. */
export function structuredLogger(write: (line: string) => unknown): OperationalSink {
  const observed = new WeakSet<object>();
  return operationalEmitter(record => {
    const receipt = write(`${JSON.stringify(record)}\n`);
    if (receipt !== null && (typeof receipt === 'object' || typeof receipt === 'function') && !observed.has(receipt)) {
      observed.add(receipt);
      // Consume rejection (including throwing then getters/methods) without awaiting
      // I/O or keeping the emitter busy. Reused receipts need only one observer.
      void Promise.resolve(receipt).catch(() => {});
    }
    // Return void: operationalEmitter still protects the synchronous writer call,
    // while a later legitimate record need not wait for the previous write.
  });
}

// No application queue, timer, retry or shutdown owner; I/O remains with Bun.
// Bun.write avoids an unhandled Node stream 'error' event on a broken stderr pipe.
export const stderrOperationalLog = structuredLogger(line => Bun.write(Bun.stderr, line));
