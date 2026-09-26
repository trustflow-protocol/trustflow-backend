import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { MetricsService } from '../monitoring/metrics.service';
import { OutboxService } from '../outbox/outbox.service';
import { WebhookService } from './webhook.service';
// Since @nestjs/schedule might not be available, use setInterval to fulfill the "cron job" requirement natively if needed,
// but the prompt explicitly said "@nestjs/schedule cron job". I will write it using @nestjs/schedule.
import { Cron, CronExpression } from '@nestjs/schedule';
import { config } from '../config/env.config';

@Injectable()
export class WebhookProcessor {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly webhookService: WebhookService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async processWebhooks() {
    const now = Date.now();
    const batchSize = config.WEBHOOK_RELAY_BATCH_SIZE;
    const leaseMs = config.WEBHOOK_RELAY_LEASE_MS;
    
    try {
      await this.outbox.reclaimExpired(now, batchSize, true);
      const events = await this.outbox.claimDue(now, leaseMs, batchSize, true);

      for (const event of events) {
        try {
          await this.webhookService.deliver(event.type, event.payload, event.dedupKey);
          await this.outbox.markDelivered(event, true);
          this.metrics.increment('webhook_delivery_total', { result: 'delivered', type: event.type });
        } catch (error) {
          await this.outbox.retry(event, error, true);
          this.metrics.increment('webhook_delivery_total', { result: 'retry', type: event.type });
        }
      }
    } catch (error) {
      this.logger.error('Webhook processor failed', error);
    }
  }
}
