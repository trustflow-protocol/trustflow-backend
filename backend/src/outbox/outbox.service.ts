import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { OutboxEvent, OutboxTransaction } from './outbox.types';

const EVENT_KEY_PREFIX = 'outbox:event:';
const PENDING_KEY = 'outbox:pending';
const PROCESSING_KEY = 'outbox:processing';
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

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && process.env.NODE_ENV === 'production') {
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
  async append(event: OutboxEvent): Promise<void> {
    if (this.redis) {
      const results = await this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(event))
        .zadd(PENDING_KEY, event.nextAttemptAt, event.id)
        .exec();
      this.assertTransactionOk(results);
      return;
    }

    this.logFallback('append');
    this.memory.set(event.id, event);
    this.pending.add(event.id);
  }

  async findById(id: string): Promise<OutboxEvent | undefined> {
    if (this.redis) {
      const raw = await this.redis.get(this.eventKey(id));
      return raw ? (JSON.parse(raw) as OutboxEvent) : undefined;
    }
    return this.memory.get(id);
  }

  /** Atomically claims due events and places a lease on each one. */
  async claimDue(now: number, leaseMs: number, limit: number): Promise<OutboxEvent[]> {
    if (this.redis) {
      const ids = (await this.redis.eval(
        CLAIM_DUE_SCRIPT,
        2,
        PENDING_KEY,
        PROCESSING_KEY,
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
    const events = [...this.pending]
      .map(id => this.memory.get(id))
      .filter((event): event is OutboxEvent => Boolean(event && event.nextAttemptAt <= now))
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit);
    for (const event of events) {
      this.pending.delete(event.id);
      this.processing.set(event.id, now + leaseMs);
      event.status = 'processing';
    }
    return events;
  }

  /** Returns abandoned processing leases to the pending set for redelivery. */
  async reclaimExpired(now: number, limit: number): Promise<void> {
    if (this.redis) {
      await this.redis.eval(RECLAIM_EXPIRED_SCRIPT, 2, PROCESSING_KEY, PENDING_KEY, now, limit);
      return;
    }

    for (const [id, leaseUntil] of this.processing) {
      if (leaseUntil > now) continue;
      this.processing.delete(id);
      const event = this.memory.get(id);
      if (!event) continue;
      event.status = 'pending';
      event.nextAttemptAt = now;
      this.pending.add(id);
    }
  }

  async markDelivered(event: OutboxEvent): Promise<void> {
    event.status = 'delivered';
    event.deliveredAt = new Date().toISOString();
    event.lastError = undefined;

    if (this.redis) {
      const results = await this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(event))
        .zrem(PROCESSING_KEY, event.id)
        .exec();
      this.assertTransactionOk(results);
      return;
    }

    this.memory.set(event.id, event);
    this.processing.delete(event.id);
  }

  async retry(event: OutboxEvent, error: unknown): Promise<void> {
    event.attempts += 1;
    event.status = 'pending';
    event.lastError = error instanceof Error ? error.message : String(error);
    event.nextAttemptAt =
      Date.now() + Math.min(1000 * 2 ** Math.min(event.attempts - 1, 5), 30_000);

    if (this.redis) {
      const results = await this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(event))
        .zrem(PROCESSING_KEY, event.id)
        .zadd(PENDING_KEY, event.nextAttemptAt, event.id)
        .exec();
      this.assertTransactionOk(results);
      return;
    }

    this.memory.set(event.id, event);
    this.processing.delete(event.id);
    this.pending.add(event.id);
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
