import { Module, type DynamicModule } from '@nestjs/common';
import { ProviderIdentityGuard } from '../../shared/infrastructure/provider-identity.guard';
import { WalletsController } from './infrastructure/wallets.controller';

@Module({})
export class WalletsModule {
  static register(database: DynamicModule): DynamicModule {
    return { module: WalletsModule, imports: [database], controllers: [WalletsController], providers: [ProviderIdentityGuard] };
  }
}
