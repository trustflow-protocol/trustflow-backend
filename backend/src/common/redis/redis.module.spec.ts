import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createRedisClient } from './redis.module';

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
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Initial Redis connection failed'),
    );
  });
});
