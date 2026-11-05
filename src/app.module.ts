import { Module, type DynamicModule } from '@nestjs/common';
import { WalletsModule } from './modules/wallets/wallets.module';
import type { FinancialUnitOfWork } from './shared/application/financial-store';

// Separate root avoids merging the default production imports into an explicit test composition.
@Module({})
class RegisteredHttpApplication {}

@Module({ imports: [WalletsModule.register()] })
export class AppModule {
  static register(options: { uow: FinancialUnitOfWork }): DynamicModule {
    return { module: RegisteredHttpApplication, imports: [WalletsModule.register(options)] };
  }
}
