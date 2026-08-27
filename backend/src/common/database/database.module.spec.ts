import { buildPoolConfig } from './database.module';

describe('buildPoolConfig', () => {
  it('returns null when neither DATABASE_URL nor DB_HOST/DB_NAME are set', () => {
    expect(buildPoolConfig({})).toBeNull();
  });

  it('returns null when only DB_HOST is set without DB_NAME', () => {
    expect(buildPoolConfig({ DB_HOST: 'localhost' })).toBeNull();
  });

  it('builds a connectionString config from DATABASE_URL', () => {
    const config = buildPoolConfig({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/trustflow',
    });

    expect(config).toMatchObject({
      connectionString: 'postgres://user:pass@localhost:5432/trustflow',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it('builds a discrete config from DB_HOST/DB_NAME and friends', () => {
    const config = buildPoolConfig({
      DB_HOST: 'db.internal',
      DB_PORT: '6543',
      DB_NAME: 'trustflow',
      DB_USER: 'trustflow_app',
      DB_PASSWORD: 'secret',
    });

    expect(config).toMatchObject({
      host: 'db.internal',
      port: 6543,
      database: 'trustflow',
      user: 'trustflow_app',
      password: 'secret',
    });
  });

  it('defaults DB_PORT to 5432 when unset', () => {
    const config = buildPoolConfig({ DB_HOST: 'db.internal', DB_NAME: 'trustflow' });
    expect(config?.port).toBe(5432);
  });

  it('honors pool tuning env vars', () => {
    const config = buildPoolConfig({
      DATABASE_URL: 'postgres://localhost/trustflow',
      DB_POOL_MAX: '25',
      DB_POOL_IDLE_TIMEOUT_MS: '60000',
      DB_POOL_CONNECTION_TIMEOUT_MS: '2000',
    });

    expect(config).toMatchObject({
      max: 25,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 2_000,
    });
  });

  it('falls back to pool defaults for non-positive tuning values', () => {
    const config = buildPoolConfig({
      DATABASE_URL: 'postgres://localhost/trustflow',
      DB_POOL_MAX: '-5',
      DB_POOL_IDLE_TIMEOUT_MS: 'not-a-number',
    });

    expect(config).toMatchObject({ max: 10, idleTimeoutMillis: 30_000 });
  });

  it('enables ssl with rejectUnauthorized: false when DB_SSL=true', () => {
    const config = buildPoolConfig({
      DATABASE_URL: 'postgres://localhost/trustflow',
      DB_SSL: 'true',
    });

    expect(config?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('leaves ssl undefined when DB_SSL is unset', () => {
    const config = buildPoolConfig({ DATABASE_URL: 'postgres://localhost/trustflow' });
    expect(config?.ssl).toBeUndefined();
  });

  it('prefers DATABASE_URL over discrete vars when both are present', () => {
    const config = buildPoolConfig({
      DATABASE_URL: 'postgres://localhost/trustflow',
      DB_HOST: 'ignored-host',
      DB_NAME: 'ignored-db',
    });

    expect(config).toMatchObject({ connectionString: 'postgres://localhost/trustflow' });
    expect(config).not.toHaveProperty('host');
  });
});
