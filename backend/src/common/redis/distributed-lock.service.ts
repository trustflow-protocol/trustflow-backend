import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// Compare-and-delete: only release a lock if it's still held by the token
// that acquired it (avoids releasing another instance's lock after this
// instance's own lease already expired and was re-acquired elsewhere).
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// Compare-and-extend: only renew a lock if still held by the token.
// Returns 1 if renewed, 0 if lost or token mismatch.
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * Redis-backed distributed lock (`SET key token NX PX ttl`) used so that
 * only one backend instance runs a given background sweep tick.
 *
 * When Redis is unavailable (`REDIS_CLIENT` is `null`, e.g. `REDIS_URL`
 * unset), `tryAcquire` fails open — it returns a lock token unconditionally
 * and logs a warning — so single-instance / local-dev deployments keep the
 * pre-existing per-instance sweep behavior instead of a sweep silently
 * never running. Multi-instance deployments must set `REDIS_URL`, or every
 * instance will independently believe it holds the lock.
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  /** Attempts to acquire `key` for `ttlMs`. Returns the lock token if held, else `null`. */
  async tryAcquire(key: string, ttlMs: number): Promise<string | null> {
    if (!this.redis) {
      this.logger.warn(
        `Redis unavailable — lock "${key}" fails open (per-instance execution, no cross-instance coordination)`,
      );
      return randomUUID();
    }

    const token = randomUUID();
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  /** Releases `key` only if still held by `token`. No-op (not an error) if already expired/taken over. */
  async release(key: string, token: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.eval(RELEASE_LUA, 1, key, token);
    } catch (error) {
      this.logger.warn(
        `Failed to release lock "${key}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Renews the lock on `key` if still held by `token`, extending its TTL.
   * Returns true if renewed, false if lock is lost (held by another token or expired).
   * Throws if Redis is unavailable or there's a command error.
   */
  async renewIfOwned(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (!this.redis) {
      // No Redis: always succeed (single-instance deployments don't lose locks)
      return true;
    }

    try {
      const result = await this.redis.eval(RENEW_LUA, 1, key, token, ttlMs);
      return result === 1;
    } catch (error) {
      throw new Error(
        `Failed to renew lock "${key}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
