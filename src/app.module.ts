import { Module } from '@nestjs/common';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { DatabaseModule } from './database/database.module';

@Module({ imports: [WalletsModule, WageringModule, MessagingModule, ...(process.env['DATABASE_URL'] ? [DatabaseModule.forRoot()] : [])] })
export class AppModule {}
