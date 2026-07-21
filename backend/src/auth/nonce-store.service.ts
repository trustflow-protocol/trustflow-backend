import { Injectable, Inject, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';

const NONCE_TTL_SECONDS = 60;
const CONSUMED_TTL_SECONDS = 300;

const GETDEL_LUA = `
local val = redis.call('GET', KEYS[1])
if val then
  redis.call('DEL', KEYS[1])
end
return val
`;

@Injectable()
export class NonceStoreService {
  private readonly logger = new Logger(NonceStoreService.name);

  private readonly inMemoryChallenges = new Map<string, { challenge: string; expiresAt: number }>();
  private readonly inMemoryConsumed = new Map<string, number>();

  private get redis(): Redis | null {
    return this.redisClient;
  }

  constructor(@Inject(REDIS_CLIENT) private readonly redisClient: Redis | null) {}

  async store(address: string, challenge: string, nonce: string): Promise<void> {
    const key = this.challengeKey(address);
    const nonceKey = this.nonceKey(nonce);

    if (this.redis) {
      try {
        const result = await this.redis.set(key, challenge, 'EX', NONCE_TTL_SECONDS, 'NX');
        if (!result) {
          this.logger.warn(`Challenge already exists for ${this.maskAddress(address)}, replacing`);
          await this.redis.set(key, challenge, 'EX', NONCE_TTL_SECONDS);
        }
        await this.redis.set(nonceKey, '1', 'EX', CONSUMED_TTL_SECONDS);
        return;
      } catch (err) {
        this.logger.warn('Redis unavailable for nonce store, falling back to memory');
      }
    }

    this.inMemoryChallenges.set(key, {
      challenge,
      expiresAt: Date.now() + NONCE_TTL_SECONDS * 1000,
    });
    this.inMemoryConsumed.set(nonceKey, Date.now() + CONSUMED_TTL_SECONDS * 1000);
    this.cleanupExpiredEntries();
  }

  async consume(address: string): Promise<string | null> {
    const key = this.challengeKey(address);

    if (this.redis) {
      try {
        const result = (await this.redis.eval(GETDEL_LUA, 1, key)) as string | null;
        return result || null;
      } catch (err) {
        this.logger.warn('Redis unavailable for nonce consume, falling back to memory');
      }
    }

    const entry = this.inMemoryChallenges.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.inMemoryChallenges.delete(key);
      return null;
    }

    this.inMemoryChallenges.delete(key);
    return entry.challenge;
  }

  async isNonceReplay(nonce: string): Promise<boolean> {
    const key = this.nonceKey(nonce);

    if (this.redis) {
      try {
        const exists = await this.redis.exists(key);
        return exists === 1;
      } catch (err) {
        this.logger.warn('Redis unavailable for replay check, falling back to memory');
      }
    }

    const expiresAt = this.inMemoryConsumed.get(key);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.inMemoryConsumed.delete(key);
      return false;
    }
    return true;
  }

  async markNonceUsed(nonce: string): Promise<void> {
    const key = this.nonceKey(nonce);

    if (this.redis) {
      try {
        await this.redis.set(key, '1', 'EX', CONSUMED_TTL_SECONDS, 'NX');
        return;
      } catch (err) {
        this.logger.warn('Redis unavailable for marking nonce, falling back to memory');
      }
    }

    this.inMemoryConsumed.set(key, Date.now() + CONSUMED_TTL_SECONDS * 1000);
  }

  async hasActiveChallenge(address: string): Promise<boolean> {
    const key = this.challengeKey(address);

    if (this.redis) {
      try {
        const exists = await this.redis.exists(key);
        return exists === 1;
      } catch (err) {
        this.logger.warn('Redis unavailable for challenge check');
      }
    }

    const entry = this.inMemoryChallenges.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.inMemoryChallenges.delete(key);
      return false;
    }
    return true;
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.inMemoryChallenges.entries()) {
      if (now > entry.expiresAt) {
        this.inMemoryChallenges.delete(key);
      }
    }
    for (const [key, expiresAt] of this.inMemoryConsumed.entries()) {
      if (now > expiresAt) {
        this.inMemoryConsumed.delete(key);
      }
    }
  }

  private challengeKey(address: string): string {
    return `auth:nonce:${address}`;
  }

  private nonceKey(nonce: string): string {
    return `auth:nonce:used:${nonce}`;
  }

  private maskAddress(address: string): string {
    if (address.length <= 12) return '****';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
