import { Controller, Get, Inject, Module, Query, Res, type DynamicModule } from '@nestjs/common';
import { InvalidDomainInputError } from '../domain/domain-errors';
import { HealthReadiness, type HealthOptions, type HealthProbe } from './health-readiness';
import { POSTGRES_HEALTH_PROBE } from './postgres-health.probe';

function noQuery(query: unknown): void {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length !== 0) {
    throw new InvalidDomainInputError('Health accepts no query parameters');
  }
}
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthReadiness) private readonly readiness: HealthReadiness) {}
  @Get('live')
  live(@Query() query: unknown) { noQuery(query); return { status: 'ok' }; }
  @Get('ready')
  async ready(@Query() query: unknown, @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    noQuery(query);
    const result = this.readiness.current(await this.readiness.check());
    response.status(result.status === 'ready' ? 200 : 503);
    return result;
  }
}
@Module({})
export class HealthHttpModule {
  static register(database: DynamicModule, options?: HealthOptions): DynamicModule {
    return { module: HealthHttpModule, imports: [database], controllers: [HealthController], providers: [
      { provide: HealthReadiness, inject: [POSTGRES_HEALTH_PROBE], useFactory: (postgres: HealthProbe) => new HealthReadiness(postgres, options) },
    ] };
  }
}
