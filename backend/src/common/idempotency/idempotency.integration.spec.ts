import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import request from 'supertest';
import { IdempotencyKeyInterceptor } from './idempotency-key.interceptor';
import { IdempotencyKeyService } from './idempotency-key.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { Idempotent } from './idempotency-key.decorator';

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

describe('Idempotency integration — gig-like endpoint', () => {
  let app: INestApplication;

  function setupRedisMock() {
    const store = new Map<string, string>();
    return {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, ..._args: unknown[]) => {
        store.set(key, value);
        return 'OK';
      }),
    };
  }

  beforeEach(async () => {
    const mockRedis = setupRedisMock();

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

  function setupRedisMock() {
    const store = new Map<string, string>();
    return {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, ..._args: unknown[]) => {
        store.set(key, value);
        return 'OK';
      }),
    };
  }

  beforeEach(async () => {
    const mockRedis = setupRedisMock();

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
