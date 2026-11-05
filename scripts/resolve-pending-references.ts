import { enableWorkerSignals } from '../src/shared/application/worker-signals';
import { PendingReferenceLifecycle } from '../src/modules/wagering/infrastructure/pending-reference-lifecycle';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WageringModule } from '../src/modules/wagering/wagering.module';

try {
  const app = await NestFactory.createApplicationContext(WageringModule.forPendingReferences(), { logger: false, abortOnError: false });
  enableWorkerSignals(app, app.get(PendingReferenceLifecycle));
  console.log(JSON.stringify({ component: 'pending-reference-worker', action: 'started' }));
} catch {
  console.error(JSON.stringify({ component: 'pending-reference-worker', action: 'startup-failed', code: 'CHECK_DATABASE_AND_PENDING_CONFIGURATION' }));
  process.exit(1);
}
