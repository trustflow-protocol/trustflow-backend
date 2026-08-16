import { Module } from '@nestjs/common';
import { GigController } from './gig.controller';
import { GigService } from './gig.service';
import { GigExpiryWorkerService } from './gig-expiry-worker.service';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [WebhookModule],
  controllers: [GigController],
  providers: [GigService, GigExpiryWorkerService],
  exports: [GigService],
})
export class GigModule {}
