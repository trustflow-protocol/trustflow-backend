import { Module } from '@nestjs/common';
import { GigController } from './gig.controller';
import { GigService } from './gig.service';
import { GigExpiryWorkerService } from './gig-expiry-worker.service';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [MonitoringModule, OutboxModule],
  controllers: [GigController],
  providers: [GigService, GigExpiryWorkerService],
  exports: [GigService],
})
export class GigModule {}
