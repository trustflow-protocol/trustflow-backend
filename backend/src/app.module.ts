import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { EscrowModule } from './escrow/escrow.module';
import { WebhookModule } from './webhook/webhook.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { StellarModule } from './stellar/stellar.module';

@Module({
  imports: [AuthModule, EscrowModule, WebhookModule, MonitoringModule, StellarModule],
})
export class AppModule {}
