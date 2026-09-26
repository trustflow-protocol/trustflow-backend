import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { OutboxEvent, OutboxTransaction } from './outbox.types';
import { config } from '../config/env.config';

const EVENT_KEY_PREFIX = 'outbox:event:';
const PENDING_KEY = 'outbox:pending';
const PROCESSING_KEY = 'outbox:processing';
const WEBHOOK_PENDING_KEY = 'outbox:webhook:pending';
const WEBHOOK_PROCESSING_KEY = 'outbox:webhook:processing';
export const DEFAULT_OUTBOX_DELIVERED_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
const CLAIM_DUE_SCRIPT = `
  local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
  local claimed = {}
  for _, id in ipairs(ids) do
    if redis.call('ZREM', KEYS[1], id) == 1 then
      redis.call('ZADD', KEYS[2], ARGV[2], id)
      table.insert(claimed, id)
    end
  end
  return claimed
`;
const RECLAIM_EXPIRED_SCRIPT = `
  local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
  for _, id in ipairs(ids) do
    if redis.call('ZREM', KEYS[1], id) == 1 then
      redis.call('ZADD', KEYS[2], ARGV[1], id)
    end
  end
  return ids
`;

export const OUTBOX_PERSISTENCE_FALLBACK_METRIC = 'outbox_persistence_fallback_total';

/**
 * Redis-backed transactional outbox store.
 *
 * The current backend persists aggregate state in Redis, not PostgreSQL. The
 * caller appends an outbox event to the exact same MULTI/EXEC transaction as
 * the aggregate change; production refuses to start without Redis. This keeps
 * the outbox durable and atomic with the actual domain store today while
 * preserving a narrow API for a future SQL repository implementation.
 */
@Injectable()
export class OutboxService implements OnModuleInit {
  private readonly logger = new Logger(OutboxService.name);
  private readonly memory = new Map<string, OutboxEvent>();
  private readonly pending = new Set<string>();
  private readonly processing = new Map<string, number>();
  private readonly webhookPending = new Set<string>();
  private readonly webhookProcessing = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'OutboxService requires REDIS_URL in production so domain state and outbox events share a durable transaction',
      );
    }
  }

  create<T>(type: string, aggregateType: string, aggregateId: string, payload: T): OutboxEvent<T> {
    const now = Date.now();
    return {
      id: randomUUID(),
      dedupKey: `${aggregateType}:${aggregateId}:${type}`,
      type,
      aggregateType,
      aggregateId,
      payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: new Date(now).toISOString(),
    };
  }

  /** Queues an event on the caller's already-open aggregate transaction. */
  appendToTransaction(transaction: OutboxTransaction, event: OutboxEvent): void {
    transaction
      .set(this.eventKey(event.id), JSON.stringify(event))
      .zadd(PENDING_KEY, event.nextAttemptAt, event.id);
  }

  /** Fallback-only append for development/test stores that have no transaction. */
  async append(event: OutboxEvent, isWebhook = false): Promise<void> {
    const pendingKey = isWebhook ? WEBHOOK_PENDING_KEY : PENDING_KEY;
    if (this.redis) {
      const results = await this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(event))
        .zadd(pendingKey, event.nextAttemptAt, event.id)
        .exec();
      this.assertTransactionOk(results);
      return;
    }

    this.logFallback('append');
    this.memory.set(event.id, event);
    if (isWebhook) this.webhookPending.add(event.id);
    else this.pending.add(event.id);
  }

  sendWebhook(
    transaction: OutboxTransaction | null,
    eventName: string,
    payload: unknown,
    dedupKey?: string,
  ): void {
    const event = this.create(eventName, 'webhook', 'dispatch', payload);
    if (dedupKey) event.dedupKey = dedupKey;
    if (transaction) {
      transaction
        .set(this.eventKey(event.id), JSON.stringify(event))
        .zadd(WEBHOOK_PENDING_KEY, event.nextAttemptAt, event.id);
    } else {
      this.append(event, true).catch(err => this.logger.error('Failed to append webhook', err));
    }
  }

  async findById(id: string): Promise<OutboxEvent | undefined> {
    if (this.redis) {
      const raw = await this.redis.get(this.eventKey(id));
      return raw ? (JSON.parse(raw) as OutboxEvent) : undefined;
    }
    return this.memory.get(id);
  }

  /** Atomically claims due events and places a lease on each one. */
  async claimDue(
    now: number,
    leaseMs: number,
    limit: number,
    isWebhook = false,
  ): Promise<OutboxEvent[]> {
    const pendingKey = isWebhook ? WEBHOOK_PENDING_KEY : PENDING_KEY;
    const processingKey = isWebhook ? WEBHOOK_PROCESSING_KEY : PROCESSING_KEY;
    if (this.redis) {
      const ids = (await this.redis.eval(
        CLAIM_DUE_SCRIPT,
        2,
        pendingKey,
        processingKey,
        now,
        now + leaseMs,
        limit,
      )) as string[];
      if (ids.length === 0) return [];
      const raw = await this.redis.mget(...ids.map(id => this.eventKey(id)));
      return raw
        .filter((entry): entry is string => entry !== null)
        .map(entry => {
          const event = JSON.parse(entry) as OutboxEvent;
          event.status = 'processing';
          return event;
        });
    }

    this.logFallback('claim');
    const pendingSet = isWebhook ? this.webhookPending : this.pending;
    const processingMap = isWebhook ? this.webhookProcessing : this.processing;
    const events = [...pendingSet]
      .map(id => this.memory.get(id))
      .filter((event): event is OutboxEvent => Boolean(event && event.nextAttemptAt <= now))
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit);
    for (const event of events) {
      pendingSet.delete(event.id);
      processingMap.set(event.id, now + leaseMs);
      event.status = 'processing';
    }
    return events;
  }

  /** Returns abandoned processing leases to the pending set for redelivery. */
  async reclaimExpired(now: number, limit: number, isWebhook = false): Promise<void> {
    const pendingKey = isWebhook ? WEBHOOK_PENDING_KEY : PENDING_KEY;
    const processingKey = isWebhook ? WEBHOOK_PROCESSING_KEY : PROCESSING_KEY;
    if (this.redis) {
      await this.redis.eval(RECLAIM_EXPIRED_SCRIPT, 2, processingKey, pendingKey, now, limit);
      return;
    }

    const processingMap = isWebhook ? this.webhookProcessing : this.processing;
    const pendingSet = isWebhook ? this.webhookPending : this.pending;
    for (const [id, leaseUntil] of processingMap) {
      if (leaseUntil > now) continue;
      processingMap.delete(id);
      const event = this.memory.get(id);
      if (!event) continue;
      event.status = 'pending';
      event.nextAttemptAt = now;
      pendingSet.add(id);
    }
  }

  async markDelivered(event: OutboxEvent, isWebhook = false): Promise<void> {
    const processingKey = isWebhook ? WEBHOOK_PROCESSING_KEY : PROCESSING_KEY;
    event.status = 'delivered';
    event.deliveredAt = new Date().toISOString();
    event.lastError = undefined;

    if (this.redis) {
      const results = await this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(event))
        .expire(
          this.eventKey(event.id),
          config.OUTBOX_DELIVERED_TTL_SECONDS,
        )
        .zrem(processingKey, event.id)
        .exec();
      this.assertTransactionOk(results);
      return;
    }

    this.memory.set(event.id, event);
    const processingMap = isWebhook ? this.webhookProcessing : this.processing;
    processingMap.delete(event.id);
  }

  async retry(event: OutboxEvent, error: unknown, isWebhook = false): Promise<void> {
    const pendingKey = isWebhook ? WEBHOOK_PENDING_KEY : PENDING_KEY;
    const processingKey = isWebhook ? WEBHOOK_PROCESSING_KEY : PROCESSING_KEY;
    event.attempts += 1;
    event.lastError = error instanceof Error ? error.message : String(error);
    const failed =
      event.attempts >= config.OUTBOX_MAX_ATTEMPTS;
    event.status = failed ? 'failed' : 'pending';
    if (!failed) {
      event.nextAttemptAt =
        Date.now() + Math.min(1000 * 2 ** Math.min(event.attempts - 1, 5), 30_000);
    }

    if (this.redis) {
      const transaction = this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(event))
        .zrem(processingKey, event.id);
      if (!failed) transaction.zadd(pendingKey, event.nextAttemptAt, event.id);
      const results = await transaction.exec();
      this.assertTransactionOk(results);
      if (failed)
        this.logger.error(
          `Outbox event ${event.id} failed after ${event.attempts} attempts: ${event.lastError}`,
        );
      return;
    }

    this.memory.set(event.id, event);
    const processingMap = isWebhook ? this.webhookProcessing : this.processing;
    const pendingSet = isWebhook ? this.webhookPending : this.pending;
    processingMap.delete(event.id);
    if (failed) {
      this.logger.error(
        `Outbox event ${event.id} failed after ${event.attempts} attempts: ${event.lastError}`,
      );
    } else {
      pendingSet.add(event.id);
    }
  }

  private eventKey(id: string): string {
    return `${EVENT_KEY_PREFIX}${id}`;
  }

  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) throw new Error('Redis outbox transaction aborted');
    const failed = results.find(([error]) => error);
    if (failed) throw failed[0]!;
  }

  private logFallback(operation: string): void {
    this.metrics?.increment(OUTBOX_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.warn(
      `Redis unavailable for outbox.${operation}; using non-durable in-memory fallback`,
    );
  }
}
