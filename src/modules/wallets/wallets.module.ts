import { randomUUID } from 'node:crypto';
import { Inject, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, HttpAdapterHost } from '@nestjs/core';
import { DatabaseModule } from '../../database/database.module';
import type { FinancialUnitOfWork } from '../../shared/application/financial-store';
import { HttpExceptionFilter } from '../../shared/infrastructure/http-exception.filter';
import { ProviderIdentityGuard } from '../../shared/infrastructure/provider-identity.guard';
import { WalletsController } from './infrastructure/wallets.controller';

@Module({})
export class WalletsModule {
  constructor(@Inject(HttpAdapterHost) host: HttpAdapterHost) {
    // Registered during DI, before Nest installs the JSON parser, so parse errors are correlated too.
    host.httpAdapter?.use((request: { correlationId: string }, response: { setHeader(name: string, value: string): void }, next: () => void) => {
      request.correlationId = randomUUID();
      response.setHeader('x-correlation-id', request.correlationId);
      next();
    });
  }
  static register(options: { uow?: FinancialUnitOfWork } = {}): DynamicModule {
    return { module: WalletsModule, imports: [DatabaseModule.forHttp(options.uow)], controllers: [WalletsController],
      providers: [ProviderIdentityGuard, { provide: APP_FILTER, useClass: HttpExceptionFilter }] };
  }
}
