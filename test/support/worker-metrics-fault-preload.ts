import { entrypointIsolation } from './entrypoint-isolation';
entrypointIsolation(process.env);
const mode = process.env['JUNGLE_TEST_METRICS_WRITER_FAULT'];
if (!['throw', 'reject', 'never'].includes(mode ?? '')) throw new Error('Invalid isolated metrics writer fault');
const write = Bun.write;
Bun.write = ((...args: unknown[]) => {
  const data = args[1];
  if (args[0] === Bun.stderr && typeof data === 'string' && data.startsWith('{"type":"OperationalMetricsSnapshot"')) {
    console.log(JSON.stringify({ component: 'entrypoint-test', phase: 'metrics-writer-attempt' }));
    if (mode === 'throw') throw new Error('Controlled D04 writer exception');
    if (mode === 'reject') return Promise.reject(new Error('Controlled D04 writer rejection'));
    return new Promise<number>(() => {});
  }
  return Reflect.apply(write, Bun, args);
}) as typeof write;
