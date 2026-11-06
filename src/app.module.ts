import { HealthHttpModule } from './shared/infrastructure/health.controller';
import type { HealthOptions } from './shared/infrastructure/health-readiness';
import { randomUUID } from 'node:crypto';
import { Inject, Module } from '@nestjs/common';
import { APP_FILTER, HttpAdapterHost } from '@nestjs/core';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { DatabaseModule } from './database/database.module';
import { HttpExceptionFilter, HTTP_OPERATIONAL_LOGGING_OPTIONS } from './shared/infrastructure/http-exception.filter';
import type { FinancialUnitOfWork } from './shared/application/financial-store';
import { stderrOperationalLog } from './shared/infrastructure/structured-logger';
import { MetricsHttpModule } from './shared/infrastructure/metrics.controller';
import type { OperationalMetricsCollector } from './shared/application/operational-metrics';

function httpModules(uow?: FinancialUnitOfWork, health?: HealthOptions, metrics?: OperationalMetricsCollector) {
  const database = DatabaseModule.forHttp(uow, { metrics });
  return [WalletsModule.register(database), WageringModule.forHttp(database), HealthHttpModule.register(database, health), MetricsHttpModule.register(database)];
}
const httpProviders = [
  { provide: HTTP_OPERATIONAL_LOGGING_OPTIONS, useValue: { operationalLog: stderrOperationalLog } },
  { provide: APP_FILTER, useClass: HttpExceptionFilter },
];
class HttpFoundation {
  constructor(@Inject(HttpAdapterHost) host: HttpAdapterHost) {
    // Install before Nest's JSON parser so malformed requests are also correlated.
    host.httpAdapter?.use((request: { correlationId: string }, response: { setHeader(name: string, value: string): void }, next: () => void) => {
      request.correlationId = randomUUID();
      response.setHeader('x-correlation-id', request.correlationId);
      next();
    });
  }
}
@Module({ providers: httpProviders })
class RegisteredHttpApplication extends HttpFoundation {}

@Module({ imports: httpModules(), providers: httpProviders })
export class AppModule extends HttpFoundation {
  static register(options: { uow: FinancialUnitOfWork; health?: HealthOptions; readonly metrics?: OperationalMetricsCollector | undefined }) {
    return { module: RegisteredHttpApplication, imports: httpModules(options.uow, options.health, options.metrics) };
  }
}
