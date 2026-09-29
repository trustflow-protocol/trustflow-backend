import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DrainStateService } from './drain-state.service';

/** Header used to tell a client why its request was shed during a drain. */
export const DRAIN_RETRY_AFTER_SECONDS = 5;

/**
 * Counts in-flight requests for the drain, and sheds new ones once draining has begun.
 *
 * The `Retry-After` header plus a 503 tells the client this is a transient condition worth
 * retrying, rather than a permanent failure — without it a rolling deploy would surface as a
 * spike of hard errors to every client whose request landed in the drain window.
 */
@Injectable()
export class DrainMiddleware implements NestMiddleware {
  constructor(private readonly drainState: DrainStateService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (this.drainState.isDraining()) {
      res.setHeader('Retry-After', String(DRAIN_RETRY_AFTER_SECONDS));
      res.setHeader('Connection', 'close');
      res.status(503).json({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Server is shutting down and is not accepting new requests. Please retry.',
      });
      return;
    }

    const release = this.drainState.trackRequest();
    // `finish` covers a completed response; `close` covers a client that disconnected
    // mid-request. Either one means the request is no longer occupying the connection.
    res.once('finish', release);
    res.once('close', release);

    next();
  }
}
