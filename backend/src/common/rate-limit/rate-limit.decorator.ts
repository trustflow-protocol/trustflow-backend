import { applyDecorators, SetMetadata } from '@nestjs/common';

export const SKIP_RATE_LIMIT = 'skip_rate_limit';
export const RATE_LIMIT_POINTS = 'rate_limit_points';
export const RATE_LIMIT_DURATION = 'rate_limit_duration';
export const RATE_LIMIT_ON_REDIS_ERROR = 'rate_limit_on_redis_error';

/**
 * What the rate limiter does with a request when Redis is unreachable:
 * - `allow`: fail open — the request proceeds unlimited (availability over protection).
 * - `deny`: fail closed — the request is rejected with 503 + `Retry-After`.
 */
export type RateLimitRedisErrorPolicy = 'allow' | 'deny';

export interface RateLimitOptions {
  /** Overrides the global `RATE_LIMIT_ON_REDIS_ERROR` default for this route. */
  onRedisError?: RateLimitRedisErrorPolicy;
}

export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);

/**
 * Sets the Redis-outage policy for a route (or a whole controller) without touching its
 * points/duration, which keep their defaults. Use `deny` on routes that must never run
 * unthrottled (e.g. `/auth/*`), regardless of the global default.
 */
export const RateLimitOnRedisError = (policy: RateLimitRedisErrorPolicy) =>
  SetMetadata(RATE_LIMIT_ON_REDIS_ERROR, policy);

export const RateLimit = (points: number, duration: number, options: RateLimitOptions = {}) =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_POINTS, points),
    SetMetadata(RATE_LIMIT_DURATION, duration),
    ...(options.onRedisError ? [RateLimitOnRedisError(options.onRedisError)] : []),
  );
