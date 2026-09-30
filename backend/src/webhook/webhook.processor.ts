import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { MetricsService } from '../monitoring/metrics.service';
import { OutboxService } from '../outbox/outbox.service';
import { WebhookService } from './webhook.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { config } from '../config/env.config';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';

@Injectable()
export class WebhookProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new SanitizedLogger(WebhookProcessor.name);
  private maxConcurrency: number = 10; // Configurable based on pool size

  constructor(
    private readonly outbox: OutboxService,
    private readonly webhookService: WebhookService,
    private readonly metrics: MetricsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  onModuleInit(): void {
    // Validate that Redis is available for webhook processing
    if (!this.redis && config.NODE_ENV === 'production') {
      this.logger.warn(
        'WebhookProcessor: Redis client not available in production. Webhook processing may be degraded.',
      );
    }
    
    // Set concurrency limit based on Redis pool configuration
    this.maxConcurrency = config.WEBHOOK_PROCESSOR_CONCURRENCY ?? 10;
  }

  onModuleDestroy(): void {
    // Cleanup handled by Redis module
  }

  @Cron(CronExpression.EVERY_SECOND)
  async processWebhooks() {
    const now = Date.now();
    const batchSize = Math.min(
      config.WEBHOOK_RELAY_BATCH_SIZE,
      this.maxConcurrency,
    ); // Limit batch to concurrency
    const leaseMs = config.WEBHOOK_RELAY_LEASE_MS;

    try {
      await this.outbox.reclaimExpired(now, batchSize, true);
      const events = await this.outbox.claimDue(now, leaseMs, batchSize, true);

      // Process events with bounded concurrency using Promise pool
      const processed = await this.processBatch(events);
      this.logger.debug(
        `Processed ${processed.succeeded} webhooks, ${processed.failed} failed`,
      );
    } catch (error) {
      this.logger.error('Webhook processor failed', error);
    }
  }

  /**
   * Process a batch of webhook events with bounded concurrency.
   * Uses the shared Redis connection pool without spawning additional clients.
   */
  private async processBatch(
    events: any[],
  ): Promise<{ succeeded: number; failed: number }> {
    let succeeded = 0;
    let failed = 0;

    // Process with limited concurrency using a semaphore pattern
    const concurrencyLimit = this.maxConcurrency;
    const queue = [...events];
    const inProgress: Promise<void>[] = [];

    while (queue.length > 0 || inProgress.length > 0) {
      // Maintain concurrency limit
      while (inProgress.length < concurrencyLimit && queue.length > 0) {
        const event = queue.shift();
        if (!event) break;

        const promise = this.processEvent(event)
          .then(() => {
            succeeded++;
          })
          .catch((error) => {
            failed++;
            this.logger.error(
              `Failed to process webhook event ${event.id}`,
              error,
            );
          })
          .finally(() => {
            // Remove from in-progress list
            inProgress.splice(inProgress.indexOf(promise), 1);
          });

        inProgress.push(promise);
      }

      // Wait for one to complete if we're at the limit
      if (inProgress.length >= concurrencyLimit && queue.length > 0) {
        await Promise.race(inProgress);
      }
    }

    // Wait for remaining in-progress promises
    await Promise.all(inProgress);

    return { succeeded, failed };
  }

  /**
   * Process a single webhook event using the shared Redis connection.
   * No standalone Redis clients are instantiated here.
   */
  private async processEvent(event: any): Promise<void> {
    try {
      await this.webhookService.deliver(event.type, event.payload, event.dedupKey);
      await this.outbox.markDelivered(event, true);
      this.metrics.increment('webhook_delivery_total', {
        result: 'delivered',
        type: event.type,
      });
    } catch (error) {
      await this.outbox.retry(event, error, true);
      this.metrics.increment('webhook_delivery_total', {
        result: 'retry',
        type: event.type,
      });
    }
  }
}
