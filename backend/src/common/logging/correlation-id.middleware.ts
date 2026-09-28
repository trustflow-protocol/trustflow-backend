import { Injectable, NestMiddleware } from '@nestjs/common';
import { SanitizedLogger } from './sanitized-logger';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { CorrelationIdStore } from './correlation-id.store';
import { redactIp, redactUrl, sanitiseCorrelationId } from './redaction';

/** Header name clients can send to propagate an upstream correlation ID. */
export const CORRELATION_ID_HEADER = 'x-request-id';

/**
 * Generates (or propagates an inbound `X-Request-Id` header as) a correlation ID for every
 * HTTP request, attaches it to `request.correlationId`, writes it back in the response
 * header, and runs the remainder of the request inside the `CorrelationIdStore` async context
 * so every log line emitted while handling the request can include the same ID.
 *
 * The inbound header is entirely client-controlled, so it is validated before use. An
 * unvalidated value was previously written straight into a log line, which allowed log forging
 * via embedded newlines and unbounded log inflation via a multi-kilobyte ID, and was also
 * echoed into a response header. Anything that is not a short, printable, single-line token
 * is discarded in favour of a fresh UUID.
 *
 * The logged URL has its query string removed and the client IP is reduced to a network
 * prefix, because both routinely carry credentials or personal data.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new SanitizedLogger(CorrelationIdMiddleware.name);

  constructor(private readonly store: CorrelationIdStore) {}

  use(req: Request & { correlationId?: string }, res: Response, next: NextFunction): void {
    // Honour a well-formed upstream ID if present; otherwise generate a new one.
    const inbound = req.headers[CORRELATION_ID_HEADER] as string | undefined;
    const correlationId = sanitiseCorrelationId(inbound) ?? randomUUID();

    req.correlationId = correlationId;

    // Echo the ID back to the caller so they can correlate on their end.
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    this.logger.log(
      JSON.stringify({
        event: 'request_start',
        correlationId,
        method: req.method,
        url: redactUrl(req.originalUrl ?? req.url ?? ''),
        ip: redactIp(req.ip),
      }),
    );

    // Run the rest of the request lifecycle inside the async store so downstream
    // code (services, guards, interceptors) can retrieve the ID without it being
    // threaded through every function signature.
    this.store.run(correlationId, () => next());
  }
}
