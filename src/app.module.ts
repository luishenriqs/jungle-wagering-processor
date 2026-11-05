import { HealthHttpModule } from './shared/infrastructure/health.controller';
import type { HealthOptions } from './shared/infrastructure/health-readiness';
import { randomUUID } from 'node:crypto';
import { Inject, Module } from '@nestjs/common';
import { APP_FILTER, HttpAdapterHost } from '@nestjs/core';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { DatabaseModule } from './database/database.module';
import { HttpExceptionFilter } from './shared/infrastructure/http-exception.filter';
import type { FinancialUnitOfWork } from './shared/application/financial-store';

function httpModules(uow?: FinancialUnitOfWork, health?: HealthOptions) {
  const database = DatabaseModule.forHttp(uow);
  return [WalletsModule.register(database), WageringModule.forHttp(database), HealthHttpModule.register(database, health)];
}
const httpProviders = [{ provide: APP_FILTER, useClass: HttpExceptionFilter }];
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
  static register(options: { uow: FinancialUnitOfWork; health?: HealthOptions }) {
    return { module: RegisteredHttpApplication, imports: httpModules(options.uow, options.health) };
  }
}
