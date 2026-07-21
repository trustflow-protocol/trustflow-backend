import { Module } from '@nestjs/common';
import { DisputeSagaService } from './dispute-saga.service';
import { DisputeSagaController } from './dispute-saga.controller';
import { EscrowModule } from '../escrow/escrow.module';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [EscrowModule, WebhookModule],
  controllers: [DisputeSagaController],
  providers: [DisputeSagaService],
  exports: [DisputeSagaService],
})
export class DisputeModule {}
