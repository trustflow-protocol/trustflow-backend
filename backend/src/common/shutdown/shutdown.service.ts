import { Injectable, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';
import { DrainStateService } from './drain-state.service';
import { config } from '../../config/env.config';

/** Signals that trigger a graceful shutdown. */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/** Exit code used when the drain completes within the timeout. */
export const CLEAN_EXIT_CODE = 0;

/** Exit code used when the drain timed out and in-flight requests had to be severed. */
export const FORCED_EXIT_CODE = 1;

/**
 * Overrides for the two values that govern shutdown timing. Exists so tests can drive a
 * timeout or disable the exit without mutating `config` — which is a read-only Proxy with
 * only a `get` trap, so a plain assignment in a test is silently discarded and the test
 * would pass or hang for the wrong reason.
 */
export interface ShutdownOptions {
  /** Milliseconds to wait for in-flight requests before giving up. Default: config. */
  timeoutMs?: number;
  /** Whether to call `process.exit()` once hooks have run. Default: from config. */
  exitOnComplete?: boolean;
}

export interface ShutdownResult {
  signal: NodeJS.Signals | 'manual';
  drainedCleanly: boolean;
  durationMs: number;
  inFlightAtCompletion: number;
}

type HttpServerLike = {
  close?: (cb?: () => void) => void;
  closeIdleConnections?: () => void;
};

/**
 * Coordinates a graceful shutdown on `SIGTERM`/`SIGINT`.
 *
 * Previously the process installed no signal handler at all, so Node's default disposition
 * applied and the process died the instant an orchestrator sent `SIGTERM`. Every deploy
 * therefore killed in-flight requests, severed open WebSocket connections mid-message, and
 * skipped all of the `onModuleDestroy` hooks the app already had — including the one that
 * ends the PostgreSQL pool. For an API that settles escrow state, that is a data-integrity
 * problem, not just a dropped request.
 *
 * ## Why this does not use `app.enableShutdownHooks()`
 *
 * `enableShutdownHooks()` makes Nest install its own `SIGTERM`/`SIGINT` listeners that call
 * `app.close()` the moment a signal arrives. That does run the lifecycle hooks, but it leaves
 * no window to drain first, so it would preserve exactly the failure mode this replaces. The
 * hook *sequence* is still the right one; it is just invoked manually, after the drain, via
 * the `app.close()` below.
 */
@Injectable()
export class ShutdownService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new SanitizedLogger(ShutdownService.name);

  private app: INestApplication | null = null;
  private installed = false;
  private inProgress: Promise<ShutdownResult> | null = null;
  private readonly handlers = new Map<NodeJS.Signals, () => void>();

  private readonly timeoutMs: number;
  private readonly exitOnComplete: boolean;

  /**
   * `options` is `@Optional()` so Nest can construct the provider without an explicit token:
   * when it resolves to `undefined` the parameter default applies and production reads
   * `config`. Tests construct the service directly with explicit options.
   */
  constructor(
    private readonly drainState: DrainStateService,
    @Optional() options: ShutdownOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? config.SHUTDOWN_TIMEOUT_MS;
    this.exitOnComplete = options.exitOnComplete ?? config.SHUTDOWN_FORCE_EXIT !== 'false';
  }

  /** Called from `main.ts` once the HTTP server is listening. */
  registerApp(app: INestApplication): void {
    this.app = app;
  }

  onModuleInit(): void {
    if (this.installed) return;
    this.installed = true;

    for (const signal of SHUTDOWN_SIGNALS) {
      const handler = () => {
        void this.shutdown(signal);
      };
      this.handlers.set(signal, handler);
      process.on(signal, handler);
    }

    this.logger.log(
      `Graceful shutdown enabled (signals: ${SHUTDOWN_SIGNALS.join(', ')}, ` +
        `timeout: ${this.timeoutMs}ms)`,
    );
  }

  /**
   * Runs the drain and closes the app. Idempotent: a second signal arriving mid-drain returns
   * the in-flight promise rather than starting a competing shutdown, so an impatient operator
   * sending `SIGINT` cannot double-close the database pool.
   */
  shutdown(signal: NodeJS.Signals | 'manual' = 'manual'): Promise<ShutdownResult> {
    if (this.inProgress) return this.inProgress;
    this.inProgress = this.run(signal);
    return this.inProgress;
  }

  private async run(signal: NodeJS.Signals | 'manual'): Promise<ShutdownResult> {
    const startedAt = Date.now();
    this.logger.log(`Received ${signal} — beginning graceful shutdown`);

    // 1. Shed new work and fail the readiness probe, so the load balancer takes this instance
    //    out of rotation before any resource is closed.
    this.drainState.beginDrain();

    // 2. Close the listener. This stops accepting *new* connections while leaving sockets
    //    that are already established alone — the distinction that makes this a drain rather
    //    than a kill.
    this.stopAcceptingConnections();

    // 3. Wait for in-flight requests, bounded by the configured timeout.
    const drainedCleanly = await this.drainWithTimeout();
    if (!drainedCleanly) {
      this.logger.warn(
        `Drain did not complete within ${this.timeoutMs}ms — ` +
          `${this.drainState.inFlightCount()} in-flight request(s) will be severed`,
      );
    }

    // 4. Run Nest's lifecycle hooks (onModuleDestroy / beforeApplicationShutdown /
    //    onApplicationShutdown). This ends the PostgreSQL pool, clears the background worker
    //    timers, and unsubscribes the WebSocket gateway's Redis subscriber.
    await this.closeApp();

    const result: ShutdownResult = {
      signal,
      drainedCleanly,
      durationMs: Date.now() - startedAt,
      inFlightAtCompletion: this.drainState.inFlightCount(),
    };

    this.logger.log(
      `Graceful shutdown complete in ${result.durationMs}ms (drained cleanly: ${drainedCleanly})`,
    );

    this.exit(result);
    return result;
  }

  private async drainWithTimeout(): Promise<boolean> {
    if (this.drainState.inFlightCount() === 0) return true;

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      // `waitForDrain()` resolves with `void` on success; the timeout resolves with `false`.
      // Anything other than an explicit `false` therefore means the drain completed.
      const drained = await Promise.race([this.drainState.waitForDrain(), timedOut]);
      return drained !== false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Stops the HTTP listener without destroying established sockets, and additionally drops
   * keep-alive sockets that are idle between requests (Node 18.2+) so they do not hold the
   * process open for the full drain window.
   */
  private stopAcceptingConnections(): void {
    const server = this.app?.getHttpServer?.() as HttpServerLike | undefined;
    if (!server?.close) return;
    try {
      server.close();
      server.closeIdleConnections?.();
    } catch (error) {
      this.logger.error(`Failed to stop accepting connections: ${String(error)}`);
    }
  }

  private async closeApp(): Promise<void> {
    const app = this.app;
    this.app = null;
    if (!app) return;
    try {
      await app.close();
    } catch (error) {
      this.logger.error(`Error while closing the application: ${String(error)}`);
    }
  }

  /**
   * Exits explicitly once the lifecycle hooks are done.
   *
   * Necessary rather than cosmetic: ioredis reconnects on a retry schedule and the pg pool
   * holds timers, so after `app.close()` the event loop can stay alive indefinitely and the
   * orchestrator escalates to `SIGKILL` — reintroducing the hard kill this avoids.
   * `SHUTDOWN_FORCE_EXIT=false` skips it where something else owns the event loop (tests).
   */
  private exit(result: ShutdownResult): void {
    if (!this.exitOnComplete) return;
    process.exit(result.drainedCleanly ? CLEAN_EXIT_CODE : FORCED_EXIT_CODE);
  }

  /**
   * Runs when the app is closed by some other path (a test calling `app.close()`, or a
   * bootstrap failure). Removes the process listeners so a closed app neither keeps the
   * process alive nor fires a second drain.
   */
  onApplicationShutdown(): void {
    for (const [signal, handler] of this.handlers) {
      process.removeListener(signal, handler);
    }
    this.handlers.clear();
  }
}
