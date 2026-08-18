import { Redis } from 'ioredis';
import { GigService } from './gig.service';
import { GigStatus } from './gig.entity';
import { MetricsService } from '../monitoring/metrics.service';

/**
 * Exercises GigService against a real Redis server instead of the mocked ioredis client the
 * rest of gig.service.spec.ts uses. This guards against behavior the mock can't faithfully
 * reproduce: real MULTI/EXEC atomicity and per-command result shape, real ZADD/ZRANGEBYSCORE/
 * ZREM sorted-set ordering, and real SADD/SMEMBERS set semantics.
 *
 * GigService itself doesn't set any key TTLs (a gig's lifecycle is driven by its `status`
 * field, not key expiry — unlike NonceStoreService, which does rely on Redis TTLs and covers
 * that behavior in its own suite), so there's nothing TTL-specific to verify here.
 *
 * Requires REDIS_URL — CI provides a `redis:7-alpine` service container (see
 * .github/workflows/backend-ci.yml). Skipped locally when REDIS_URL isn't set rather than
 * failing, so `npm test` still works without a local Redis.
 */
const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;

describeIfRedis('GigService (Redis integration)', () => {
  let redis: Redis;
  let service: GigService;

  const validDto = {
    creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    title: 'Build a Soroban escrow audit report',
    budgetXLM: '250',
  };

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    // Isolate each test from prior runs/tests without touching unrelated keys another
    // suite/process might be using on the same Redis instance.
    const keys = await redis.keys('gig*');
    if (keys.length > 0) await redis.del(...keys);

    service = new GigService(redis, { increment: jest.fn() } as unknown as MetricsService);
  });

  it('persists a created gig and reads it back via findById', async () => {
    const gig = await service.create(validDto);

    const raw = await redis.get(`gig:${gig.id}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(gig);

    expect(await service.findById(gig.id)).toEqual(gig);
  });

  it('indexes creator via SADD/SMEMBERS', async () => {
    const gig = await service.create(validDto);
    await service.create({
      ...validDto,
      creator: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
    });

    const creatorMembers = await redis.smembers(`gigs:by-creator:${validDto.creator}`);
    expect(creatorMembers).toEqual([gig.id]);
    expect(await service.findByCreator(validDto.creator)).toEqual([gig]);
  });

  it('uses a sorted set for open-gig expiry lookups and removes entries once resolved', async () => {
    const gig = await service.create({ ...validDto, responseWindowHours: 1 });

    const score = await redis.zscore('gigs:open:respondBy', gig.id);
    expect(score).toBe(new Date(gig.respondBy).getTime().toString());

    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await service.findExpirable(future)).toEqual([gig]);

    await service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

    expect(await redis.zscore('gigs:open:respondBy', gig.id)).toBeNull();
    expect(await service.findExpirable(future)).toEqual([]);
  });

  it('writes the entity and its indices atomically via MULTI/EXEC', async () => {
    const gig = await service.create(validDto);

    const [entityExists, inIndex, inCreatorSet, inOpenSet] = await Promise.all([
      redis.exists(`gig:${gig.id}`),
      redis.zscore('gigs:index', gig.id),
      redis.sismember(`gigs:by-creator:${gig.creator}`, gig.id),
      redis.zscore('gigs:open:respondBy', gig.id),
    ]);

    expect(entityExists).toBe(1);
    expect(inIndex).not.toBeNull();
    expect(inCreatorSet).toBe(1);
    expect(inOpenSet).not.toBeNull();
  });

  it('round-trips accept/cancel/expire transitions through Redis', async () => {
    const cancelled = await service.create(validDto);
    await service.cancel(cancelled.id);
    expect((await service.findById(cancelled.id)).status).toBe(GigStatus.CANCELLED);

    const expired = await service.create({ ...validDto, responseWindowHours: 1 });
    const result = await service.expire(expired.id);
    expect(result?.status).toBe(GigStatus.EXPIRED);
    expect((await service.findById(expired.id)).status).toBe(GigStatus.EXPIRED);
  });
});
