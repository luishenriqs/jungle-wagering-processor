import { SQSClient } from '@aws-sdk/client-sqs';
/** This package targets LocalStack only; never forward local test credentials to an external service. */
export function localSqsClient(env: Readonly<Record<string, string | undefined>> = process.env): SQSClient {
  const endpoint = new URL(env['SQS_ENDPOINT'] ?? 'http://127.0.0.1:4566');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'localstack'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Invalid LocalStack SQS endpoint');
  }
  return new SQSClient({ endpoint: endpoint.href, region: env['AWS_REGION'] ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1, useQueueUrlAsEndpoint: false });
}
