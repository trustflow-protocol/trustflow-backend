// config.ts caches validateEnv()'s parsed result at module scope, so a process.env mutation
// after the first validateEnv() call has no effect on config.RATE_LIMIT_* (tracked separately
// as #467). These must therefore be set once, here, before the validateEnv() call below —
// short values so the abuse/lockout tests use real (short) waits instead of the production
// defaults (a 900s lockout, 300s abuse window).
process.env.RATE_LIMIT_ABUSE_THRESHOLD = '3';
process.env.RATE_LIMIT_ABUSE_WINDOW_SECONDS = '2';
process.env.RATE_LIMIT_LOCKOUT_SECONDS = '3';

import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { Redis } from 'ioredis';
import { RateLimitGuard } from './rate-limit.guard';
import { REDIS_CLIENT } from '../redis/redis.module';
import { HttpException } from '@nestjs/common';
import { SKIP_RATE_LIMIT, RATE_LIMIT_POINTS, RATE_LIMIT_DURATION } from './rate-limit.decorator';
import { validateEnv } from '../../config/env.config';

// canActivate() reads config.RATE_LIMIT_* on every call now (previously only on a
// rejection, via the old recordAbuse()), so this — unlike before — fails every test, not
// just the abuse-triggering ones, if validateEnv() hasn't run first.
validateEnv();

/**
 * Exercises RateLimitGuard's combined Lua script against a real Redis server instead of the
 * mocked ioredis client the rest of rate-limit.guard.spec.ts uses. This guards against
 * behavior the mock can't faithfully reproduce: real Lua script execution (via EVALSHA, with
 * ioredis handling NOSCRIPT transparently), real HSET/HMGET/ZADD/ZCARD/ZREMRANGEBYSCORE/PTTL
 * operations, real TTL/EXPIRE semantics, and Redis's own `TIME` as the clock.
 *
 * Requires REDIS_URL — CI provides a `redis:7-alpine` service container (see
 * .github/workflows/backend-ci.yml). Skipped locally when REDIS_URL isn't set rather than
 * failing, so `npm test` still works without a local Redis.
 */
const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;

function mockContext(overrides?: {
  ip?: string;
  method?: string;
  url?: string;
  routePath?: string;
  user?: Record<string, string>;
}) {
  const ip = overrides?.ip ?? '127.0.0.1';
  const url = overrides?.url ?? '/test';
  const routePath = overrides?.routePath ?? '/test';

  const handler = () => {};
  const cls = class Mock {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context: any = {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({
        ip,
        method: overrides?.method ?? 'GET',
        url,
        route: { path: routePath },
        headers: {},
        connection: { remoteAddress: '::1' },
        user: overrides?.user,
      }),
    }),
  };

  return { context };
}

function createReflector(overrides?: { skip?: boolean; points?: number; duration?: number }) {
  return {
    // The guard passes the decorator constants' *values* (SKIP_RATE_LIMIT === 'skip_rate_limit',
    // etc.), not their variable names, as the metadata key to getAllAndOverride().
    getAllAndOverride: jest.fn((key: string) => {
      if (key === SKIP_RATE_LIMIT) return overrides?.skip;
      if (key === RATE_LIMIT_POINTS) return overrides?.points;
      if (key === RATE_LIMIT_DURATION) return overrides?.duration;
      return undefined;
    }),
  } as unknown as Reflector;
}

async function makeGuard(redis: Redis, overrides?: { points?: number; duration?: number }) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RateLimitGuard,
      { provide: REDIS_CLIENT, useValue: redis },
      { provide: Reflector, useValue: createReflector(overrides ?? { points: 5, duration: 10 }) },
    ],
  }).compile();

  return module.get<RateLimitGuard>(RateLimitGuard);
}

describeIfRedis('RateLimitGuard (Redis integration)', () => {
  let redis: Redis;
  let guard: RateLimitGuard;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    // Isolate each test from prior runs/tests
    const keys = await redis.keys('ratelimit:*');
    if (keys.length > 0) await redis.del(...keys);

    guard = await makeGuard(redis);
  });

  it('allows requests while the token bucket has capacity', async () => {
    const { context } = mockContext({ ip: '10.0.0.1' });

    // First 5 requests should succeed (capacity = 5)
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    // 6th request should be rejected (bucket exhausted)
    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
  });

  it('refills the bucket over time using the real combined script', async () => {
    const { context } = mockContext({ ip: '10.0.0.2' });

    // Exhaust the bucket (5 requests)
    for (let i = 0; i < 5; i++) {
      await guard.canActivate(context);
    }

    // Next request should fail
    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);

    // Wait for ~2 seconds (20% of the 10-second refill duration = 1 token)
    await new Promise(resolve => setTimeout(resolve, 2100));

    // Should have refilled ~1 token
    await expect(guard.canActivate(context)).resolves.toBe(true);

    // But not more than 1
    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
  });

  it('records abuse events in a sorted set and triggers lockout', async () => {
    // RATE_LIMIT_ABUSE_THRESHOLD=3 / RATE_LIMIT_LOCKOUT_SECONDS=3 are set at module scope
    // above. A long bucket duration (relative to the few milliseconds these back-to-back
    // calls take) keeps the bucket from refilling mid-test, which would otherwise turn an
    // expected rejection into a spurious success and silently short the abuse count below
    // the threshold.
    const rejectionGuard = await makeGuard(redis, { points: 5, duration: 120 });
    const { context } = mockContext({ ip: '10.0.0.3' });

    // Exhaust the bucket (capacity 5)
    for (let i = 0; i < 5; i++) {
      await rejectionGuard.canActivate(context);
    }

    // Trigger 3 abuse events (bucket rejections) — matches the threshold set above
    for (let i = 0; i < 3; i++) {
      try {
        await rejectionGuard.canActivate(context);
      } catch (e) {
        // Expected rejection
      }
    }

    // Verify lockout key exists with TTL
    const lockoutKey = 'ratelimit:{ip:10.0.0.3:get:_test}:lockout';
    const lockoutTtl = await redis.ttl(lockoutKey);
    expect(lockoutTtl).toBeGreaterThan(0);
    expect(lockoutTtl).toBeLessThanOrEqual(3);

    // Verify abuse sorted set exists
    const abuseKey = 'ratelimit:{ip:10.0.0.3:get:_test}:abuse';
    const abuseCount = await redis.zcard(abuseKey);
    expect(abuseCount).toBe(3);

    // New requests should be immediately rejected during lockout
    await expect(rejectionGuard.canActivate(context)).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'Too many requests - rate limit exceeded',
      }),
    });

    // Lockout expiry itself is real Redis EXPIRE/TTL semantics, already covered by the TTL
    // assertion above and by "refills the bucket over time" — no need to also wait it out here
    // (this guard's 120s bucket duration means a token wouldn't refill in a practical wait
    // anyway, since it's deliberately slow to keep the abuse loop above from refilling early).
  }, 10_000);

  it('enforces both IP and wallet buckets independently, in a single pipelined round trip', async () => {
    const { context: ipOnlyContext } = mockContext({ ip: '10.0.0.4' });
    const { context: walletContext } = mockContext({
      ip: '10.0.0.4',
      user: { address: 'GWALLET1' },
    });

    // Exhaust IP bucket without wallet
    for (let i = 0; i < 5; i++) {
      await guard.canActivate(ipOnlyContext);
    }

    // IP bucket exhausted
    await expect(guard.canActivate(ipOnlyContext)).rejects.toThrow(HttpException);

    // But wallet-authenticated requests should still check the wallet bucket (fresh)
    // The IP bucket is still exhausted, so this will fail on IP
    await expect(guard.canActivate(walletContext)).rejects.toThrow(HttpException);

    // Wait for IP bucket to refill slightly
    await new Promise(resolve => setTimeout(resolve, 2100));

    // Now wallet request should succeed (both IP and wallet buckets allow it)
    await expect(guard.canActivate(walletContext)).resolves.toBe(true);
  });

  it('cleans up old abuse entries via ZREMRANGEBYSCORE', async () => {
    // Long bucket duration for the same reason as the lockout test above.
    const rejectionGuard = await makeGuard(redis, { points: 5, duration: 120 });
    const { context } = mockContext({ ip: '10.0.0.5' });

    // Exhaust bucket
    for (let i = 0; i < 5; i++) {
      await rejectionGuard.canActivate(context);
    }

    // Trigger 2 abuse events — below the threshold (3) set above, so no lockout yet
    for (let i = 0; i < 2; i++) {
      try {
        await rejectionGuard.canActivate(context);
      } catch (e) {
        // Expected
      }
    }

    const abuseKey = 'ratelimit:{ip:10.0.0.5:get:_test}:abuse';
    let abuseCount = await redis.zcard(abuseKey);
    expect(abuseCount).toBe(2);

    // Wait for the 2s abuse window (set above) to pass
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Trigger another abuse event — the script should clean up old entries
    try {
      await rejectionGuard.canActivate(context);
    } catch (e) {
      // Expected
    }

    // Old entries should be cleaned (ZREMRANGEBYSCORE in the combined script)
    abuseCount = await redis.zcard(abuseKey);
    expect(abuseCount).toBe(1); // Only the most recent event
  }, 10_000);

  it('persists bucket state across guard instances (real Redis storage)', async () => {
    const { context } = mockContext({ ip: '10.0.0.6' });

    // Use 3 tokens with first guard instance
    for (let i = 0; i < 3; i++) {
      await guard.canActivate(context);
    }

    // Create a new guard instance (simulates app restart)
    const guard2 = await makeGuard(redis);

    // Should still have 2 tokens available (5 - 3 = 2)
    await expect(guard2.canActivate(context)).resolves.toBe(true);
    await expect(guard2.canActivate(context)).resolves.toBe(true);

    // Now bucket should be exhausted
    await expect(guard2.canActivate(context)).rejects.toThrow(HttpException);
  });

  it('bases refill on redis TIME, not on whichever node wrote the bucket — so a skewed node clock cannot desync accounting', async () => {
    // Simulates a bucket last written by a node with a clock 6 hours ahead of real time —
    // exactly the scenario a per-node Date.now() would get wrong (a "future" updatedAt makes
    // elapsed go negative, which the script clamps to 0 rather than granting phantom
    // refill). Seeded directly via HSET, standing in for a prior canActivate() call from
    // that skewed node — the guard/script never reads Date.now() itself, so this is the only
    // way clock skew could reach the calculation at all.
    const [seconds, micros] = await redis.time();
    const trueNowMs = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
    const fastNodeKey = 'ratelimit:{ip:10.0.0.7a:get:_test}:bucket';
    await redis.hset(
      fastNodeKey,
      'tokens',
      '0',
      'updatedAt',
      String(trueNowMs + 6 * 60 * 60 * 1000),
    );

    const { context: fastNodeContext } = mockContext({ ip: '10.0.0.7a' });
    await expect(guard.canActivate(fastNodeContext)).rejects.toThrow(HttpException);

    // And the inverse: a node 20 seconds *behind* real time. Real elapsed-since-write is
    // ~20s (duration=10s, capacity=5), so the script fully refills the bucket based on
    // Redis's real clock — a per-node Date.now() reading its own slow clock would instead
    // compute ~0 elapsed and refill nothing.
    const slowNodeKey = 'ratelimit:{ip:10.0.0.7b:get:_test}:bucket';
    await redis.hset(slowNodeKey, 'tokens', '0', 'updatedAt', String(trueNowMs - 20_000));

    const { context: slowNodeContext } = mockContext({ ip: '10.0.0.7b' });
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(slowNodeContext)).resolves.toBe(true);
    }
    await expect(guard.canActivate(slowNodeContext)).rejects.toThrow(HttpException);
  });

  it('consumes exactly `points` tokens under N concurrent requests (atomic per-call script)', async () => {
    const { context } = mockContext({ ip: '10.0.0.8' });
    const concurrentGuard = await makeGuard(redis, { points: 10, duration: 60 });

    const attempts = 25;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => concurrentGuard.canActivate(context)),
    );

    const allowed = results.filter(r => r.status === 'fulfilled').length;
    const rejected = results.filter(r => r.status === 'rejected').length;

    expect(allowed).toBe(10);
    expect(rejected).toBe(attempts - 10);
  });
});
