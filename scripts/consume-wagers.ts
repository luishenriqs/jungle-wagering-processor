import { enableWorkerSignals } from '../src/shared/application/worker-signals';
import { ConsumerLifecycle } from '../src/modules/messaging/infrastructure/consumer-lifecycle';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MessagingModule } from '../src/modules/messaging/messaging.module';

try {
  const app = await NestFactory.createApplicationContext(MessagingModule.forConsumer(), { logger: false, abortOnError: false });
  enableWorkerSignals(app, app.get(ConsumerLifecycle));
  console.log(JSON.stringify({ component: 'sqs-consumer', action: 'started' }));
} catch {
  console.error(JSON.stringify({ component: 'sqs-consumer', action: 'startup-failed', code: 'CHECK_DATABASE_AND_SQS_CONFIGURATION' }));
  // A failed Nest context is not returned to the caller for disposal. Exit closes partial startup resources.
  // No successful startup is reported, and PostgreSQL rolls back any disconnected transaction.
  process.exit(1);
}
