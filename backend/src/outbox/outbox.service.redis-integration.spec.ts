import { Redis } from 'ioredis';
import { MetricsService } from '../monitoring/metrics.service';
import {
  OUTBOX_GATEWAY_CHANNEL,
  OUTBOX_QUEUE_KEY,
  OutboxPublisherService,
} from './outbox-publisher.service';
import { OutboxService } from './outbox.service';

/**
 * Exercises OutboxService and OutboxPublisherService against a real Redis server instead of the
 * mocked ioredis client the rest of outbox.service.spec.ts uses. The unit suite always constructs
 * `new OutboxService(null, ...)`, so it never touches the production path: the CLAIM_DUE_SCRIPT
 * and RECLAIM_EXPIRED_SCRIPT Lua scripts, the MULTI/EXEC writes in append, markDelivered and
 * retry, appendToTransaction, or OutboxPublisherService's pub/sub + LPUSH transaction — all of
 * which at-least-once delivery depends on. This guards against behavior the mock can't faithfully
 * reproduce: real Lua script execution, real ZRANGEBYSCORE/ZREM/ZADD sorted-set ordering and
 * atomicity, real MULTI/EXEC result shapes, and real pub/sub + LPUSH semantics.
 *
 * Requires REDIS_URL — CI provides a `redis:7-alpine` service container (see
 * .github/workflows/backend-ci.yml). Skipped locally when REDIS_URL isn't set rather than
 * failing, so `npm test` still works without a local Redis.
 */
const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;

describeIfRedis('OutboxService and OutboxPublisherService (Redis integration)', () => {
  let redis: Redis;
  let outbox: OutboxService;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    // Isolate each test from prior runs/tests without touching unrelated keys another
    // suite/process might be using on the same Redis instance.
    const keys = [...(await redis.keys('outbox:*')), ...(await redis.keys('trustflow:events:*'))];
    if (keys.length > 0) await redis.del(...keys);

    const metrics = { increment: jest.fn() } as unknown as MetricsService;
    outbox = new OutboxService(redis, metrics);
  });

  it('claims due events atomically — concurrent claims return disjoint sets', async () => {
    for (let i = 0; i < 10; i++) {
      const event = outbox.create('gig.created', 'gig', `gig-${i}`, { i });
      await outbox.append(event);
    }

    const now = Date.now();
    const [first, second] = await Promise.all([
      outbox.claimDue(now, 30_000, 5),
      outbox.claimDue(now, 30_000, 5),
    ]);

    const claimedIds = [...first, ...second].map(event => event.id);
    expect(new Set(claimedIds).size).toBe(10);
    expect(first.some(event => second.some(other => other.id === event.id))).toBe(false);

    // A claimed event is invisible to the next claim.
    expect(await outbox.claimDue(now, 30_000, 10)).toEqual([]);
  });

  it('returns an abandoned lease to pending where it becomes claimable again', async () => {
    const event = outbox.create('gig.created', 'gig', 'gig-1', { id: 'gig-1' });
    await outbox.append(event);

    const now = Date.now();
    const leaseMs = 1000;

    expect(await outbox.claimDue(now, leaseMs, 10)).toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
    expect(await redis.zscore('outbox:processing', event.id)).not.toBeNull();

    // Still within the lease, so it is not yet claimable.
    expect(await outbox.claimDue(now + 500, leaseMs, 10)).toEqual([]);

    await outbox.reclaimExpired(now + leaseMs + 1, 10);

    expect(await redis.zscore('outbox:processing', event.id)).toBeNull();
    expect(await redis.zscore('outbox:pending', event.id)).toBe(String(now + leaseMs + 1));

    expect(await outbox.claimDue(now + leaseMs + 1, leaseMs, 10)).toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it('does not wedge the processing set when the event body is missing', async () => {
    const event = outbox.create('gig.created', 'gig', 'gig-1', { id: 'gig-1' });
    await outbox.append(event);

    await outbox.claimDue(Date.now(), 1000, 10);
    expect(await redis.zcard('outbox:processing')).toBe(1);

    // Simulate a worker that crashed after losing the event body.
    await redis.del(`outbox:event:${event.id}`);

    await outbox.reclaimExpired(Date.now() + 1001, 10);

    expect(await redis.zcard('outbox:processing')).toBe(0);
    expect(await redis.zcard('outbox:pending')).toBe(1);
  });

  it('reschedules retries with incremented attempts and backoff ordering', async () => {
    const a = outbox.create('gig.created', 'gig', 'a', {});
    const b = outbox.create('gig.created', 'gig', 'b', {});
    const c = outbox.create('gig.created', 'gig', 'c', {});
    await outbox.append(a);
    await outbox.append(b);
    await outbox.append(c);

    const claimed = await outbox.claimDue(Date.now(), 30_000, 10);
    expect(claimed).toHaveLength(3);
    const byId = new Map(claimed.map(event => [event.id, event]));

    await outbox.retry(byId.get(a.id)!, new Error('boom'));
    await outbox.retry(byId.get(b.id)!, new Error('boom'));
    await outbox.retry(byId.get(b.id)!, new Error('boom'));
    await outbox.retry(byId.get(c.id)!, new Error('boom'));
    await outbox.retry(byId.get(c.id)!, new Error('boom'));
    await outbox.retry(byId.get(c.id)!, new Error('boom'));

    expect((await outbox.findById(a.id))!.attempts).toBe(1);
    expect((await outbox.findById(b.id))!.attempts).toBe(2);
    expect((await outbox.findById(c.id))!.attempts).toBe(3);

    // Backoff scores grow (1s, 2s, 4s), so the pending set orders A < B < C.
    expect(await redis.zrange('outbox:pending', 0, -1)).toEqual([a.id, b.id, c.id]);
    expect(await redis.zcard('outbox:processing')).toBe(0);
  });

  it('marks an event delivered and clears its processing lease', async () => {
    const event = outbox.create('gig.created', 'gig', 'gig-1', { id: 'gig-1' });
    await outbox.append(event);

    const [claimed] = await outbox.claimDue(Date.now(), 30_000, 10);
    expect(claimed).toBeDefined();

    await outbox.markDelivered(claimed);

    expect(await outbox.findById(event.id)).toEqual(
      expect.objectContaining({
        status: 'delivered',
        deliveredAt: expect.any(String),
      }),
    );
    expect(await redis.zscore('outbox:processing', event.id)).toBeNull();
    expect(await redis.zscore('outbox:pending', event.id)).toBeNull();
  });

  it('publishes to the gateway channel and pushes the payload onto the queue', async () => {
    const subscriber = new Redis(process.env.REDIS_URL!);
    const received = new Promise<string>(resolve => {
      subscriber.on('message', (_channel, message) => resolve(message));
    });
    await subscriber.subscribe(OUTBOX_GATEWAY_CHANNEL);

    const event = outbox.create('gig.created', 'gig', 'gig-1', { id: 'gig-1' });
    const payload = JSON.stringify(event);

    const publisher = new OutboxPublisherService(redis);
    await publisher.publish(event);

    expect(await received).toBe(payload);
    expect(await redis.lrange(OUTBOX_QUEUE_KEY, 0, 0)).toEqual([payload]);

    await subscriber.unsubscribe(OUTBOX_GATEWAY_CHANNEL);
    await subscriber.quit();
  });
});
