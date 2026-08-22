import { Controller, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector, APP_INTERCEPTOR } from '@nestjs/core';
import request from 'supertest';
import { IdempotencyKeyInterceptor } from './idempotency-key.interceptor';
import { IdempotencyKeyService } from './idempotency-key.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { Idempotent } from './idempotency-key.decorator';

/** In-memory Redis stand-in that honours `SET key value EX ttl NX` semantics. */
function createRedisMock() {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
  };
}

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

  function createInterceptor(redisOverride?: ReturnType<typeof createRedisMock> | null) {
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
    let mockRedisFull: ReturnType<typeof createRedisMock>;

    beforeEach(async () => {
      mockRedisFull = createRedisMock();

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

    it('claims, executes, and finalizes on first use, then replays the cached response on retry', async () => {
      const body = { foo: 'bar' };
      const idempotencyKey = 'test-uuid-123';

      const res1 = await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201);

      expect(res1.body).toHaveProperty('id', 'record-1');
      // One SET to claim (pending, NX) and one SET to finalize (completed).
      expect(mockRedisFull.set).toHaveBeenCalledTimes(2);

      const claimCall = mockRedisFull.set.mock.calls[0];
      expect(claimCall[2]).toBe('EX');
      expect(claimCall[4]).toBe('NX');
      const pendingRecord = JSON.parse(claimCall[1] as string);
      expect(pendingRecord).toMatchObject({ status: 'pending' });

      const finalizeCall = mockRedisFull.set.mock.calls[1];
      const completedRecord = JSON.parse(finalizeCall[1] as string);
      expect(completedRecord).toMatchObject({
        status: 'completed',
        statusCode: 201,
        body: res1.body,
      });

      const res2 = await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201);

      expect(res2.body).toEqual(res1.body);
      // The retry attempts an SET NX claim (which fails, since the key is
      // already taken) but never overwrites the stored completed record.
      expect(mockRedisFull.set).toHaveBeenCalledTimes(3);
      const retryClaimAttempt = mockRedisFull.set.mock.results[2];
      await expect(retryClaimAttempt.value).resolves.toBeNull();
    });

    it('returns 422 when the same key is reused with a different body', async () => {
      const idempotencyKey = 'test-uuid-456';

      await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', idempotencyKey)
        .send({ foo: 'bar' })
        .expect(201);

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

    it('returns 409 when a duplicate request arrives while the original is still pending', async () => {
      const idempotencyKey = 'test-uuid-pending';

      // Simulate a claim made by a request that hasn't finished yet: write
      // only the pending record, without ever finalizing it.
      await mockRedisFull.set(
        'idempotency:POST:/idempotency-test/idempotent:test-uuid-pending',
        JSON.stringify({
          version: 1,
          requestHash: IdempotencyKeyService.hashBody({ foo: 'bar' }),
          status: 'pending',
        }),
        'EX',
        3600,
        'NX',
      );

      const res = await request(app.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', idempotencyKey)
        .send({ foo: 'bar' })
        .expect(409);

      expect(res.body).toMatchObject({
        statusCode: 409,
        message: 'A request with this idempotency key is already being processed',
      });
    });

    it('ignores the header on endpoints without @Idempotent()', async () => {
      const res = await request(app.getHttpServer())
        .post('/idempotency-test/not-idempotent')
        .set('Idempotency-Key', 'any-key')
        .send({ x: 1 })
        .expect(201);

      expect(res.body).toHaveProperty('ok', true);
      expect(mockRedisFull.get).not.toHaveBeenCalled();
    });

    it('passes through gracefully when Redis is unavailable (null client)', async () => {
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

    it('passes through gracefully when Redis throws connection errors', async () => {
      const flakyRedis = {
        get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        del: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      };

      const module: TestingModule = await Test.createTestingModule({
        controllers: [IdempotencyTestController],
        providers: [
          IdempotencyKeyService,
          { provide: REDIS_CLIENT, useValue: flakyRedis },
          {
            provide: APP_INTERCEPTOR,
            useClass: IdempotencyKeyInterceptor,
          },
        ],
      }).compile();

      const flakyApp = module.createNestApplication();
      await flakyApp.init();

      const res = await request(flakyApp.getHttpServer())
        .post('/idempotency-test/idempotent')
        .set('Idempotency-Key', 'some-key')
        .send({ foo: 'bar' })
        .expect(201);

      expect(res.body).toHaveProperty('id', 'record-1');
      expect(flakyRedis.set).toHaveBeenCalled();
      await flakyApp.close();
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

  describe('claim', () => {
    it('claims immediately when Redis is unavailable (graceful degradation)', async () => {
      const service = new IdempotencyKeyService(null);
      await expect(service.claim('endpoint', 'key', 'hash')).resolves.toEqual({ claimed: true });
    });

    it('claims when the key does not exist yet, using SET NX', async () => {
      const mockRedis = createRedisMock();
      const service = new IdempotencyKeyService(mockRedis as any);
      await expect(service.claim('POST:/gigs', 'key-1', 'hash-1')).resolves.toEqual({
        claimed: true,
      });
      expect(mockRedis.set).toHaveBeenCalledWith(
        'idempotency:POST:/gigs:key-1',
        expect.any(String),
        'EX',
        expect.any(Number),
        'NX',
      );
    });

    it('returns the existing record and claimed: false when the key is already taken', async () => {
      const mockRedis = createRedisMock();
      const service = new IdempotencyKeyService(mockRedis as any);
      await service.claim('POST:/gigs', 'key-1', 'hash-1');

      const second = await service.claim('POST:/gigs', 'key-1', 'hash-1');
      expect(second.claimed).toBe(false);
      if (!second.claimed) {
        expect(second.record).toMatchObject({ status: 'pending', requestHash: 'hash-1' });
      }
    });

    it('degrades to claimed: true on Redis errors', async () => {
      const mockRedis = {
        get: jest.fn(),
        set: jest.fn().mockRejectedValue(new Error('conn refused')),
      };
      const service = new IdempotencyKeyService(mockRedis as any);
      await expect(service.claim('endpoint', 'key', 'hash')).resolves.toEqual({ claimed: true });
    });
  });

  describe('finalize', () => {
    it('no-ops when Redis is unavailable', async () => {
      const service = new IdempotencyKeyService(null);
      await expect(service.finalize('endpoint', 'key', 'hash', 201, {})).resolves.toBeUndefined();
    });

    it('stores the completed record with a TTL', async () => {
      const mockRedis = createRedisMock();
      const service = new IdempotencyKeyService(mockRedis as any);
      await service.finalize('POST:/gigs', 'key-1', 'hash-1', 201, { id: 'gig-1' }, {}, 3600);

      const [key, value, exFlag, ttl] = mockRedis.set.mock.calls[0];
      expect(key).toBe('idempotency:POST:/gigs:key-1');
      expect(ttl).toBe(3600);
      expect(exFlag).toBe('EX');
      const parsed = JSON.parse(value);
      expect(parsed).toMatchObject({
        requestHash: 'hash-1',
        status: 'completed',
        statusCode: 201,
        body: { id: 'gig-1' },
      });
    });

    it('does not throw on Redis errors (graceful degradation)', async () => {
      const mockRedis = { get: jest.fn(), set: jest.fn().mockRejectedValue(new Error('fail')) };
      const service = new IdempotencyKeyService(mockRedis as any);
      await expect(service.finalize('endpoint', 'key', 'hash', 201, {})).resolves.toBeUndefined();
    });
  });

  describe('release', () => {
    it('no-ops when Redis is unavailable', async () => {
      const service = new IdempotencyKeyService(null);
      await expect(service.release('endpoint', 'key')).resolves.toBeUndefined();
    });

    it('deletes the claimed key', async () => {
      const mockRedis = createRedisMock();
      const service = new IdempotencyKeyService(mockRedis as any);
      await service.claim('POST:/gigs', 'key-1', 'hash-1');
      await service.release('POST:/gigs', 'key-1');

      const second = await service.claim('POST:/gigs', 'key-1', 'hash-1');
      expect(second.claimed).toBe(true);
    });

    it('does not throw on Redis errors (graceful degradation)', async () => {
      const mockRedis = { get: jest.fn(), del: jest.fn().mockRejectedValue(new Error('fail')) };
      const service = new IdempotencyKeyService(mockRedis as any);
      await expect(service.release('endpoint', 'key')).resolves.toBeUndefined();
    });
  });
});
