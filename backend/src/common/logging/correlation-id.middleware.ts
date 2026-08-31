import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { CorrelationIdStore } from './correlation-id.store';

/** Header name clients can send to propagate an upstream correlation ID. */
export const CORRELATION_ID_HEADER = 'x-request-id';

/**
 * Generates (or propagates an inbound `X-Request-Id` header as) a correlation ID for every
 * HTTP request, attaches it to `request.correlationId`, writes it back in the response
 * header, and runs the remainder of the request inside the `CorrelationIdStore` async context
 * so every log line emitted while handling the request can include the same ID.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CorrelationIdMiddleware.name);

  constructor(private readonly store: CorrelationIdStore) {}

  use(req: Request & { correlationId?: string }, res: Response, next: NextFunction): void {
    // Honour an upstream ID if present; otherwise generate a new one.
    const correlationId =
      (req.headers[CORRELATION_ID_HEADER] as string | undefined) || randomUUID();

    req.correlationId = correlationId;

    // Echo the ID back to the caller so they can correlate on their end.
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    this.logger.log(
      JSON.stringify({
        event: 'request_start',
        correlationId,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
      }),
    );

    // Run the rest of the request lifecycle inside the async store so downstream
    // code (services, guards, interceptors) can retrieve the ID without it being
    // threaded through every function signature.
    this.store.run(correlationId, () => next());
  }
}
