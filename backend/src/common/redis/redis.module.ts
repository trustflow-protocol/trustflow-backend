import { Module, Global, Logger } from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';
import { Redis } from 'ioredis';
import { DistributedLockService } from './distributed-lock.service';
import { config } from '../../config/env.config';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT } from './redis.constants';

/**
 * Build the app's ioredis client from `REDIS_URL`, or `null` when it is unset.
 *
 * ioredis is a Node `EventEmitter`, and an unhandled `'error'` event can crash
 * the process on some Node/ioredis versions; even where it doesn't, a
 * connection failure otherwise only surfaces as a rejected promise on the next
 * command. So an `'error'` listener is always attached and every failure is
 * logged via the NestJS `Logger` (#220).
 *
 * The connection is also attempted eagerly rather than waiting for the first
 * real command (`lazyConnect: true`), so a misconfigured `REDIS_URL` shows up
 * at startup. This never fails startup: `connect()`'s rejection is caught and
 * logged, ioredis keeps retrying per `retryStrategy`, and Redis-backed
 * features degrade until it recovers.
 */
export function createRedisClient(
  logger: Pick<Logger, 'warn' | 'error' | 'log'> = new SanitizedLogger('RedisModule'),
): Redis | null {
  const url = config.REDIS_URL;
  if (!url) {
    logger.warn(
      'REDIS_URL not set — Redis-backed features (rate limiting, outbox relay, caches) are disabled',
    );
    return null;
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    // Without this a command on an unreachable Redis waits out the whole retry/backoff
    // sequence (seconds). Reject fast so callers can apply their own degradation policy.
    commandTimeout: config.REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: times => {
      const delay = Math.min(times * 100, 3000);
      logger.warn(`Redis reconnect attempt #${times}, retrying in ${delay}ms`);
      return delay;
    },
    reconnectOnError: err => {
      logger.warn(`Redis reconnectOnError triggered: ${err.message}`);
      return true;
    },
    lazyConnect: true,
  });

  client.on('error', err => logger.error(`Redis client error: ${err.message}`, err.stack));
  client.on('connect', () => logger.log('Redis connected'));
  client.on('ready', () => logger.log('Redis connection ready and active'));
  client.on('reconnecting', (delay?: number) => logger.warn(`Redis reconnecting in ${delay ?? 0}ms…`));
  client.on('close', () => logger.warn('Redis connection closed'));

  // Ensure pipeline and multi batches respect REDIS_COMMAND_TIMEOUT_MS (#907)
  const origMulti = client.multi.bind(client);
  // `Redis#multi` is overloaded (a `{ pipeline: false }` call resolves to `Promise<"OK">`
  // rather than a `ChainableCommander`); this wrapper only ever returns the chainable form,
  // so it's cast back to the original member type rather than widening the public signature.
  client.multi = function (...args: any[]) {
    const pipeline = origMulti(...args);
    const origExec = pipeline.exec.bind(pipeline);
    pipeline.exec = function () {
      const timeoutMs = config.REDIS_COMMAND_TIMEOUT_MS;
      if (!timeoutMs || timeoutMs <= 0) return origExec();
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Redis pipeline/multi timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      return Promise.race([origExec(), timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
    return pipeline;
  } as typeof client.multi;

  const origPipeline = client.pipeline.bind(client);
  client.pipeline = function (...args: any[]) {
    const pipeline = origPipeline(...args);
    const origExec = pipeline.exec.bind(pipeline);
    pipeline.exec = function () {
      const timeoutMs = config.REDIS_COMMAND_TIMEOUT_MS;
      if (!timeoutMs || timeoutMs <= 0) return origExec();
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Redis pipeline/multi timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      return Promise.race([origExec(), timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
    return pipeline;
  };

  client
    .connect()
    .catch((err: Error) =>
      logger.error(
        `Initial Redis connection failed (will keep retrying per retryStrategy): ${err.message}`,
      ),
    );

  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis | null => createRedisClient(),
    },
    DistributedLockService,
  ],
  exports: [REDIS_CLIENT, DistributedLockService],
})
export class RedisModule {}
