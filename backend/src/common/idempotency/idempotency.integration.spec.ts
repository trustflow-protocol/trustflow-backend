import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
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

/**
 * Simulates the POST /gigs and POST /escrows controllers with idempotency
 * wired end-to-end through the global interceptor.
 */
@Controller('test-gigs')
class FakeGigController {
  private counter = 0;

  @Post()
  @Idempotent()
  create(@Body() dto: { creator: string; title: string; budgetXLM: string }) {
    return {
      id: `gig-${++this.counter}`,
      ...dto,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
  }
}

@Controller('test-escrows')
class FakeEscrowController {
  private counter = 0;

  @Post()
  @Idempotent()
  create(@Body() dto: { depositor: string; beneficiary: string; amountXLM: string }) {
    return {
      id: `esc-${++this.counter}`,
      ...dto,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  }
}

/** Slow controller used to exercise the concurrent-request race. */
@Controller('test-slow')
class FakeSlowCreateController {
  private counter = 0;

  @Post()
  @Idempotent()
  async create(@Body() dto: { title: string }) {
    await new Promise(resolve => setTimeout(resolve, 25));
    return { id: `slow-${++this.counter}`, ...dto };
  }
}

describe('Idempotency integration — gig-like endpoint', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const mockRedis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FakeGigController],
      providers: [
        IdempotencyKeyService,
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyKeyInterceptor },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const gigBody = {
    creator: 'GABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    title: 'Build an audit report',
    budgetXLM: '250',
  };

  it('creates only one record when the same request is sent twice with the same Idempotency-Key', async () => {
    const key = 'gig-idem-uuid-001';

    const res1 = await request(app.getHttpServer())
      .post('/test-gigs')
      .set('Idempotency-Key', key)
      .send(gigBody)
      .expect(201);

    const res2 = await request(app.getHttpServer())
      .post('/test-gigs')
      .set('Idempotency-Key', key)
      .send(gigBody)
      .expect(201);

    expect(res1.body.id).toBe('gig-1');
    expect(res2.body).toEqual(res1.body);
  });

  it('returns 422 when the same key is used with a different body', async () => {
    const key = 'gig-idem-uuid-002';

    await request(app.getHttpServer())
      .post('/test-gigs')
      .set('Idempotency-Key', key)
      .send(gigBody)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/test-gigs')
      .set('Idempotency-Key', key)
      .send({ ...gigBody, title: 'DIFFERENT TITLE' })
      .expect(422);

    expect(res.body.message).toContain('different request payload');
  });

  it('creates separate records when no Idempotency-Key is provided', async () => {
    const res1 = await request(app.getHttpServer()).post('/test-gigs').send(gigBody).expect(201);

    const res2 = await request(app.getHttpServer()).post('/test-gigs').send(gigBody).expect(201);

    expect(res1.body.id).toBe('gig-1');
    expect(res2.body.id).toBe('gig-2');
  });
});

describe('Idempotency integration — escrow-like endpoint', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const mockRedis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FakeEscrowController],
      providers: [
        IdempotencyKeyService,
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyKeyInterceptor },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const escrowBody = {
    depositor: 'GDEP0001234567890DEP0001234567890DEP0001234567890DEP0001',
    beneficiary: 'GBEN0001234567890BEN0001234567890BEN0001234567890BEN0001',
    amountXLM: '100',
  };

  it('creates only one record when the same request is sent twice with the same Idempotency-Key', async () => {
    const key = 'esc-idem-uuid-001';

    const res1 = await request(app.getHttpServer())
      .post('/test-escrows')
      .set('Idempotency-Key', key)
      .send(escrowBody)
      .expect(201);

    const res2 = await request(app.getHttpServer())
      .post('/test-escrows')
      .set('Idempotency-Key', key)
      .send(escrowBody)
      .expect(201);

    expect(res1.body.id).toBe('esc-1');
    expect(res2.body).toEqual(res1.body);
  });

  it('returns 422 when the same key is used with a different body', async () => {
    const key = 'esc-idem-uuid-002';

    await request(app.getHttpServer())
      .post('/test-escrows')
      .set('Idempotency-Key', key)
      .send(escrowBody)
      .expect(201);

    await request(app.getHttpServer())
      .post('/test-escrows')
      .set('Idempotency-Key', key)
      .send({ ...escrowBody, amountXLM: '999' })
      .expect(422);
  });

  it('creates separate records when no Idempotency-Key is provided', async () => {
    const res1 = await request(app.getHttpServer())
      .post('/test-escrows')
      .send(escrowBody)
      .expect(201);

    const res2 = await request(app.getHttpServer())
      .post('/test-escrows')
      .send(escrowBody)
      .expect(201);

    expect(res1.body.id).toBe('esc-1');
    expect(res2.body.id).toBe('esc-2');
  });
});

describe('Idempotency integration — cross-endpoint key namespacing', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const mockRedis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FakeGigController, FakeEscrowController],
      providers: [
        IdempotencyKeyService,
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyKeyInterceptor },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('does not let the same Idempotency-Key collide across different endpoints', async () => {
    const sharedKey = 'shared-key-across-endpoints';

    const gigRes = await request(app.getHttpServer())
      .post('/test-gigs')
      .set('Idempotency-Key', sharedKey)
      .send({
        creator: 'GABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF01',
        title: 'Gig using shared key',
        budgetXLM: '250',
      })
      .expect(201);

    const escrowRes = await request(app.getHttpServer())
      .post('/test-escrows')
      .set('Idempotency-Key', sharedKey)
      .send({
        depositor: 'GDEP0001234567890DEP0001234567890DEP0001234567890DEP0001',
        beneficiary: 'GBEN0001234567890BEN0001234567890BEN0001234567890BEN0001',
        amountXLM: '100',
      })
      .expect(201);

    // Neither request was rejected as a "different payload" reuse, and each
    // hit its own handler (distinct id prefixes), proving the cache key is
    // scoped per (method, route), not just per Idempotency-Key value.
    expect(gigRes.body.id).toBe('gig-1');
    expect(escrowRes.body.id).toBe('esc-1');
  });
});

describe('Idempotency integration — concurrent duplicate requests', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const mockRedis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FakeSlowCreateController],
      providers: [
        IdempotencyKeyService,
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyKeyInterceptor },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates exactly one resource when N identical requests race on the same key', async () => {
    const key = 'race-key-001';
    const body = { title: 'racey request' };
    const concurrency = 8;

    const responses = await Promise.all(
      Array.from({ length: concurrency }, () =>
        request(app.getHttpServer()).post('/test-slow').set('Idempotency-Key', key).send(body),
      ),
    );

    const created = responses.filter(r => r.status === 201);
    const conflicted = responses.filter(r => r.status === 409);

    // Exactly one request wins the atomic claim and actually runs the handler.
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(concurrency - 1);
    expect(created[0].body.id).toBe('slow-1');

    // Once the winner finishes, a later retry replays the cached result
    // instead of creating a second resource.
    const retry = await request(app.getHttpServer())
      .post('/test-slow')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(retry.body).toEqual(created[0].body);
  });
});
