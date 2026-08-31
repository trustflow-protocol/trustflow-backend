import { Redis } from 'ioredis';
import { NonceStoreService } from './nonce-store.service';

/**
 * Exercises NonceStoreService's Lua GETDEL script against a real Redis server instead of the
 * mocked ioredis client the rest of nonce-store.service.spec.ts uses. This guards against
 * behavior the mock can't faithfully reproduce: real Lua script execution, real GET+DEL
 * atomicity, and real TTL expiry semantics.
 *
 * Requires REDIS_URL — CI provides a `redis:7-alpine` service container (see
 * .github/workflows/backend-ci.yml). Skipped locally when REDIS_URL isn't set rather than
 * failing, so `npm test` still works without a local Redis.
 */
const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;

describeIfRedis('NonceStoreService (Redis integration)', () => {
  let redis: Redis;
  let service: NonceStoreService;

  const TEST_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP';
  const TEST_NONCE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const TEST_CHALLENGE = `Sign this message to authenticate with TrustFlow: ${TEST_NONCE}`;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    // Isolate each test from prior runs/tests without touching unrelated keys another
    // suite/process might be using on the same Redis instance.
    const keys = await redis.keys('auth:nonce*');
    if (keys.length > 0) await redis.del(...keys);

    service = new NonceStoreService(redis);
  });

  it('stores and consumes a challenge using the real GETDEL Lua script', async () => {
    await service.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

    // Verify stored
    const rawChallenge = await redis.get(`auth:nonce:${TEST_ADDRESS}`);
    expect(rawChallenge).toBe(TEST_CHALLENGE);

    // Consume should use the GETDEL_LUA script to atomically get and delete
    const consumed = await service.consume(TEST_ADDRESS);
    expect(consumed).toBe(TEST_CHALLENGE);

    // Second consume should return null (already deleted)
    const second = await service.consume(TEST_ADDRESS);
    expect(second).toBeNull();

    // Key should be gone
    const afterConsume = await redis.get(`auth:nonce:${TEST_ADDRESS}`);
    expect(afterConsume).toBeNull();
  });

  it('marks nonce as used with TTL and detects replay', async () => {
    await service.markNonceUsed(TEST_NONCE);

    // Verify key exists
    const exists = await redis.exists(`auth:nonce:used:${TEST_NONCE}`);
    expect(exists).toBe(1);

    // Verify TTL is set (should be ~300 seconds)
    const ttl = await redis.ttl(`auth:nonce:used:${TEST_NONCE}`);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);

    // Service should detect replay
    const isReplay = await service.isNonceReplay(TEST_NONCE);
    expect(isReplay).toBe(true);
  });

  it('detects when a challenge has expired via TTL', async () => {
    await service.store(TEST_ADDRESS, TEST_CHALLENGE, TEST_NONCE);

    // Force expire by setting TTL to 0
    await redis.expire(`auth:nonce:${TEST_ADDRESS}`, 0);

    // Wait a moment for expiry to take effect
    await new Promise(resolve => setTimeout(resolve, 100));

    // Consume should return null (expired)
    const consumed = await service.consume(TEST_ADDRESS);
    expect(consumed).toBeNull();
  });

  it('allows only one active challenge per address (NX semantics)', async () => {
    const firstChallenge = 'First challenge';
    const secondChallenge = 'Second challenge';

    await service.store(TEST_ADDRESS, firstChallenge, TEST_NONCE);

    // Attempt to store a second challenge — NonceStoreService replaces it
    await service.store(TEST_ADDRESS, secondChallenge, `${TEST_NONCE}-2`);

    // Should get the second one (replaced)
    const consumed = await service.consume(TEST_ADDRESS);
    expect(consumed).toBe(secondChallenge);
  });

  it('isolates challenges by address', async () => {
    const address1 = 'GADDR1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const address2 = 'GADDR2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    await service.store(address1, 'Challenge 1', 'nonce1');
    await service.store(address2, 'Challenge 2', 'nonce2');

    expect(await service.consume(address1)).toBe('Challenge 1');
    expect(await service.consume(address2)).toBe('Challenge 2');

    // Both should be consumed independently
    expect(await service.consume(address1)).toBeNull();
    expect(await service.consume(address2)).toBeNull();
  });
});
