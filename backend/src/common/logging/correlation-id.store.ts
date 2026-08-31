import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Thin wrapper around Node's `AsyncLocalStorage` that holds the correlation ID for the
 * currently-executing async context (i.e. a single HTTP request's call chain).
 *
 * Inject this service wherever you need the current request's correlation ID without
 * passing it explicitly through every layer.
 */
@Injectable()
export class CorrelationIdStore {
  private readonly storage = new AsyncLocalStorage<string>();

  /** Execute `fn` in an async context bound to `correlationId`. */
  run<T>(correlationId: string, fn: () => T): T {
    return this.storage.run(correlationId, fn);
  }

  /** Returns the correlation ID for the current async context, or `undefined` outside a request. */
  get(): string | undefined {
    return this.storage.getStore();
  }
}
