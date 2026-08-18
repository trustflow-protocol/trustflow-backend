import { Module } from '@nestjs/common';
import { GigController } from './gig.controller';
import { GigService } from './gig.service';
import { GigExpiryWorkerService } from './gig-expiry-worker.service';
import { WebhookModule } from '../webhook/webhook.module';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [WebhookModule, MonitoringModule],
  controllers: [GigController],
  providers: [GigService, GigExpiryWorkerService],
  exports: [GigService],
})
export class GigModule {}
