import { forwardRef, Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { DiscordService } from './discord.service';
import { WebhookProcessor } from './webhook.processor';
import { OutboxModule } from '../outbox/outbox.module';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [forwardRef(() => OutboxModule), MonitoringModule],
  controllers: [WebhookController],
  providers: [WebhookService, DiscordService, WebhookProcessor],
  exports: [WebhookService, DiscordService],
})
export class WebhookModule {}
