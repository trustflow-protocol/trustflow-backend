import { Injectable } from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';

/**
 * Tracks in-flight HTTP requests and whether the process is shutting down.
 *
 * This is the state a graceful shutdown needs in order to be *graceful* rather than merely
 * delayed. On `SIGTERM` an orchestrator immediately stops routing new traffic to the
 * instance but the process keeps accepting whatever is already on the wire; without a
 * readiness flap and an in-flight counter there is no way to know when it is safe to close
 * the database pool, so the only options are "drop requests immediately" (the previous
 * behaviour) or "sleep an arbitrary fixed interval and hope" (the naive fix).
 */
@Injectable()
export class DrainStateService {
  private readonly logger = new SanitizedLogger(DrainStateService.name);

  private draining = false;
  private inFlight = 0;
  private waiters: Array<() => void> = [];

  /** True once a shutdown signal has been observed. */
  isDraining(): boolean {
    return this.draining;
  }

  /** Number of requests currently being handled. */
  inFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Flips the process into draining state. Idempotent, and safe to call before any request
   * has been seen. Resolves once every in-flight request has completed.
   */
  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.logger.log(
      `Drain started — ${this.inFlight} request(s) still in flight; readiness probe will now fail`,
    );
    this.notifyIfIdle();
  }

  /** Registers the start of a request. Returns a release function, called on response finish. */
  trackRequest(): () => void {
    this.inFlight += 1;
    let released = false;
    return () => {
      // Guard against a double release: a response can emit both `finish` and `close`, and
      // undercounting here would make the drain resolve while requests are still running.
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.notifyIfIdle();
    };
  }

  /**
   * Resolves as soon as no requests remain in flight. Resolves immediately when already idle,
   * so a shutdown of an unused instance does not pay the poll interval.
   */
  async waitForDrain(pollIntervalMs = 50): Promise<void> {
    if (this.inFlight === 0) return;

    return new Promise<void>(resolve => {
      const waiter = () => {
        clearInterval(timer);
        resolve();
      };
      this.waiters.push(waiter);
      // Belt-and-suspenders poll: guards against a release path that never fires (a client
      // that holds the socket open without the request completing), which would otherwise
      // leave the drain hanging until the caller's own timeout.
      const timer = setInterval(() => {
        if (this.inFlight === 0) waiter();
      }, pollIntervalMs);
      // Do not keep the event loop alive purely for the poll.
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  private notifyIfIdle(): void {
    if (this.inFlight > 0 || this.waiters.length === 0) return;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter();
  }
}
