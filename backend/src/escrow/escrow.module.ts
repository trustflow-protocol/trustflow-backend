import { Module } from '@nestjs/common';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [WebhookModule],
  controllers: [EscrowController],
  providers: [EscrowService],
  exports: [EscrowService],
})
export class EscrowModule {}
