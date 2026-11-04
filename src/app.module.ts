import { Module } from '@nestjs/common';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { MessagingModule } from './modules/messaging/messaging.module';

@Module({ imports: [WalletsModule, WageringModule, MessagingModule] })
export class AppModule {}
