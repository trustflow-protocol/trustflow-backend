import { Module } from '@nestjs/common';
import { DisputeSagaService } from './dispute-saga.service';
import { DisputeSagaController } from './dispute-saga.controller';
import { EscrowModule } from '../escrow/escrow.module';
import { WebhookModule } from '../webhook/webhook.module';
import { ReputationModule } from '../reputation/reputation.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [EscrowModule, WebhookModule, ReputationModule, NotificationModule],
  controllers: [DisputeSagaController],
  providers: [DisputeSagaService],
  exports: [DisputeSagaService],
})
export class DisputeModule {}
