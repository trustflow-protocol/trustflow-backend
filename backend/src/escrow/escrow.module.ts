import { Module } from '@nestjs/common';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { WebhookModule } from '../webhook/webhook.module';
import { ReputationModule } from '../reputation/reputation.module';
import { EscrowWriteModule } from '../escrow-write/escrow-write.module';

@Module({
  imports: [WebhookModule, ReputationModule, EscrowWriteModule],
  controllers: [EscrowController],
  providers: [EscrowService],
  exports: [EscrowService],
})
export class EscrowModule {}
