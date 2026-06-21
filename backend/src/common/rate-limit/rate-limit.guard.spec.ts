import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { HttpException, HttpStatus } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';
import { REDIS_CLIENT } from '../redis/redis.module';
import { SKIP_RATE_LIMIT, RATE_LIMIT_POINTS, RATE_LIMIT_DURATION } from './rate-limit.decorator';

function mockContext(overrides?: {
  skipRateLimit?: boolean;
  points?: number;
  duration?: number;
  ip?: string;
  url?: string;
  routePath?: string;
}) {
  const ip = overrides?.ip ?? '127.0.0.1';
  const url = overrides?.url ?? '/auth/challenge';
  const routePath = overrides?.routePath ?? '/auth/challenge';

  const handler = () => {};
  const cls = class Mock {};

  const context: any = {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({
        ip,
        url,
        route: { path: routePath },
        connection: { remoteAddress: '::1' },
      }),
    }),
  };

  const metadata: Record<string, any> = {};
  if (overrides?.skipRateLimit !== undefined) metadata[SKIP_RATE_LIMIT] = overrides.skipRateLimit;
  if (overrides?.points !== undefined) metadata[RATE_LIMIT_POINTS] = overrides.points;
  if (overrides?.duration !== undefined) metadata[RATE_LIMIT_DURATION] = overrides.duration;

  return { context, metadata };
}

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let mockRedis: any;

  beforeEach(async () => {
    mockRedis = {
      incr: jest.fn(),
      expire: jest.fn(),
      ttl: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        {
          provide: REDIS_CLIENT,
          useValue: mockRedis,
        },
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn((_key: string) => {
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('when Redis is not configured', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: null },
          {
            provide: Reflector,
            useValue: { getAllAndOverride: () => undefined },
          },
        ],
      }).compile();

      guard = module.get<RateLimitGuard>(RateLimitGuard);
    });

    it('should allow request when redis is null', async () => {
      const { context } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('when @SkipRateLimit is present', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: mockRedis },
          {
            provide: Reflector,
            useValue: {
              getAllAndOverride: (key: string) => {
                if (key === SKIP_RATE_LIMIT) return true;
                return undefined;
              },
            },
          },
        ],
      }).compile();

      guard = module.get<RateLimitGuard>(RateLimitGuard);
    });

    it('should allow request without checking Redis', async () => {
      const { context } = mockContext({ skipRateLimit: true });
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(mockRedis.incr).not.toHaveBeenCalled();
    });
  });

  describe('rate limit counting', () => {
    beforeEach(async () => {
      const reflector = {
        getAllAndOverride: (key: string) => {
          if (key === SKIP_RATE_LIMIT) return undefined;
          if (key === RATE_LIMIT_POINTS) return undefined;
          if (key === RATE_LIMIT_DURATION) return undefined;
          return undefined;
        },
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: mockRedis },
          { provide: Reflector, useValue: reflector },
        ],
      }).compile();

      guard = module.get<RateLimitGuard>(RateLimitGuard);
    });

    it('should allow first request within limit', async () => {
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1 as any);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(mockRedis.incr).toHaveBeenCalledTimes(1);
      expect(mockRedis.expire).toHaveBeenCalledTimes(1);
    });

    it('should allow request at exactly the limit', async () => {
      mockRedis.incr.mockResolvedValue(100);
      mockRedis.expire.mockResolvedValue(1 as any);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should throw 429 when limit exceeded', async () => {
      mockRedis.incr.mockResolvedValue(101);
      mockRedis.expire.mockResolvedValue(1 as any);
      mockRedis.ttl.mockResolvedValue(30 as any);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).rejects.toThrow(
        new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests — rate limit exceeded',
            retryAfter: 30,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
    });

    it('should request custom rate limit from reflector when set via decorator', async () => {
      const customReflector = {
        getAllAndOverride: (key: string) => {
          if (key === SKIP_RATE_LIMIT) return undefined;
          if (key === RATE_LIMIT_POINTS) return 10;
          if (key === RATE_LIMIT_DURATION) return 10;
          return undefined;
        },
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: mockRedis },
          { provide: Reflector, useValue: customReflector },
        ],
      }).compile();

      const customGuard = module.get<RateLimitGuard>(RateLimitGuard);
      mockRedis.incr.mockResolvedValue(11);
      mockRedis.ttl.mockResolvedValue(5 as any);

      const { context } = mockContext();
      await expect(customGuard.canActivate(context)).rejects.toThrow(HttpException);
    });

    it('should set expiry on first request', async () => {
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1 as any);

      const { context } = mockContext();
      await guard.canActivate(context);
      expect(mockRedis.expire).toHaveBeenCalledWith(expect.any(String), 60);
    });

    it('should not set expiry on subsequent requests', async () => {
      mockRedis.incr.mockResolvedValue(2);

      const { context } = mockContext();
      await guard.canActivate(context);
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });
  });
});
