import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { DiscordService } from './discord.service';

@Module({
  controllers: [WebhookController],
  providers: [WebhookService, DiscordService],
  exports: [WebhookService, DiscordService],
})
export class WebhookModule {}
