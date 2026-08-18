import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GigService, GIG_PERSISTENCE_FALLBACK_METRIC } from './gig.service';
import { GigStatus } from './gig.entity';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';

/** Mirrors ioredis: MULTI/EXEC resolves an array of [error, result] tuples per queued command. */
function makeInMemoryRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  /** When set, the next MULTI's exec() returns this instead of the computed op results. */
  let nextExecOverride: (() => Promise<Array<[Error | null, unknown]> | null>) | null = null;

  const client = {
    mockNextExecResult(fn: () => Promise<Array<[Error | null, unknown]> | null>) {
      nextExecOverride = fn;
    },
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    mget: jest.fn(async (...keys: string[]) => keys.map(k => store.get(k) ?? null)),
    smembers: jest.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    zrange: jest.fn(async (key: string) => {
      const z = zsets.get(key) ?? new Map();
      return [...z.entries()].sort((a, b) => a[1] - b[1]).map(([member]) => member);
    }),
    zrangebyscore: jest.fn(async (key: string, min: number, max: number) => {
      const z = zsets.get(key) ?? new Map();
      return [...z.entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    }),
    multi: jest.fn(() => {
      const ops: Array<() => [Error | null, unknown]> = [];
      const chain = {
        set: (key: string, value: string) => {
          ops.push(() => {
            store.set(key, value);
            return [null, 'OK'];
          });
          return chain;
        },
        zadd: (key: string, score: number, member: string) => {
          ops.push(() => {
            if (!zsets.has(key)) zsets.set(key, new Map());
            zsets.get(key)!.set(member, score);
            return [null, 1];
          });
          return chain;
        },
        zrem: (key: string, member: string) => {
          ops.push(() => {
            zsets.get(key)?.delete(member);
            return [null, 1];
          });
          return chain;
        },
        sadd: (key: string, member: string) => {
          ops.push(() => {
            if (!sets.has(key)) sets.set(key, new Set());
            sets.get(key)!.add(member);
            return [null, 1];
          });
          return chain;
        },
        exec: async () => {
          if (nextExecOverride) {
            const fn = nextExecOverride;
            nextExecOverride = null;
            return fn();
          }
          return ops.map(op => op());
        },
      };
      return chain;
    }),
  };

  return client;
}

describe('GigService', () => {
  let service: GigService;
  let metrics: jest.Mocked<Pick<MetricsService, 'increment'>>;

  const validDto = {
    creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    title: 'Build a Soroban escrow audit report',
    budgetXLM: '250',
  };

  async function buildService(redis: unknown): Promise<GigService> {
    metrics = { increment: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GigService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    return module.get<GigService>(GigService);
  }

  describe.each([
    ['with Redis', () => makeInMemoryRedis()],
    ['without Redis (fallback to memory)', () => null],
  ])('%s', (_label, makeRedis) => {
    beforeEach(async () => {
      service = await buildService(makeRedis());
    });

    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    describe('create', () => {
      it('creates an open gig with a default 72h response deadline', async () => {
        const before = Date.now();
        const gig = await service.create(validDto);

        expect(gig.id).toBeDefined();
        expect(gig.creator).toBe(validDto.creator);
        expect(gig.title).toBe(validDto.title);
        expect(gig.budgetXLM).toBe(validDto.budgetXLM);
        expect(gig.status).toBe(GigStatus.OPEN);

        const expectedRespondBy = before + 72 * 60 * 60 * 1000;
        expect(new Date(gig.respondBy).getTime()).toBeGreaterThanOrEqual(expectedRespondBy - 1000);
      });

      it('honors a custom responseWindowHours', async () => {
        const gig = await service.create({ ...validDto, responseWindowHours: 1 });
        const createdAt = new Date(gig.createdAt).getTime();
        const respondBy = new Date(gig.respondBy).getTime();
        expect(respondBy - createdAt).toBe(60 * 60 * 1000);
      });
    });

    describe('findById', () => {
      it('throws NotFoundException for an unknown id', async () => {
        await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
      });

      it('returns the gig when it exists', async () => {
        const created = await service.create(validDto);
        expect(await service.findById(created.id)).toEqual(created);
      });
    });

    describe('findByCreator', () => {
      it('returns only gigs posted by the given creator', async () => {
        const gig = await service.create(validDto);
        await service.create({
          ...validDto,
          creator: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        });

        const results = await service.findByCreator(validDto.creator);
        expect(results).toEqual([gig]);
      });
    });

    describe('findExpirable', () => {
      it('excludes gigs whose response deadline has not passed', async () => {
        await service.create(validDto);
        expect(await service.findExpirable()).toEqual([]);
      });

      it('includes only OPEN gigs whose response deadline has passed', async () => {
        const gig = await service.create({ ...validDto, responseWindowHours: 1 });
        const future = new Date(Date.now() + 2 * 60 * 60 * 1000);

        expect(await service.findExpirable(future)).toEqual([gig]);
      });

      it('excludes gigs that are no longer OPEN even if their deadline passed', async () => {
        const gig = await service.create({ ...validDto, responseWindowHours: 1 });
        await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');
        const future = new Date(Date.now() + 2 * 60 * 60 * 1000);

        expect(await service.findExpirable(future)).toEqual([]);
      });
    });

    describe('accept', () => {
      it('marks an open gig as accepted', async () => {
        const gig = await service.create(validDto);
        const responder = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';

        const accepted = await service.accept(gig.id, responder);

        expect(accepted.status).toBe(GigStatus.ACCEPTED);
        expect(accepted.acceptedBy).toBe(responder);
        expect(accepted.acceptedAt).toBeDefined();
      });

      it('throws when the gig is not open', async () => {
        const gig = await service.create(validDto);
        await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

        await expect(
          service.accept(gig.id, 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('cancel', () => {
      it('marks an open gig as cancelled', async () => {
        const gig = await service.create(validDto);
        const cancelled = await service.cancel(gig.id);

        expect(cancelled.status).toBe(GigStatus.CANCELLED);
        expect(cancelled.cancelledAt).toBeDefined();
      });

      it('throws when the gig is not open', async () => {
        const gig = await service.create(validDto);
        await service.cancel(gig.id);

        await expect(service.cancel(gig.id)).rejects.toThrow(BadRequestException);
      });
    });

    describe('expire', () => {
      it('marks an open gig as expired', async () => {
        const gig = await service.create(validDto);
        const expired = await service.expire(gig.id);

        expect(expired?.status).toBe(GigStatus.EXPIRED);
        expect(expired?.expiredAt).toBeDefined();
      });

      it('is a no-op for a gig that is already resolved', async () => {
        const gig = await service.create(validDto);
        await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

        expect(await service.expire(gig.id)).toBeUndefined();
        expect((await service.findById(gig.id)).status).toBe(GigStatus.ACCEPTED);
      });

      it('is a no-op for an unknown id', async () => {
        expect(await service.expire('missing')).toBeUndefined();
      });
    });
  });

  describe('Redis failure', () => {
    it('falls back to memory and records the fallback metric when Redis throws', async () => {
      const redis = makeInMemoryRedis();
      redis.get.mockRejectedValue(new Error('Redis down'));
      redis.multi.mockImplementation(() => {
        throw new Error('Redis down');
      });
      service = await buildService(redis);

      const gig = await service.create(validDto);

      expect(gig.status).toBe(GigStatus.OPEN);
      expect(metrics.increment).toHaveBeenCalledWith(GIG_PERSISTENCE_FALLBACK_METRIC, {
        operation: 'create',
      });
    });

    it('falls back to memory when a queued MULTI command fails without exec() itself rejecting', async () => {
      const redis = makeInMemoryRedis();
      redis.mockNextExecResult(async () => [
        [null, 'OK'],
        [new Error('WRONGTYPE'), null],
      ]);
      service = await buildService(redis);

      const gig = await service.create(validDto);

      expect(gig.status).toBe(GigStatus.OPEN);
      expect(metrics.increment).toHaveBeenCalledWith(GIG_PERSISTENCE_FALLBACK_METRIC, {
        operation: 'create',
      });
    });

    it('falls back to memory when exec() resolves null (e.g. an aborted WATCH)', async () => {
      const redis = makeInMemoryRedis();
      redis.mockNextExecResult(async () => null);
      service = await buildService(redis);

      const gig = await service.create(validDto);

      expect(gig.status).toBe(GigStatus.OPEN);
      expect(metrics.increment).toHaveBeenCalledWith(GIG_PERSISTENCE_FALLBACK_METRIC, {
        operation: 'create',
      });
    });
  });

  describe('onModuleInit', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('throws in production when Redis is not configured', async () => {
      process.env.NODE_ENV = 'production';
      service = await buildService(null);

      expect(() => service.onModuleInit()).toThrow(/requires REDIS_URL/);
    });

    it('does not throw in production when Redis is configured', async () => {
      process.env.NODE_ENV = 'production';
      service = await buildService(makeInMemoryRedis());

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('does not throw outside production even without Redis', async () => {
      process.env.NODE_ENV = 'test';
      service = await buildService(null);

      expect(() => service.onModuleInit()).not.toThrow();
    });
  });
});
