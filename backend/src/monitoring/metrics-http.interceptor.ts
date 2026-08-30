import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * MetricsHttpInterceptor automatically instruments all HTTP requests and responses.
 * Tracks:
 * - http_requests_total: total number of requests by method and route
 * - http_request_duration_seconds: request latency in milliseconds by route
 * - http_requests_errors_total: error count by status code and route
 * - http_requests_success_total: success count by status code and route
 */
@Injectable()
export class MetricsHttpInterceptor implements NestInterceptor {
  private readonly logger = new Logger(MetricsHttpInterceptor.name);

  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const method = request.method;
    const route = this.getRoute(request);
    const startTime = Date.now();

    // Track total request count
    this.metrics.increment('http_requests_total', {
      method,
      route,
    });

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        const statusCode = response.statusCode;

        // Track request duration
        this.metrics.increment('http_request_duration_seconds', {
          route,
          status_code: String(statusCode),
        });

        // Track successful response
        if (statusCode < 400) {
          this.metrics.increment('http_requests_success_total', {
            method,
            route,
            status_code: String(statusCode),
          });
        }

        this.logger.debug(
          `${method} ${route} completed with status ${statusCode} in ${duration}ms`,
        );
      }),
      catchError((error) => {
        const duration = Date.now() - startTime;
        const statusCode = error.status || 500;

        // Track error response
        this.metrics.increment('http_requests_errors_total', {
          method,
          route,
          status_code: String(statusCode),
        });

        this.logger.debug(
          `${method} ${route} failed with status ${statusCode} in ${duration}ms: ${error.message}`,
        );

        throw error;
      }),
    );
  }

  /**
   * Extract route from request URL and handle dynamic segments.
   * Examples:
   * /api/users/123 -> /api/users/:id
   * /api/escrows/abc/release -> /api/escrows/:id/release
   */
  private getRoute(request: Request): string {
    const originalUrl = request.originalUrl;

    // Remove query string
    const path = originalUrl.split('?')[0];

    // Try to match against known patterns and replace IDs with :id
    // This prevents high cardinality metrics when there are many different IDs
    const idPatterns = [
      /\/([a-f0-9-]+)(\/|$)/g, // UUID or similar
      /\/(\d+)(\/|$)/g, // numeric IDs
    ];

    let normalizedPath = path;
    for (const pattern of idPatterns) {
      normalizedPath = normalizedPath.replace(pattern, '/:id$2');
    }

    return normalizedPath || path;
  }
}
