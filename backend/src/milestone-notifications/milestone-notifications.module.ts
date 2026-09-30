import { Module } from '@nestjs/common';
import { MilestoneNotificationsGateway } from './milestone-notifications.gateway';
import { EventDedupService } from './event-dedup.service';

@Module({
  providers: [MilestoneNotificationsGateway, EventDedupService],
  exports: [MilestoneNotificationsGateway, EventDedupService],
})
export class MilestoneNotificationsModule {}
