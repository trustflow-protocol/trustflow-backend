import { Injectable, Inject } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';

const NONCE_TTL_SECONDS = 60;
const CONSUMED_TTL_SECONDS = 300;

export interface WalletRateLimitResult {
  allowed: boolean;
  /** Seconds until the caller should retry; 0 when `allowed` is true. */
  retryAfter: number;
}

const GETDEL_LUA = `
local val = redis.call('GET', KEYS[1])
if val then
  redis.call('DEL', KEYS[1])
end
return val
`;

@Injectable()
export class NonceStoreService {
  private readonly logger = new SanitizedLogger(NonceStoreService.name);

  private readonly inMemoryChallenges = new Map<string, { challenge: string; expiresAt: number }>();
  private readonly inMemoryConsumed = new Map<string, number>();
  private readonly inMemoryWalletChallengeCounts = new Map<string, { count: number; resetAt: number }>();

  private get redis(): Redis | null {
    return this.redisClient;
  }

  constructor(@Inject(REDIS_CLIENT) private readonly redisClient: Redis | null) {
    // Only attach event listeners if we have a real Redis client (not null or mock)
    if (this.redisClient && typeof this.redisClient.on === 'function') {
      // Listen for reconnection events to verify TTL enforcement remains intact
      this.redisClient.on('ready', () => {
        this.verifyTTLConfiguration();
      });
    }
  }

  /**
   * Verifies that Redis TTL configuration is correct after reconnection or Sentinel
   * failover. This is a health check that ensures nonces will expire properly even
   * after cluster topology changes.
   */
  private async verifyTTLConfiguration(): Promise<void> {
    if (!this.redis) return;

    const testKey = 'auth:nonce:ttl-verification-test';
    try {
      // Set a test key with TTL
      await this.redis.set(testKey, '1', 'EX', NONCE_TTL_SECONDS);
      
      // Verify TTL was actually set
      const ttl = await this.redis.ttl(testKey);
      
      // Clean up test key
      await this.redis.del(testKey);
      
      if (ttl <= 0 || ttl > NONCE_TTL_SECONDS) {
        this.logger.error(
          `Redis TTL verification failed: expected ~${NONCE_TTL_SECONDS}s, got ${ttl}s. ` +
          'Nonce expiration may not work correctly!'
        );
      } else {
        this.logger.log('Redis TTL configuration verified after reconnection');
      }
    } catch (err) {
      this.logger.error('Failed to verify Redis TTL configuration after reconnection', err);
    }
  }

  /**
   * Stores `challenge` as the pending challenge for `address` and returns the challenge the
   * caller should sign. A live challenge is never replaced (#369): `/auth/challenge` is
   * unauthenticated, so replacing on every request let anyone cancel another wallet's
   * in-flight login by asking for a fresh challenge. Instead the existing, still-valid
   * challenge is returned — it is not secret, only the wallet's key can sign it.
   */
  async store(address: string, challenge: string, _nonce: string): Promise<string> {
    const key = this.challengeKey(address);

    if (this.redis) {
      try {
        const result = await this.redis.set(key, challenge, 'EX', NONCE_TTL_SECONDS, 'NX');
        if (result) return challenge;

        const existing = await this.redis.get(key);
        if (existing) {
          this.logger.debug(
            `Live challenge already pending for ${this.maskAddress(address)}, reusing it`,
          );
          return existing;
        }
        // Expired between the SET NX and the GET — claim the slot again.
        const retry = await this.redis.set(key, challenge, 'EX', NONCE_TTL_SECONDS, 'NX');
        return retry ? challenge : ((await this.redis.get(key)) ?? challenge);
      } catch (err) {
        this.logger.warn('Redis unavailable for nonce store, falling back to memory');
      }
    }

    this.cleanupExpiredEntries();
    const existing = this.inMemoryChallenges.get(key);
    if (existing && Date.now() <= existing.expiresAt) {
      return existing.challenge;
    }

    this.inMemoryChallenges.set(key, {
      challenge,
      expiresAt: Date.now() + NONCE_TTL_SECONDS * 1000,
    });
    return challenge;
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

  /**
   * Read-only check for whether `nonce` has already been marked used. Not used as a
   * pre-verification gate in the login flow (see `markNonceUsed`, which does that
   * check-and-set atomically) — kept as a standalone query for callers that just need
   * to know current state without also mutating it.
   */
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

  /**
   * Atomically marks `nonce` as used. Returns `true` the first time a given nonce is
   * marked (safe to proceed) and `false` if it was already marked (a replay) — the
   * `SET ... NX` (Redis) / has-then-set (memory) check and the write happen as a single
   * step so there is no read-then-write gap between detecting and recording use.
   */
  async markNonceUsed(nonce: string): Promise<boolean> {
    const key = this.nonceKey(nonce);

    if (this.redis) {
      try {
        const result = await this.redis.set(key, '1', 'EX', CONSUMED_TTL_SECONDS, 'NX');
        return result === 'OK';
      } catch (err) {
        this.logger.warn('Redis unavailable for marking nonce, falling back to memory');
      }
    }

    const expiresAt = this.inMemoryConsumed.get(key);
    const alreadyUsed = expiresAt !== undefined && Date.now() <= expiresAt;
    if (alreadyUsed) return false;

    this.inMemoryConsumed.set(key, Date.now() + CONSUMED_TTL_SECONDS * 1000);
    return true;
  }

  /**
   * Fixed-window counter on the challenge-target wallet address, independent of the caller's
   * IP (#993). `/auth/challenge` is unauthenticated and only ever IP-limited, so a script
   * spread across many IPs/proxies could otherwise mint unlimited pending challenges for one
   * target wallet, each consuming Redis memory until its 60s TTL. This is keyed on the
   * `address` itself — the same key `store()` writes to — regardless of which IP asked.
   */
  async checkWalletChallengeRateLimit(
    address: string,
    points: number,
    durationSeconds: number,
  ): Promise<WalletRateLimitResult> {
    const key = this.walletChallengeRateLimitKey(address);

    if (this.redis) {
      try {
        const count = await this.redis.incr(key);
        if (count === 1) {
          await this.redis.expire(key, durationSeconds);
        }
        if (count > points) {
          const ttl = await this.redis.ttl(key);
          return { allowed: false, retryAfter: ttl > 0 ? ttl : durationSeconds };
        }
        return { allowed: true, retryAfter: 0 };
      } catch (err) {
        this.logger.warn('Redis unavailable for wallet challenge rate limit, falling back to memory');
      }
    }

    this.cleanupExpiredEntries();
    const now = Date.now();
    const entry = this.inMemoryWalletChallengeCounts.get(key);

    if (!entry || now > entry.resetAt) {
      this.inMemoryWalletChallengeCounts.set(key, { count: 1, resetAt: now + durationSeconds * 1000 });
      return { allowed: true, retryAfter: 0 };
    }

    entry.count += 1;
    if (entry.count > points) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
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
    for (const [key, entry] of this.inMemoryWalletChallengeCounts.entries()) {
      if (now > entry.resetAt) {
        this.inMemoryWalletChallengeCounts.delete(key);
      }
    }
  }

  private challengeKey(address: string): string {
    return `auth:nonce:${address}`;
  }

  private nonceKey(nonce: string): string {
    return `auth:nonce:used:${nonce}`;
  }

  private walletChallengeRateLimitKey(address: string): string {
    return `auth:challenge:wallet-ratelimit:${address}`;
  }

  private maskAddress(address: string): string {
    if (address.length <= 12) return '****';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
