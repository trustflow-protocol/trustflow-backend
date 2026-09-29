import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationDeduplicationService } from './notification-deduplication.service';

@Module({
  providers: [NotificationService, NotificationDeduplicationService],
  exports: [NotificationService],
})
export class NotificationModule {}
