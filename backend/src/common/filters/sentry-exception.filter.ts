import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';
import { redactIp, redactUrl } from '../logging/redaction';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { SentryService } from '../../sentry/sentry.service';
import { CorrelationIdStore } from '../logging/correlation-id.store';

/**
 * Extracts a usable HTTP status from an error that isn't a NestJS `HttpException` but still
 * carries a real one — e.g. Express/body-parser's `PayloadTooLargeError` (413) for an
 * oversized request body, thrown by middleware that runs before any Nest exception filter
 * would otherwise see it. Without this, such errors fell through to a generic 500 even
 * though the error itself already knows its correct status.
 */
function extractKnownHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate =
    (error as Record<string, unknown>).status ?? (error as Record<string, unknown>).statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate < 600
    ? candidate
    : undefined;
}

@Injectable()
@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  private readonly logger = new SanitizedLogger(SentryExceptionFilter.name);

  constructor(
    private readonly sentryService: SentryService,
    private readonly correlationIdStore?: CorrelationIdStore,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();

    let status: number;
    let message: string;
    // Structured fields a handler deliberately attached to its HttpException response
    // (e.g. per-provider results on a partial failure), forwarded next to the standard ones.
    let details: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string }).message ?? exception.message);
      if (typeof res === 'object' && res !== null) {
        details = { ...(res as Record<string, unknown>) };
        delete details.statusCode;
        delete details.message;
        delete details.error;
      }
    } else {
      const knownStatus = extractKnownHttpStatus(exception);
      if (knownStatus !== undefined) {
        status = knownStatus;
        message = (exception as { message?: string }).message ?? 'Request failed';
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        message = 'Internal server error';
      }
    }

    // Resolve the correlation ID from the request object first (set by middleware),
    // then fall back to the AsyncLocalStorage context.
    const correlationId = request.correlationId ?? this.correlationIdStore?.get();

    // Send 5xx errors and unexpected/unrecognized exceptions to Sentry — matches an
    // HttpException's own client-vs-server split for the errors above with a known 4xx status.
    const shouldCapture = status >= 500;
    // `request.url` is the path *and query string*, which is where tokens routinely arrive
    // (`?token=`, `?api_key=`). Both the Sentry tag and the log line get the query string
    // removed. The response body keeps the full path for the client's own benefit.
    const safeUrl = redactUrl(request.url ?? '');
    if (shouldCapture) {
      Sentry.withScope(scope => {
        scope.setTag('url', safeUrl);
        scope.setTag('method', request.method);
        if (correlationId) {
          scope.setTag('correlationId', correlationId);
        }
        scope.setExtra('statusCode', status);
        scope.setUser({ ip_address: redactIp(request.ip) });
        this.sentryService.captureException(exception, 'SentryExceptionFilter');
      });
      this.logger.error(
        `[${request.method}] ${safeUrl} correlationId=${correlationId ?? 'n/a'} — ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      ...details,
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
