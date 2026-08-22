import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { MetricsService } from '../../monitoring/metrics.service';
import { createHash } from 'crypto';

const KEY_PREFIX = 'idempotency:';
const RECORD_VERSION = 1;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function defaultTtlSeconds(): number {
  const raw = process.env.IDEMPOTENCY_KEY_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

export interface IdempotencyRecord {
  /** Schema version of this record, so future format changes can be handled gracefully. */
  version: number;
  /** SHA-256 of the request body, used to detect key reuse with different payloads. */
  requestHash: string;
  /** `pending` while the original request is still executing, `completed` once cached. */
  status: 'pending' | 'completed';
  /** Cached HTTP status code. Present once `status` is `completed`. */
  statusCode?: number;
  /** Cached response body. Present once `status` is `completed`. */
  body?: unknown;
  /** Cached response headers worth replaying (e.g. Location). */
  headers?: Record<string, string>;
}

export type ClaimResult = { claimed: true } | { claimed: false; record: IdempotencyRecord | null };

@Injectable()
export class IdempotencyKeyService {
  private readonly logger = new Logger(IdempotencyKeyService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Hashes a request body to a stable fingerprint. We hash rather than store
   * the raw body so the Redis key stays compact.
   */
  static hashBody(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? {}))
      .digest('hex');
  }

  /**
   * Atomically claims (endpoint, key) for the current request via `SET NX` so
   * that concurrent requests carrying the same idempotency key cannot both
   * proceed to execute the handler. The caller that wins the race gets
   * `claimed: true` and should run the handler, then call {@link finalize}
   * (or {@link release} on failure). Callers that lose the race get the
   * existing record (which may still be `pending`) so they can replay it or
   * reject a mismatched payload.
   *
   * When Redis is unavailable, we degrade to `claimed: true` (no dedup)
   * rather than block the request.
   */
  async claim(
    endpoint: string,
    key: string,
    requestHash: string,
    ttlSeconds: number = defaultTtlSeconds(),
  ): Promise<ClaimResult> {
    if (!this.redis) return { claimed: true };

    const pending: IdempotencyRecord = {
      version: RECORD_VERSION,
      requestHash,
      status: 'pending',
    };

    try {
      const result = await this.redis.set(
        this.buildKey(endpoint, key),
        JSON.stringify(pending),
        'EX',
        ttlSeconds,
        'NX',
      );
      if (result === 'OK') {
        this.metrics?.increment('idempotency_cache_miss_total', { endpoint });
        return { claimed: true };
      }
    } catch (err) {
      this.logger.warn('Idempotency claim failed, proceeding without cache', err);
      this.metrics?.increment('idempotency_redis_error_total', { endpoint, op: 'claim' });
      return { claimed: true };
    }

    try {
      const raw = await this.redis.get(this.buildKey(endpoint, key));
      this.metrics?.increment('idempotency_cache_hit_total', { endpoint });
      return { claimed: false, record: raw ? (JSON.parse(raw) as IdempotencyRecord) : null };
    } catch (err) {
      this.logger.warn('Idempotency lookup failed, proceeding without cache', err);
      this.metrics?.increment('idempotency_redis_error_total', { endpoint, op: 'lookup' });
      return { claimed: true };
    }
  }

  /**
   * Finalizes a previously claimed key with the handler's response.
   * No-op when Redis is unavailable.
   */
  async finalize(
    endpoint: string,
    key: string,
    requestHash: string,
    statusCode: number,
    body: unknown,
    headers: Record<string, string> = {},
    ttlSeconds: number = defaultTtlSeconds(),
  ): Promise<void> {
    if (!this.redis) return;
    const record: IdempotencyRecord = {
      version: RECORD_VERSION,
      requestHash,
      status: 'completed',
      statusCode,
      body,
      headers,
    };
    try {
      await this.redis.set(this.buildKey(endpoint, key), JSON.stringify(record), 'EX', ttlSeconds);
      this.metrics?.increment('idempotency_store_success_total', { endpoint });
    } catch (err) {
      this.logger.warn('Idempotency store failed, response will not be cached', err);
      this.metrics?.increment('idempotency_redis_error_total', { endpoint, op: 'finalize' });
    }
  }

  /**
   * Releases a claimed key, e.g. after the handler throws, so the key does
   * not stay stuck as `pending` (blocking retries) until its TTL expires.
   */
  async release(endpoint: string, key: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.buildKey(endpoint, key));
    } catch (err) {
      this.logger.warn('Idempotency release failed', err);
      this.metrics?.increment('idempotency_redis_error_total', { endpoint, op: 'release' });
    }
  }

  private buildKey(endpoint: string, key: string): string {
    return `${KEY_PREFIX}${endpoint}:${key}`;
  }
}
