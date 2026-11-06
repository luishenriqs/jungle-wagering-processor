import { Controller, Get, Inject, Module, Query, type DynamicModule } from '@nestjs/common';
import { OPERATIONAL_METRICS, type OperationalMetricsCollector, type OperationalMetricsSnapshot } from '../application/operational-metrics';
import { InvalidDomainInputError } from '../domain/domain-errors';

function noQuery(query: unknown): void {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length !== 0) {
    throw new InvalidDomainInputError('Metrics accepts no query parameters');
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(OPERATIONAL_METRICS) private readonly collector: OperationalMetricsCollector) {}

  @Get()
  snapshot(@Query() query: unknown): OperationalMetricsSnapshot {
    noQuery(query);
    return this.collector.snapshot();
  }
}

@Module({})
export class MetricsHttpModule {
  static register(database: DynamicModule): DynamicModule {
    return { module: MetricsHttpModule, imports: [database], controllers: [MetricsController] };
  }
}
