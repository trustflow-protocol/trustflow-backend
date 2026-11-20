import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createRedisClient, REDIS_RECONNECT_MAX_DELAY_MS } from './redis.module';
import { resetEnvConfig, validateEnv } from '../../config/env.config';

describe('createRedisClient (#220)', () => {
  const originalUrl = process.env.REDIS_URL;
  const clients: Redis[] = [];

  afterEach(() => {
    for (const c of clients.splice(0)) c.disconnect();
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalUrl;
    jest.restoreAllMocks();
  });

  it('returns null and warns when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    expect(createRedisClient()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('always registers an error listener so a connection failure cannot go unhandled', () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listens here
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const client = createRedisClient();
    expect(client).not.toBeNull();
    clients.push(client!);

    expect(client!.listenerCount('error')).toBeGreaterThanOrEqual(1);
  });

  it('logs (does not throw) when the eager connection fails', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const client = createRedisClient();
    clients.push(client!);

    // Give the eager connect().catch() a tick to run.
    await new Promise(r => setTimeout(r, 50));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Initial Redis connection failed'));
  });
  it('configures reconnectOnError and retryStrategy for automatic recovery (#906)', () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const client = createRedisClient();
    expect(client).not.toBeNull();
    clients.push(client!);

    const opts = client!.options;
    expect(typeof opts.retryStrategy).toBe('function');
    expect(typeof opts.reconnectOnError).toBe('function');
    expect((opts.retryStrategy as Function)(5)).toBeLessThanOrEqual(3000);
    expect((opts.reconnectOnError as Function)(new Error('READONLY'))).toBe(true);
  });

  it('caps the reconnect backoff so recovery is not delayed by minutes (#906)', () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    // This suite predates the global Jest setup hook, so seed the config explicitly.
    resetEnvConfig();
    validateEnv();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const client = createRedisClient();
    clients.push(client!);

    const strategy = client!.options.retryStrategy as Function;
    // A linear/uncapped schedule would return very large delays for these attempt counts.
    for (const attempt of [30, 50, 100, 1000]) {
      expect(strategy(attempt)).toBe(REDIS_RECONNECT_MAX_DELAY_MS);
    }
    expect(strategy(5)).toBeLessThan(REDIS_RECONNECT_MAX_DELAY_MS);
  });
});
