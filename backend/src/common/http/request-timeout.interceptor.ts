import { Injectable, NestInterceptor, ExecutionContext, CallHandler, RequestTimeoutException, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { timeout, catchError } from 'rxjs/operators';
import { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { config } from '../../config/env.config';
import { SKIP_TIMEOUT_KEY } from './skip-timeout.decorator';

/**
 * Global interceptor that enforces an inbound request timeout.
 *
 * Returns HTTP 408 Request Timeout if a handler exceeds the configured duration.
 * Per-route overrides via @SkipTimeout() decorator:
 *   - @SkipTimeout() fully exempts the route
 *   - @SkipTimeout(ms) applies a custom timeout
 *
 * Note: rxjs timeout ends the response but does not cancel the running handler;
 * handlers should use AbortController or similar to cancel downstream work.
 * Exempt routes: /health*, /metrics, /api/docs*, /api-json.
 */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestTimeoutInterceptor.name);
  private readonly defaultTimeoutMs = config.REQUEST_TIMEOUT_MS;
  private readonly exemptPaths = ['/health', '/metrics', '/api/docs', '/api-docs-json'];

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();

    // Check if route is exempted by decorator
    const skipTimeout = this.reflector.getAllAndOverride<number | boolean | undefined>(SKIP_TIMEOUT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipTimeout === true) {
      // Fully exempt from timeout
      return next.handle();
    }

    if (this.isExemptPath(request.path)) {
      // Exempt built-in paths
      return next.handle();
    }

    // Use custom timeout if set via decorator, otherwise use default
    const timeoutMs = typeof skipTimeout === 'number' ? skipTimeout : this.defaultTimeoutMs;

    return next.handle().pipe(
      timeout(timeoutMs),
      catchError(error => {
        // RxJS timeout error is a TimeoutError that we convert to 408
        if (error.name === 'TimeoutError') {
          this.logger.warn(
            `[${request.method}] ${request.path} exceeded ${timeoutMs}ms timeout`,
          );
          throw new RequestTimeoutException(
            `Request timeout after ${timeoutMs}ms`,
          );
        }
        throw error;
      }),
    );
  }

  private isExemptPath(path: string): boolean {
    return this.exemptPaths.some(exemptPath => {
      // Support prefix matching for paths like /health/live
      return path === exemptPath || path.startsWith(exemptPath + '/');
    });
  }
}
