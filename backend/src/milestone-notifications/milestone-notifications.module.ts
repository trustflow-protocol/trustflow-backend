import { Module } from '@nestjs/common';
import { MilestoneNotificationsGateway } from './milestone-notifications.gateway';

@Module({
  providers: [MilestoneNotificationsGateway],
  exports: [MilestoneNotificationsGateway],
})
export class MilestoneNotificationsModule {}
