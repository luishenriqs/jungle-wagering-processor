import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

/** Read-only CP-01 check. Synthetic credentials are valid only for local emulation. */
async function checkQueues(): Promise<void> {
  const endpoint = new URL(process.env['SQS_ENDPOINT'] ?? 'http://127.0.0.1:4566');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'localstack'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('InvalidLocalStackEndpoint');
  }
  const count = process.env['SQS_MAX_RECEIVE_COUNT'] ?? '5';
  if (!/^[1-9][0-9]*$/.test(count) || Number(count) > 1000) throw new Error('InvalidMaxReceiveCount');
  const client = new SQSClient({ endpoint: endpoint.href, region: process.env['AWS_REGION'] ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1, useQueueUrlAsEndpoint: false });
  const names = ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wagering-events.fifo'] as const;
  try {
    const readQueue = async (name: string) => {
      const queue = await client.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal: AbortSignal.timeout(5000) });
      if (!queue.QueueUrl) throw new Error('MissingQueueUrl');
      const result = await client.send(new GetQueueAttributesCommand({ QueueUrl: queue.QueueUrl,
        AttributeNames: ['QueueArn', 'FifoQueue', 'ContentBasedDeduplication', 'RedrivePolicy'] }), { abortSignal: AbortSignal.timeout(5000) });
      const attrs = result.Attributes;
      if (!attrs?.QueueArn || attrs.FifoQueue !== 'true' || attrs.ContentBasedDeduplication !== 'false') {
        throw new Error('InvalidFifoQueueAttributes');
      }
      return attrs;
    };
    // Sequential reads keep failures and diagnostics bounded to the first missing queue.
    const input = await readQueue(names[0]);
    const dlq = await readQueue(names[1]);
    await readQueue(names[2]);
    const raw: unknown = JSON.parse(input.RedrivePolicy ?? 'null');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MissingRedrivePolicy');
    const policy = raw as Record<string, unknown>;
    if (policy['deadLetterTargetArn'] !== dlq.QueueArn || Number(policy['maxReceiveCount']) !== Number(count)) {
      throw new Error('InvalidRedrivePolicy');
    }
    for (const name of names) console.log(`CP-01 queue verified: ${name} (FIFO, explicit deduplication)`);
    console.log(`CP-01 SQS OK: input redrive targets the verified DLQ; maxReceiveCount=${Number(count)}`);
  } finally { client.destroy(); }
}

try { await checkQueues(); }
catch (error) {
  const candidate = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const code = typeof candidate === 'string' && /^[A-Z0-9_]+$/.test(candidate) ? candidate : 'QUEUE_VERIFICATION_FAILED';
  // No raw error, endpoint, credential or payload is printed.
  console.error(`CP-01 SQS check failed: ${code}. Queue existence/attributes were not confirmed.`);
  process.exitCode = 1;
}
