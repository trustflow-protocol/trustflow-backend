import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { Redis } from 'ioredis';
import { RateLimitGuard } from './rate-limit.guard';
import { REDIS_CLIENT } from '../redis/redis.module';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Exercises RateLimitGuard's Lua scripts (TOKEN_BUCKET_SCRIPT, ABUSE_LOCKOUT_SCRIPT) against
 * a real Redis server instead of the mocked ioredis client the rest of rate-limit.guard.spec.ts
 * uses. This guards against behavior the mock can't faithfully reproduce: real Lua script
 * execution, real HMSET/HMGET/ZADD/ZCARD/ZREMRANGEBYSCORE operations, and real TTL/EXPIRE
 * semantics.
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
    getAllAndOverride: jest.fn((key: string) => {
      if (key === 'SKIP_RATE_LIMIT') return overrides?.skip;
      if (key === 'RATE_LIMIT_POINTS') return overrides?.points;
      if (key === 'RATE_LIMIT_DURATION') return overrides?.duration;
      return undefined;
    }),
  } as unknown as Reflector;
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: Reflector, useValue: createReflector({ points: 5, duration: 10 }) },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
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

  it('refills the bucket over time using real TOKEN_BUCKET_SCRIPT', async () => {
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
    // Lower the abuse threshold for faster testing
    process.env.RATE_LIMIT_ABUSE_THRESHOLD = '3';
    process.env.RATE_LIMIT_LOCKOUT_SECONDS = '5';

    const { context } = mockContext({ ip: '10.0.0.3' });

    // Exhaust the bucket
    for (let i = 0; i < 5; i++) {
      await guard.canActivate(context);
    }

    // Trigger 3 abuse events (bucket rejections)
    for (let i = 0; i < 3; i++) {
      try {
        await guard.canActivate(context);
      } catch (e) {
        // Expected rejection
      }
    }

    // Verify lockout key exists with TTL
    const lockoutKey = 'ratelimit:lockout:ip:10.0.0.3:get:_test';
    const lockoutTtl = await redis.ttl(lockoutKey);
    expect(lockoutTtl).toBeGreaterThan(0);
    expect(lockoutTtl).toBeLessThanOrEqual(5);

    // Verify abuse sorted set exists
    const abuseKey = 'ratelimit:abuse:ip:10.0.0.3:get:_test';
    const abuseCount = await redis.zcard(abuseKey);
    expect(abuseCount).toBeGreaterThanOrEqual(3);

    // New requests should be immediately rejected during lockout
    await expect(guard.canActivate(context)).rejects.toThrow(
      expect.objectContaining({
        message: expect.objectContaining({
          message: 'Too many requests - rate limit exceeded',
        }),
      }),
    );

    // Wait for lockout to expire
    await new Promise(resolve => setTimeout(resolve, 5500));

    // Should be able to make requests again (bucket refilled during lockout)
    await expect(guard.canActivate(context)).resolves.toBe(true);

    // Clean up env vars
    delete process.env.RATE_LIMIT_ABUSE_THRESHOLD;
    delete process.env.RATE_LIMIT_LOCKOUT_SECONDS;
  });

  it('enforces both IP and wallet buckets independently', async () => {
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
    process.env.RATE_LIMIT_ABUSE_WINDOW_SECONDS = '2'; // 2-second abuse window
    process.env.RATE_LIMIT_ABUSE_THRESHOLD = '10'; // High threshold so we don't lock out

    const { context } = mockContext({ ip: '10.0.0.5' });

    // Exhaust bucket
    for (let i = 0; i < 5; i++) {
      await guard.canActivate(context);
    }

    // Trigger 2 abuse events
    for (let i = 0; i < 2; i++) {
      try {
        await guard.canActivate(context);
      } catch (e) {
        // Expected
      }
    }

    const abuseKey = 'ratelimit:abuse:ip:10.0.0.5:get:_test';
    let abuseCount = await redis.zcard(abuseKey);
    expect(abuseCount).toBe(2);

    // Wait for abuse window to pass
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Trigger another abuse event — the script should clean up old entries
    try {
      await guard.canActivate(context);
    } catch (e) {
      // Expected
    }

    // Old entries should be cleaned (ZREMRANGEBYSCORE in ABUSE_LOCKOUT_SCRIPT)
    abuseCount = await redis.zcard(abuseKey);
    expect(abuseCount).toBe(1); // Only the most recent event

    delete process.env.RATE_LIMIT_ABUSE_WINDOW_SECONDS;
    delete process.env.RATE_LIMIT_ABUSE_THRESHOLD;
  });

  it('persists bucket state across guard instances (real Redis storage)', async () => {
    const { context } = mockContext({ ip: '10.0.0.6' });

    // Use 3 tokens with first guard instance
    for (let i = 0; i < 3; i++) {
      await guard.canActivate(context);
    }

    // Create a new guard instance (simulates app restart)
    const module2: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: Reflector, useValue: createReflector({ points: 5, duration: 10 }) },
      ],
    }).compile();
    const guard2 = module2.get<RateLimitGuard>(RateLimitGuard);

    // Should still have 2 tokens available (5 - 3 = 2)
    await expect(guard2.canActivate(context)).resolves.toBe(true);
    await expect(guard2.canActivate(context)).resolves.toBe(true);

    // Now bucket should be exhausted
    await expect(guard2.canActivate(context)).rejects.toThrow(HttpException);
  });
});
