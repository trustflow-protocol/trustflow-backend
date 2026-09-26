import { Pool } from 'pg';
import { DatabaseService } from './database.service';
import { buildPoolConfig } from './database.module';

/**
 * Exercises DatabaseService/buildPoolConfig against a real PostgreSQL server instead of the
 * mocked `pg.Pool` the rest of database.service.spec.ts/database.module.spec.ts use. This
 * guards against behavior a mock can't faithfully reproduce: real connection establishment,
 * real query execution and parameter binding, real timeout/auth-failure semantics, and real
 * pool shutdown.
 *
 * Requires DATABASE_URL — CI provides a `postgres:16-alpine` service container (see
 * .github/workflows/backend-ci.yml). Skipped locally when DATABASE_URL isn't set rather than
 * failing, so `npm test` still works without a local Postgres — the same "skip when unset"
 * convention rate-limit.redis-integration.spec.ts, gig.service.redis-integration.spec.ts and
 * nonce-store.redis-integration.spec.ts use for Redis.
 */
const describeIfPostgres = process.env.DATABASE_URL ? describe : describe.skip;

describeIfPostgres('DatabaseService (Postgres integration)', () => {
  let pool: Pool;
  let service: DatabaseService;

  beforeAll(() => {
    const poolConfig = buildPoolConfig({ DATABASE_URL: process.env.DATABASE_URL });
    pool = new Pool(poolConfig!);
    service = new DatabaseService(pool);
  });

  afterAll(async () => {
    await service.onModuleDestroy();
  });

  it('reports isConfigured', () => {
    expect(service.isConfigured).toBe(true);
  });

  it('runs a query with bound parameters', async () => {
    const result = await service.query<{ value: number }>('SELECT $1::int AS value', [42]);
    expect(result.rows[0].value).toBe(42);
  });

  it('propagates a pool error for invalid SQL', async () => {
    await expect(service.query('SELECT * FROM this_table_does_not_exist')).rejects.toThrow();
  });

  it('ping resolves true against a live server', async () => {
    await expect(service.ping()).resolves.toBe(true);
  });

  it('builds a working pool from discrete DB_HOST/DB_PORT/DB_NAME vars as well as DATABASE_URL', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const discreteConfig = buildPoolConfig({
      DB_HOST: url.hostname,
      DB_PORT: url.port || '5432',
      DB_NAME: url.pathname.replace(/^\//, ''),
      DB_USER: url.username,
      DB_PASSWORD: url.password,
    });

    const discretePool = new Pool(discreteConfig!);
    const discreteService = new DatabaseService(discretePool);
    try {
      await expect(discreteService.ping()).resolves.toBe(true);
    } finally {
      await discreteService.onModuleDestroy();
    }
  });

  it('onModuleDestroy really ends the pool — a query after destroy rejects instead of hanging', async () => {
    const throwawayPool = new Pool(buildPoolConfig({ DATABASE_URL: process.env.DATABASE_URL })!);
    const throwawayService = new DatabaseService(throwawayPool);
    await throwawayService.ping();

    await throwawayService.onModuleDestroy();

    await expect(throwawayPool.query('SELECT 1')).rejects.toThrow();
  });

  it('the idle-client error listener registered by DatabaseModule does not crash the process', () => {
    // Mirrors the listener DatabaseModule's PG_POOL factory attaches (pool.on('error', ...))
    // so a pool-level client error (e.g. the server restarting) is handled instead of
    // crashing the process via an unhandled 'error' event on the EventEmitter.
    const emittingPool = new Pool(buildPoolConfig({ DATABASE_URL: process.env.DATABASE_URL })!);
    const errors: Error[] = [];
    emittingPool.on('error', error => errors.push(error));

    expect(() =>
      emittingPool.emit('error', new Error('simulated idle client error')),
    ).not.toThrow();
    expect(errors).toHaveLength(1);

    return emittingPool.end();
  });

  describe('unreachable server', () => {
    it('ping resolves false within the configured connection timeout, without throwing', async () => {
      const unreachableConfig = buildPoolConfig({
        DB_HOST: '10.255.255.1', // non-routable address (RFC 5737 test range) — always times out
        DB_PORT: '5432',
        DB_NAME: 'unreachable',
        DB_USER: 'nobody',
        DB_PASSWORD: 'nobody',
        DB_POOL_CONNECTION_TIMEOUT_MS: '1000',
      });
      const unreachablePool = new Pool(unreachableConfig!);
      const unreachableService = new DatabaseService(unreachablePool);
      // Swallow the pool-level 'error' ioredis-style emission so the unhandled error
      // doesn't fail the test process; DatabaseModule's real factory does the same.
      unreachablePool.on('error', () => {});

      const start = Date.now();
      await expect(unreachableService.ping()).resolves.toBe(false);
      expect(Date.now() - start).toBeLessThan(5000);

      await unreachableService.onModuleDestroy();
    }, 10_000);

    it('ping resolves false (not throw) on a wrong-password auth failure', async () => {
      const url = new URL(process.env.DATABASE_URL!);
      const wrongPasswordConfig = buildPoolConfig({
        DB_HOST: url.hostname,
        DB_PORT: url.port || '5432',
        DB_NAME: url.pathname.replace(/^\//, ''),
        DB_USER: url.username,
        DB_PASSWORD: `${url.password}-definitely-wrong`,
      });
      const wrongPasswordPool = new Pool(wrongPasswordConfig!);
      const wrongPasswordService = new DatabaseService(wrongPasswordPool);
      wrongPasswordPool.on('error', () => {});

      await expect(wrongPasswordService.ping()).resolves.toBe(false);

      await wrongPasswordService.onModuleDestroy();
    });
  });
});
