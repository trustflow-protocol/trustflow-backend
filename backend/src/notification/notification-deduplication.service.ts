import { Injectable, Inject } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import * as crypto from 'crypto';

const DEDUP_KEY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

@Injectable()
export class NotificationDeduplicationService {
  private readonly logger = new SanitizedLogger(NotificationDeduplicationService.name);
  private readonly inMemoryKeys = new Map<string, number>();

  private get redis(): Redis | null {
    return this.redisClient;
  }

  constructor(@Inject(REDIS_CLIENT) private readonly redisClient: Redis | null) {}

  generateDedupKey(type: string, disputeId: string, recipientAddress: string): string {
    return crypto
      .createHash('sha256')
      .update(`${type}:${disputeId}:${recipientAddress}`)
      .digest('hex');
  }

  async claimKey(dedupKey: string): Promise<boolean> {
    const redisKey = this.redisKey(dedupKey);

    if (this.redis) {
      try {
        const result = await this.redis.set(redisKey, '1', 'EX', DEDUP_KEY_TTL_SECONDS, 'NX');
        return result === 'OK';
      } catch (err) {
        this.logger.warn('Redis unavailable for dedup key claim, falling back to memory');
      }
    }

    if (this.inMemoryKeys.has(dedupKey)) {
      const expiresAt = this.inMemoryKeys.get(dedupKey)!;
      if (Date.now() > expiresAt) {
        this.inMemoryKeys.delete(dedupKey);
      } else {
        return false;
      }
    }

    this.inMemoryKeys.set(dedupKey, Date.now() + DEDUP_KEY_TTL_SECONDS * 1000);
    return true;
  }

  async releaseKey(dedupKey: string): Promise<void> {
    const redisKey = this.redisKey(dedupKey);

    if (this.redis) {
      try {
        await this.redis.del(redisKey);
        return;
      } catch (err) {
        this.logger.warn('Redis unavailable for dedup key release, falling back to memory');
      }
    }

    this.inMemoryKeys.delete(dedupKey);
  }

  private redisKey(dedupKey: string): string {
    return `notification-dedup:${dedupKey}`;
  }
}
