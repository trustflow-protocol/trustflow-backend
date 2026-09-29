import { Global, Module } from '@nestjs/common';
import { DrainStateService } from './drain-state.service';
import { DrainMiddleware } from './drain.middleware';
import { ShutdownService } from './shutdown.service';
import { RedisShutdownService } from './redis-shutdown.service';

export { DrainStateService } from './drain-state.service';
export { DrainMiddleware } from './drain.middleware';
export { ShutdownService, SHUTDOWN_SIGNALS } from './shutdown.service';
export type { ShutdownResult } from './shutdown.service';
export { RedisShutdownService } from './redis-shutdown.service';

/**
 * Provides the graceful-shutdown machinery globally: request tracking, the drain middleware,
 * the signal-driven shutdown coordinator, and Redis teardown.
 *
 * Global because both the drain middleware (applied to every route from `AppModule`) and the
 * readiness probe need the same `DrainStateService` instance — a second instance would track
 * a different request count and the drain would resolve immediately.
 */
@Global()
@Module({
  providers: [DrainStateService, DrainMiddleware, ShutdownService, RedisShutdownService],
  exports: [DrainStateService, DrainMiddleware, ShutdownService],
})
export class ShutdownModule {}
