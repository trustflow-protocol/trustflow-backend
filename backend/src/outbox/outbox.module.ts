import { Module } from '@nestjs/common';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { RedisModule } from '../common/redis/redis.module';
import { WebhookModule } from '../webhook/webhook.module';
import { OutboxController } from './outbox.controller';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

@Module({
  imports: [RedisModule, MonitoringModule, WebhookModule],
  controllers: [OutboxController],
  providers: [OutboxService, OutboxPublisherService, OutboxRelayService],
  exports: [OutboxService],
})
export class OutboxModule {}
