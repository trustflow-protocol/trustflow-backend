import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marks a controller method as idempotent. When present, the
 * IdempotencyKeyInterceptor will cache the handler's response keyed by
 * (endpoint, Idempotency-Key header) and replay it on retries with
 * the same key.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
