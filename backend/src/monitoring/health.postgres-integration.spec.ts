import { Pool } from 'pg';
import { HealthService } from './health.service';
import { DatabaseService } from '../common/database/database.service';
import { buildPoolConfig } from '../common/database/database.module';
import { validateEnv } from '../config/env.config';

// HealthService.checkStellar() reads config.STELLAR_HORIZON_URL, which requires
// validateEnv() to have run first — normally done once in main.ts.
validateEnv();

/**
 * Exercises the `database` field of GET /health against a real PostgreSQL pool — flipping
 * from healthy to unhealthy when the server becomes unreachable — rather than the mocked
 * DatabaseService health.service.spec.ts uses.
 *
 * Requires DATABASE_URL — CI provides a `postgres:16-alpine` service container (see
 * .github/workflows/backend-ci.yml). Skipped locally when DATABASE_URL isn't set.
 */
const describeIfPostgres = process.env.DATABASE_URL ? describe : describe.skip;

describeIfPostgres('HealthService (Postgres integration)', () => {
  const originalFetch = global.fetch;
  const originalMemoryUsage = process.memoryUsage;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
    process.memoryUsage = jest.fn().mockReturnValue({
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      rss: 100 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.memoryUsage = originalMemoryUsage;
  });

  it('reports database: true when the pool is pointed at a live server', async () => {
    const pool = new Pool(buildPoolConfig({ DATABASE_URL: process.env.DATABASE_URL })!);
    const database = new DatabaseService(pool);
    const health = new HealthService(database);

    try {
      const status = await health.check();
      expect(status.checks.database).toBe(true);
      expect(status.status).toBe('ok');
    } finally {
      await database.onModuleDestroy();
    }
  });

  it('reports database: false and status degraded when the pool is pointed at a dead server', async () => {
    const deadPool = new Pool(
      buildPoolConfig({
        DB_HOST: '10.255.255.1',
        DB_PORT: '5432',
        DB_NAME: 'unreachable',
        DB_USER: 'nobody',
        DB_PASSWORD: 'nobody',
        DB_POOL_CONNECTION_TIMEOUT_MS: '1000',
      })!,
    );
    deadPool.on('error', () => {});
    const database = new DatabaseService(deadPool);
    const health = new HealthService(database);

    try {
      const status = await health.check();
      expect(status.checks.database).toBe(false);
      expect(status.status).toBe('degraded');
    } finally {
      await database.onModuleDestroy();
    }
  }, 10_000);
});
