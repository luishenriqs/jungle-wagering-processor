/** Fail closed before spawning a production entrypoint or opening its ORM connection. */
export function entrypointIsolation(env: Readonly<Record<string, string | undefined>>) {
  const url = env['DATABASE_URL']; const schema = env['JUNGLE_TEST_SCHEMA'];
  if (env['JUNGLE_ENTRYPOINT_SMOKE'] !== 'yes' || !url || url !== env['TEST_DATABASE_URL']
    || !schema || !/^jungle_it_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid entrypoint test isolation');
  const db = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.pathname !== '/jungle_test'
    || !['127.0.0.1', 'localhost'].includes(db.hostname) || db.search || db.hash) throw new Error('Invalid isolated test database');
  for (const [key, suffix] of [['SQS_INPUT_QUEUE_NAME', 'input'], ['SQS_DLQ_QUEUE_NAME', 'dlq'], ['SQS_EVENTS_QUEUE_NAME', 'events']] as const) {
    if (!new RegExp(`^jungle_it_[a-f0-9]{32}_${suffix}\\.fifo$`).test(env[key] ?? '')) throw new Error('Invalid isolated test queue');
  }
  const endpoint = new URL(env['SQS_ENDPOINT'] ?? '');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Invalid isolated SQS endpoint');
  return { url, schema };
}
