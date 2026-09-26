import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { OutboxEvent } from './outbox.types';

export const OUTBOX_GATEWAY_CHANNEL = 'trustflow:events:gateway';
export const OUTBOX_QUEUE_KEY = 'trustflow:events:queue';
export const DEFAULT_OUTBOX_QUEUE_MAX_LENGTH = 1000;

/**
 * Relays durable events to the WebSocket gateway's Redis pub/sub channel and
 * to the worker queue. Consumers receive the same stable `dedupKey` in both
 * payloads and must treat duplicates as expected at-least-once delivery.
 */
@Injectable()
export class OutboxPublisherService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async publish(event: OutboxEvent): Promise<void> {
    if (!this.redis) return;

    const payload = JSON.stringify(event);
    const results = await this.redis
      .multi()
      .publish(OUTBOX_GATEWAY_CHANNEL, payload)
      .lpush(OUTBOX_QUEUE_KEY, payload)
      .ltrim(OUTBOX_QUEUE_KEY, 0, this.queueMaxLength() - 1)
      .exec();

    if (!results) throw new Error('Redis outbox publish transaction aborted');
    const failed = results.find(([error]) => error);
    if (failed) throw failed[0]!;
  }

  private queueMaxLength(): number {
    const value = Number(process.env.OUTBOX_QUEUE_MAX_LENGTH);
    return Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_OUTBOX_QUEUE_MAX_LENGTH;
  }
}
