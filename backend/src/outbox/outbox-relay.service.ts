import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MetricsService } from '../monitoring/metrics.service';
import { WebhookService } from '../webhook/webhook.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxService } from './outbox.service';

const DEFAULT_RELAY_INTERVAL_MS = 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_MS = 30_000;

/** Background relay for at-least-once outbox delivery. */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly outbox: OutboxService,
    private readonly publisher: OutboxPublisherService,
    private readonly webhookService: WebhookService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const interval = this.numberEnv('OUTBOX_RELAY_INTERVAL_MS', DEFAULT_RELAY_INTERVAL_MS);
    if (interval <= 0) return;
    this.timer = setInterval(() => {
      this.runOnce().catch(error => this.logger.error('Outbox relay failed', error));
    }, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    const now = Date.now();
    const batchSize = this.numberEnv('OUTBOX_RELAY_BATCH_SIZE', DEFAULT_BATCH_SIZE);
    const leaseMs = this.numberEnv('OUTBOX_RELAY_LEASE_MS', DEFAULT_LEASE_MS);
    await this.outbox.reclaimExpired(now, batchSize);
    const events = await this.outbox.claimDue(now, leaseMs, batchSize);

    for (const event of events) {
      try {
        // Publish first. If a later destination fails, redelivery is expected;
        // all destinations receive the stable dedupKey to collapse duplicates.
        await this.publisher.publish(event);
        await this.webhookService.dispatch(event.type, event.payload, event.dedupKey);
        await this.outbox.markDelivered(event);
        this.metrics.increment('outbox_delivery_total', { result: 'delivered', type: event.type });
      } catch (error) {
        await this.outbox.retry(event, error);
        this.metrics.increment('outbox_delivery_total', { result: 'retry', type: event.type });
      }
    }

    return events.length;
  }

  private numberEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }
}
