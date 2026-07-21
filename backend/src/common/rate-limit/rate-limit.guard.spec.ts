import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector, APP_GUARD } from '@nestjs/core';
import { HttpException, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { RateLimitGuard } from './rate-limit.guard';
import { REDIS_CLIENT } from '../redis/redis.module';
import { SKIP_RATE_LIMIT, RATE_LIMIT_POINTS, RATE_LIMIT_DURATION } from './rate-limit.decorator';

function mockContext(overrides?: {
  ip?: string;
  method?: string;
  url?: string;
  routePath?: string;
  user?: Record<string, string>;
  body?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;
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
        method: overrides?.method ?? 'GET',
        url,
        route: { path: routePath },
        headers: {},
        connection: { remoteAddress: '::1' },
        user: overrides?.user,
        body: overrides?.body,
        query: overrides?.query,
        params: overrides?.params,
      }),
    }),
  };

  return { context };
}

function createRedisMock() {
  return {
    ttl: jest.fn(),
    eval: jest.fn(),
    zremrangebyscore: jest.fn(),
    zadd: jest.fn(),
    expire: jest.fn(),
    zcard: jest.fn(),
    set: jest.fn(),
  };
}

function createReflector(overrides?: { skip?: boolean; points?: number; duration?: number }) {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === SKIP_RATE_LIMIT) return overrides?.skip;
      if (key === RATE_LIMIT_POINTS) return overrides?.points;
      if (key === RATE_LIMIT_DURATION) return overrides?.duration;
      return undefined;
    }),
  };
}

@Controller('rate-limit-test')
class RateLimitTestController {
  @Get('limited')
  getLimited() {
    return { ok: true };
  }

  @Post('wallet')
  postWallet() {
    return { ok: true };
  }
}

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let mockRedis: ReturnType<typeof createRedisMock>;

  beforeEach(async () => {
    mockRedis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        {
          provide: REDIS_CLIENT,
          useValue: mockRedis,
        },
        {
          provide: Reflector,
          useValue: createReflector(),
        },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RATE_LIMIT_ABUSE_THRESHOLD;
    delete process.env.RATE_LIMIT_ABUSE_WINDOW_SECONDS;
    delete process.env.RATE_LIMIT_LOCKOUT_SECONDS;
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
            useValue: createReflector(),
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
            useValue: createReflector({ skip: true }),
          },
        ],
      }).compile();

      guard = module.get<RateLimitGuard>(RateLimitGuard);
    });

    it('should allow request without checking Redis', async () => {
      const { context } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  describe('distributed token bucket', () => {
    it('should allow a request when the Redis bucket has tokens', async () => {
      mockRedis.ttl.mockResolvedValue(0);
      mockRedis.eval.mockResolvedValue([1, 99, 0]);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(mockRedis.ttl).toHaveBeenCalledWith(
        'ratelimit:lockout:ip:127.0.0.1:get:_auth_challenge',
      );
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call'),
        1,
        'ratelimit:bucket:ip:127.0.0.1:get:_auth_challenge',
        100,
        60_000,
        expect.any(Number),
        120_000,
      );
    });

    it('should apply custom decorator values to bucket capacity and refill duration', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimitGuard,
          { provide: REDIS_CLIENT, useValue: mockRedis },
          { provide: Reflector, useValue: createReflector({ points: 10, duration: 5 }) },
        ],
      }).compile();
      const customGuard = module.get<RateLimitGuard>(RateLimitGuard);

      mockRedis.ttl.mockResolvedValue(0);
      mockRedis.eval.mockResolvedValue([1, 9, 0]);

      const { context } = mockContext();
      await expect(customGuard.canActivate(context)).resolves.toBe(true);
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        expect.any(String),
        10,
        5_000,
        expect.any(Number),
        10_000,
      );
    });

    it('should enforce wallet and IP buckets when wallet identity is present', async () => {
      mockRedis.ttl.mockResolvedValue(0);
      mockRedis.eval.mockResolvedValue([1, 99, 0]);

      const { context } = mockContext({ user: { address: 'GABC123' } });
      await expect(guard.canActivate(context)).resolves.toBe(true);

      expect(mockRedis.eval).toHaveBeenCalledTimes(2);
      expect(mockRedis.eval).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        1,
        'ratelimit:bucket:wallet:gabc123:get:_auth_challenge',
        100,
        60_000,
        expect.any(Number),
        120_000,
      );
    });

    it('should throw 429 and record abuse when the bucket is empty', async () => {
      mockRedis.ttl.mockResolvedValue(0);
      mockRedis.eval.mockResolvedValueOnce([0, 0, 12]).mockResolvedValueOnce(0);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).rejects.toThrow(
        new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests - rate limit exceeded',
            retryAfter: 12,
            scope: 'ip:127.0.0.1',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
      expect(mockRedis.eval).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('ZREMRANGEBYSCORE'),
        2,
        'ratelimit:abuse:ip:127.0.0.1:get:_auth_challenge',
        'ratelimit:lockout:ip:127.0.0.1:get:_auth_challenge',
        expect.any(Number),
        300_000,
        300,
        5,
        900,
        expect.any(String),
      );
    });

    it('should lock out identities after repeated empty-bucket attempts', async () => {
      process.env.RATE_LIMIT_ABUSE_THRESHOLD = '2';
      process.env.RATE_LIMIT_LOCKOUT_SECONDS = '30';
      mockRedis.ttl.mockResolvedValue(0);
      mockRedis.eval.mockResolvedValueOnce([0, 0, 12]).mockResolvedValueOnce(30);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).rejects.toThrow(
        new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests - rate limit exceeded',
            retryAfter: 30,
            scope: 'ip:127.0.0.1',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
      expect(mockRedis.eval).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('SET'),
        2,
        'ratelimit:abuse:ip:127.0.0.1:get:_auth_challenge',
        'ratelimit:lockout:ip:127.0.0.1:get:_auth_challenge',
        expect.any(Number),
        300_000,
        300,
        2,
        30,
        expect.any(String),
      );
    });

    it('should reject immediately while a lockout key exists', async () => {
      mockRedis.ttl.mockResolvedValue(45);

      const { context } = mockContext();
      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);

      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });
});

describe('RateLimitGuard Supertest integration', () => {
  let app: INestApplication;
  let mockRedis: ReturnType<typeof createRedisMock>;

  beforeEach(async () => {
    mockRedis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RateLimitTestController],
      providers: [
        { provide: REDIS_CLIENT, useValue: mockRedis },
        {
          provide: APP_GUARD,
          useClass: RateLimitGuard,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('should allow HTTP requests while shared Redis bucket allows them', async () => {
    mockRedis.ttl.mockResolvedValue(0);
    mockRedis.eval.mockResolvedValue([1, 99, 0]);

    await request(app.getHttpServer()).get('/rate-limit-test/limited').expect(200, { ok: true });
  });

  it('should return 429 with retry details when shared Redis bucket rejects', async () => {
    mockRedis.ttl.mockResolvedValue(0);
    mockRedis.eval.mockResolvedValueOnce([0, 0, 7]).mockResolvedValueOnce(0);

    const response = await request(app.getHttpServer()).get('/rate-limit-test/limited').expect(429);

    expect(response.body).toMatchObject({
      statusCode: 429,
      message: 'Too many requests - rate limit exceeded',
      retryAfter: 7,
      scope: expect.stringMatching(/^ip:/),
    });
  });

  it('should evaluate both per-IP and per-wallet buckets for wallet requests', async () => {
    mockRedis.ttl.mockResolvedValue(0);
    mockRedis.eval.mockResolvedValue([1, 99, 0]);

    await request(app.getHttpServer())
      .post('/rate-limit-test/wallet')
      .send({ walletAddress: 'GABC123' })
      .expect(201, { ok: true });

    expect(mockRedis.eval).toHaveBeenCalledTimes(2);
    expect(mockRedis.eval).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      1,
      expect.stringContaining('ratelimit:bucket:wallet:gabc123'),
      100,
      60_000,
      expect.any(Number),
      120_000,
    );
  });
});
