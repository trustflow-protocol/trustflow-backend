import { Module } from '@nestjs/common';
import { EscrowController, JurorController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { EscrowSweepService } from './escrow.sweep.service';
import { DisputeService } from './dispute.service';
import { DeliverableService } from './deliverable.service';
import { EscrowEventsConsumer } from './escrow-events.consumer';
import { WebhookModule } from '../webhook/webhook.module';
import { ReputationModule } from '../reputation/reputation.module';
import { EscrowWriteModule } from '../escrow-write/escrow-write.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [WebhookModule, ReputationModule, EscrowWriteModule, MonitoringModule, OutboxModule],
  controllers: [EscrowController, JurorController],
  providers: [
    EscrowService,
    EscrowSweepService,
    DisputeService,
    DeliverableService,
    EscrowEventsConsumer,
  ],
  exports: [EscrowService, EscrowSweepService, DisputeService, DeliverableService],
})
export class EscrowModule {}
