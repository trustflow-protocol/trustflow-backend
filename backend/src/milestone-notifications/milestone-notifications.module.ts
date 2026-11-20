import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MilestoneNotificationsGateway } from './milestone-notifications.gateway';
import { EventDedupService } from './event-dedup.service';

@Module({
  // Unconfigured on purpose, as in RateLimitModule: the gateway passes the secret on each verify,
  // so it accepts the previous secret during a rotation and reads no config at import time.
  imports: [JwtModule],
  providers: [MilestoneNotificationsGateway, EventDedupService],
  exports: [MilestoneNotificationsGateway, EventDedupService],
})
export class MilestoneNotificationsModule {}
