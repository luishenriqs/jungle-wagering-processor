import { enableWorkerSignals } from '../src/shared/application/worker-signals';
import { PublisherLifecycle } from '../src/modules/messaging/infrastructure/publisher-lifecycle';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MessagingModule } from '../src/modules/messaging/messaging.module';

try {
  const app = await NestFactory.createApplicationContext(MessagingModule.forPublisher(), { logger: false, abortOnError: false });
  enableWorkerSignals(app, app.get(PublisherLifecycle));
  console.log(JSON.stringify({ component: 'outbox-publisher', action: 'started' }));
} catch {
  console.error(JSON.stringify({ component: 'outbox-publisher', action: 'startup-failed', code: 'CHECK_DATABASE_AND_SQS_CONFIGURATION' }));
  process.exit(1); // Release resources of a partial Nest startup; no successful start is reported.
}
