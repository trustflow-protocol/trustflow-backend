import { Inject, Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { SanitizedLogger } from '../logging/sanitized-logger';

/**
 * Closes the shared Redis client during shutdown.
 *
 * The singleton `REDIS_CLIENT` previously had no `quit()` anywhere in production code — it
 * was created in `RedisModule`'s factory and never torn down. Because ioredis reconnects on
 * a retry schedule, that client keeps the event loop alive indefinitely after a shutdown, so
 * the process can only be ended by an orchestrator escalating to `SIGKILL`.
 *
 * `quit()` is preferred over `disconnect()`: it drains in-flight commands and sends `QUIT`,
 * whereas `disconnect()` drops commands immediately and can leave a multi/exec half-applied.
 */
@Injectable()
export class RedisShutdownService implements OnApplicationShutdown {
  private readonly logger = new SanitizedLogger(RedisShutdownService.name);
  private closed = false;

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // A null client is the documented "REDIS_URL not set" path, not a failure.
    if (!this.redis) return;

    try {
      // Already-closed clients reject; treat that as success.
      if (this.redis.status === 'end') {
        this.logger.log('Redis client already closed');
        return;
      }
      await this.redis.quit();
      this.logger.log('Redis client closed cleanly');
    } catch (error) {
      this.logger.warn(`Redis quit failed, falling back to disconnect: ${String(error)}`);
      try {
        this.redis.disconnect();
      } catch {
        // Nothing further to try — the process is exiting regardless.
      }
    }
  }
}
