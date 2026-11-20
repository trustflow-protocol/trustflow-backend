import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationReadStateService } from './notification-read-state.service';
import { MilestoneNotificationsModule } from '../milestone-notifications/milestone-notifications.module';

@Module({
  // The gateway pushes `notification:read` to a wallet's other sessions (#943).
  imports: [MilestoneNotificationsModule],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationReadStateService],
  exports: [NotificationService, NotificationReadStateService],
})
export class NotificationModule {}
