import { SetMetadata } from '@nestjs/common';

/**
 * Decorator to skip the global request timeout on a specific route or method.
 * Typically used for health checks (/health, /metrics) and long-running operations.
 *
 * @param timeoutMs - Optional custom timeout in milliseconds for this route (omit to skip entirely)
 *
 * @example
 *   @SkipTimeout()  // Fully exempt from timeout
 *   @Get('/health')
 *   async health() { ... }
 *
 *   @SkipTimeout(60000)  // Custom 60s timeout for this route
 *   @Post('/ipfs/pins')
 *   async pinContent() { ... }
 */
export const SKIP_TIMEOUT_KEY = 'skip_timeout';

export const SkipTimeout = (timeoutMs?: number) =>
  SetMetadata(SKIP_TIMEOUT_KEY, timeoutMs === undefined ? true : timeoutMs);
