import { Module, forwardRef } from '@nestjs/common';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { RedisModule } from '../common/redis/redis.module';
import { WebhookModule } from '../webhook/webhook.module';
import { OutboxController } from './outbox.controller';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';
import { OutboxEventDispatcher } from './outbox-event-dispatcher.service';

@Module({
  imports: [RedisModule, MonitoringModule, forwardRef(() => WebhookModule)],
  controllers: [OutboxController],
  providers: [OutboxService, OutboxPublisherService, OutboxRelayService, OutboxEventDispatcher],
  exports: [OutboxService, OutboxEventDispatcher],
})
export class OutboxModule {}
