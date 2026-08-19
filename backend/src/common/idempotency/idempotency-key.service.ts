import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { createHash } from 'crypto';

const KEY_PREFIX = 'idempotency:';
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export interface IdempotencyRecord {
  /** SHA-256 of the request body, used to detect key reuse with different payloads. */
  requestHash: string;
  /** Cached HTTP status code. */
  statusCode: number;
  /** Cached response body. */
  body: unknown;
}

@Injectable()
export class IdempotencyKeyService {
  private readonly logger = new Logger(IdempotencyKeyService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  /**
   * Hashes a request body to a stable fingerprint. We hash rather than store
   * the raw body so the Redis key stays compact.
   */
  static hashBody(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
  }

  /**
   * Looks up a previously stored idempotency record.
   * Returns null if the key does not exist or Redis is unavailable.
   */
  async lookup(endpoint: string, key: string): Promise<IdempotencyRecord | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(this.buildKey(endpoint, key));
      return raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
    } catch (err) {
      this.logger.warn('Idempotency lookup failed, proceeding without cache', err);
      return null;
    }
  }

  /**
   * Stores an idempotency record with a bounded TTL. No-op when Redis is unavailable.
   */
  async store(
    endpoint: string,
    key: string,
    requestHash: string,
    statusCode: number,
    body: unknown,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    if (!this.redis) return;
    const record: IdempotencyRecord = { requestHash, statusCode, body };
    try {
      await this.redis.set(
        this.buildKey(endpoint, key),
        JSON.stringify(record),
        'EX',
        ttlSeconds,
      );
    } catch (err) {
      this.logger.warn('Idempotency store failed, response will not be cached', err);
    }
  }

  private buildKey(endpoint: string, key: string): string {
    return `${KEY_PREFIX}${endpoint}:${key}`;
  }
}
