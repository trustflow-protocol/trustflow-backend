import { Controller, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector, APP_INTERCEPTOR } from '@nestjs/core';
import request from 'supertest';
import { IdempotencyKeyInterceptor } from './idempotency-key.interceptor';
import { IdempotencyKeyService } from './idempotency-key.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { Idempotent } from './idempotency-key.decorator';

@Controller('idempotency-test')
class IdempotencyTestController {
  @Post('idempotent')
  @Idempotent()
  create() {
    return { id: 'record-1', createdAt: new Date().toISOString() };
  }

  @Post('not-idempotent')
  createWithoutDecorator() {
    return { ok: true };
  }
}

describe('IdempotencyKeyInterceptor', () => {
  let interceptor: IdempotencyKeyInterceptor;
  let mockRedis: { get: jest.Mock; set: jest.Mock };

  beforeEach(() => {
    mockRedis = { get: jest.fn(), set: jest.fn() };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createInterceptor(redisOverride?: typeof mockRedis) {
    const service = new IdempotencyKeyService((redisOverride ?? null) as any);
    const reflector = new Reflector();
    return new IdempotencyKeyInterceptor(reflector, service);
  }

  describe('basic behaviour', () => {
    it('should be defined', () => {
      interceptor = createInterceptor();
      expect(interceptor).toBeDefined();
    });
  });

  describe('Supertest integration', () => {
    let app: INestApplication;
    let mockRedisFull: {
      get: jest.Mock;
      set: jest.Mock;
    };

    beforeEach(async () => {
      mockRedisFull = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      };

      const module: TestingModule = await Test.createTestingModule({
        controllers: [IdempotencyTestController],
        providers: [
          IdempotencyKeyService,
          { provide: REDIS_CLIENT, useValue: mockRedisFull },
          {
            provide: APP_INTERCEPTOR,
            useClass: IdempotencyKeyInterceptor,
          },
        ],
      }).compile();

      app = module.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('passes through when no Idempotency-Key header is present', async () => {
      const res = await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .send({ foo: 'bar' })
        .expect(201);

      expect(res.body).toHaveProperty('id', 'record-1');
      expect(mockRedisFull.get).not.toHaveBeenCalled();
      expect(mockRedisFull.set).not.toHaveBeenCalled();
    });

    it('caches the response and replays it on retry with the same key and body', async () => {
      const body = { foo: 'bar' };
      const idempotencyKey = 'test-uuid-123';

      const res1 = await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201);

      expect(res1.body).toHaveProperty('id', 'record-1');
      expect(mockRedisFull.set).toHaveBeenCalledTimes(1);

      const storedRecord = JSON.parse(mockRedisFull.set.mock.calls[0][1] as string);
      const cachedResponse = JSON.stringify(storedRecord);

      mockRedisFull.get.mockResolvedValueOnce(cachedResponse);

      const res2 = await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201);

      expect(res2.body).toEqual(res1.body);
    });

    it('returns 422 when the same key is reused with a different body', async () => {
      const idempotencyKey = 'test-uuid-456';

      await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', idempotencyKey)
        .send({ foo: 'bar' })
        .expect(201);

      expect(mockRedisFull.set).toHaveBeenCalledTimes(1);
      const storedRecord = JSON.parse(mockRedisFull.set.mock.calls[0][1] as string);

      mockRedisFull.get.mockResolvedValueOnce(JSON.stringify(storedRecord));

      const res2 = await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', idempotencyKey)
        .send({ foo: 'DIFFERENT' })
        .expect(422);

      expect(res2.body).toMatchObject({
        statusCode: 422,
        message: 'Idempotency key has already been used with a different request payload',
      });
    });

    it('ignores the header on endpoints without @Idempotent()', async () => {
      mockRedisFull.get.mockClear();
      mockRedisFull.set.mockClear();

      const res = await request(app.getHttpServer())
        .post('/idempotency-test/not-idempotent')
        .set('Idempotency-Key', 'any-key')
        .send({ x: 1 })
        .expect(201);

      expect(res.body).toHaveProperty('ok', true);
      expect(mockRedisFull.get).not.toHaveBeenCalled();
    });

    it('passes through gracefully when Redis is unavailable', async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [IdempotencyTestController],
        providers: [
          IdempotencyKeyService,
          { provide: REDIS_CLIENT, useValue: null },
          {
            provide: APP_INTERCEPTOR,
            useClass: IdempotencyKeyInterceptor,
          },
        ],
      }).compile();

      const nullApp = module.createNestApplication();
      await nullApp.init();

      const res = await request(nullApp.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', 'some-key')
        .send({ foo: 'bar' })
        .expect(201);

      expect(res.body).toHaveProperty('id', 'record-1');
      await nullApp.close();
    });
  });
});

describe('IdempotencyKeyService', () => {
  describe('hashBody', () => {
    it('produces a consistent hash for the same input', () => {
      const a = IdempotencyKeyService.hashBody({ x: 1, y: 2 });
      const b = IdempotencyKeyService.hashBody({ x: 1, y: 2 });
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });

    it('produces different hashes for different inputs', () => {
      const a = IdempotencyKeyService.hashBody({ x: 1 });
      const b = IdempotencyKeyService.hashBody({ x: 2 });
      expect(a).not.toBe(b);
    });

    it('handles null/undefined bodies', () => {
      const a = IdempotencyKeyService.hashBody(null);
      const b = IdempotencyKeyService.hashBody(undefined);
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });
  });

  describe('lookup', () => {
    it('returns null when Redis is unavailable', async () => {
      const service = new IdempotencyKeyService(null);
      await expect(service.lookup('endpoint', 'key')).resolves.toBeNull();
    });

    it('returns null when key does not exist in Redis', async () => {
      const mockRedis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
      const service = new IdempotencyKeyService(mockRedis as any);
      await expect(service.lookup('POST:/gigs', 'key-1')).resolves.toBeNull();
      expect(mockRedis.get).toHaveBeenCalledWith('idempotency:POST:/gigs:key-1');
    });

    it('parses and returns the record when found', async () => {
      const record = { requestHash: 'abc', statusCode: 201, body: { id: 'gig-1' } };
      const mockRedis = {
        get: jest.fn().mockResolvedValue(JSON.stringify(record)),
        set: jest.fn(),
      };
      const service = new IdempotencyKeyService(mockRedis as any);
      await expect(service.lookup('POST:/gigs', 'key-1')).resolves.toEqual(record);
    });

    it('returns null on Redis errors (graceful degradation)', async () => {
      const mockRedis = {
        get: jest.fn().mockRejectedValue(new Error('conn refused')),
        set: jest.fn(),
      };
      const service = new IdempotencyKeyService(mockRedis as any);
      await expect(service.lookup('endpoint', 'key')).resolves.toBeNull();
    });
  });

  describe('store', () => {
    it('no-ops when Redis is unavailable', async () => {
      const service = new IdempotencyKeyService(null);
      await expect(service.store('endpoint', 'key', 'hash', 201, {})).resolves.toBeUndefined();
    });

    it('stores the record with a TTL', async () => {
      const mockRedis = { get: jest.fn(), set: jest.fn().mockResolvedValue('OK') };
      const service = new IdempotencyKeyService(mockRedis as any);
      await service.store('POST:/gigs', 'key-1', 'hash-1', 201, { id: 'gig-1' }, 3600);

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const [key, value, exFlag, ttl] = mockRedis.set.mock.calls[0];
      expect(key).toBe('idempotency:POST:/gigs:key-1');
      const parsed = JSON.parse(value);
      expect(parsed).toEqual({ requestHash: 'hash-1', statusCode: 201, body: { id: 'gig-1' } });
      expect(exFlag).toBe('EX');
      expect(ttl).toBe(3600);
    });

    it('does not throw on Redis errors (graceful degradation)', async () => {
      const mockRedis = { get: jest.fn(), set: jest.fn().mockRejectedValue(new Error('fail')) };
      const service = new IdempotencyKeyService(mockRedis as any);
      await expect(service.store('endpoint', 'key', 'hash', 201, {})).resolves.toBeUndefined();
    });
  });
});
