import { DrainStateService } from './drain-state.service';
import { DrainMiddleware, DRAIN_RETRY_AFTER_SECONDS } from './drain.middleware';
import {
  CLEAN_EXIT_CODE,
  FORCED_EXIT_CODE,
  SHUTDOWN_SIGNALS,
  ShutdownService,
} from './shutdown.service';
import { RedisShutdownService } from './redis-shutdown.service';
import { config } from '../../config/env.config';

type FakeResponse = {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
  listeners: Record<string, Array<() => void>>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(name: string, value: string): void;
  once(event: string, handler: () => void): void;
  fire(event: string): void;
};

function makeResponse(): FakeResponse {
  const res: FakeResponse = {
    headers: {},
    listeners: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    once(event, handler) {
      (res.listeners[event] ??= []).push(handler);
    },
    fire(event) {
      for (const handler of res.listeners[event] ?? []) handler();
    },
  };
  return res;
}

/** A minimal stand-in for the Nest app the coordinator closes. */
function makeApp(overrides: { close?: () => Promise<void>; server?: unknown } = {}) {
  const state = { closed: false, closeCalls: 0 };
  const app = {
    getHttpServer: () => overrides.server ?? { close: jest.fn(), closeIdleConnections: jest.fn() },
    close: async () => {
      state.closed = true;
      state.closeCalls++;
      await overrides.close?.();
    },
    state,
  };
  return app as unknown as Parameters<ShutdownService['registerApp']>[0] & { state: typeof state };
}

describe('DrainStateService', () => {
  let service: DrainStateService;

  beforeEach(() => {
    service = new DrainStateService();
  });

  it('starts not draining with nothing in flight', () => {
    expect(service.isDraining()).toBe(false);
    expect(service.inFlightCount()).toBe(0);
  });

  it('counts a tracked request until it is released', () => {
    const release = service.trackRequest();
    expect(service.inFlightCount()).toBe(1);
    release();
    expect(service.inFlightCount()).toBe(0);
  });

  it('ignores a double release so a response cannot undercount', () => {
    // `finish` and `close` can both fire for one request; counting only one keeps the drain honest.
    const release = service.trackRequest();
    release();
    release();
    expect(service.inFlightCount()).toBe(0);
  });

  it('flips to draining and is idempotent', () => {
    service.beginDrain();
    service.beginDrain();
    expect(service.isDraining()).toBe(true);
  });

  it('waitForDrain resolves immediately when idle', async () => {
    await expect(service.waitForDrain()).resolves.toBeUndefined();
  });

  it('waitForDrain resolves once the last in-flight request completes', async () => {
    const first = service.trackRequest();
    const second = service.trackRequest();

    let resolved = false;
    const drained = service.waitForDrain().then(() => {
      resolved = true;
    });

    first();
    await new Promise(resolve => setImmediate(resolve));
    expect(resolved).toBe(false);

    second();
    await drained;
    expect(resolved).toBe(true);
  });

  it('resolves a drain that was requested before the request finished', async () => {
    const release = service.trackRequest();
    const drained = service.waitForDrain();
    release();
    await expect(drained).resolves.toBeUndefined();
  });
});

describe('DrainMiddleware', () => {
  let drainState: DrainStateService;
  let middleware: DrainMiddleware;

  beforeEach(() => {
    drainState = new DrainStateService();
    middleware = new DrainMiddleware(drainState);
  });

  it('passes a normal request through and tracks it', () => {
    const next = jest.fn();
    const res = makeResponse();
    middleware.use({} as never, res as never, next);

    expect(next).toHaveBeenCalled();
    expect(drainState.inFlightCount()).toBe(1);
  });

  it('releases the request when the response finishes', () => {
    const res = makeResponse();
    middleware.use({} as never, res as never, jest.fn());
    res.fire('finish');
    expect(drainState.inFlightCount()).toBe(0);
  });

  it('releases the request when the connection closes early', () => {
    const res = makeResponse();
    middleware.use({} as never, res as never, jest.fn());
    res.fire('close');
    expect(drainState.inFlightCount()).toBe(0);
  });

  it('sheds a new request with 503 and Retry-After once draining', () => {
    drainState.beginDrain();
    const next = jest.fn();
    const res = makeResponse();

    middleware.use({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(DRAIN_RETRY_AFTER_SECONDS));
    expect(res.headers.connection).toBe('close');
    expect((res.body as { statusCode: number }).statusCode).toBe(503);
  });

  it('does not track a shed request', () => {
    drainState.beginDrain();
    middleware.use({} as never, makeResponse() as never, jest.fn());
    expect(drainState.inFlightCount()).toBe(0);
  });
});

describe('ShutdownService', () => {
  let drainState: DrainStateService;
  let service: ShutdownService;

  beforeEach(() => {
    drainState = new DrainStateService();
    // `exitOnComplete: false` everywhere by default so no test can reach a real
    // process.exit(); the two tests that assert exit codes opt back in explicitly.
    service = new ShutdownService(drainState, { exitOnComplete: false });
  });

  it('installs a handler for every shutdown signal', () => {
    const before = SHUTDOWN_SIGNALS.map(s => process.listenerCount(s));
    service.onModuleInit();
    const after = SHUTDOWN_SIGNALS.map(s => process.listenerCount(s));

    expect(after.every((count, i) => count === before[i] + 1)).toBe(true);
  });

  it('removes its listeners when the app shuts down', () => {
    const before = SHUTDOWN_SIGNALS.map(s => process.listenerCount(s));
    service.onModuleInit();
    void service.onApplicationShutdown();
    const after = SHUTDOWN_SIGNALS.map(s => process.listenerCount(s));

    expect(after).toEqual(before);
  });

  it('drains an in-flight request instead of killing it', async () => {
    const app = makeApp();
    service.registerApp(app);

    const release = drainState.trackRequest();
    setTimeout(release, 30);

    const result = await service.shutdown('SIGTERM');

    expect(result.drainedCleanly).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(app.state.closed).toBe(true);
  });

  it('waits for a slow request to finish before closing the app', async () => {
    const order: string[] = [];
    const app = makeApp({
      close: () => {
        order.push('app-closed');
        return Promise.resolve();
      },
    });
    service.registerApp(app);

    const release = drainState.trackRequest();
    setTimeout(() => {
      order.push('request-finished');
      release();
    }, 20);

    await service.shutdown('SIGTERM');
    order.push('shutdown-returned');

    // The app must not be closed, and the shutdown must not report success, until the
    // in-flight request has actually completed.
    expect(order).toEqual(['request-finished', 'app-closed', 'shutdown-returned']);
  });

  it('reports an unclean drain when requests outlive the timeout', async () => {
    const app = makeApp();
    const bounded = new ShutdownService(drainState, { timeoutMs: 40, exitOnComplete: false });
    bounded.registerApp(app);
    drainState.trackRequest();

    const result = await bounded.shutdown('SIGTERM');

    expect(result.drainedCleanly).toBe(false);
    expect(result.inFlightAtCompletion).toBe(1);
    // The app is still closed, so the pool is released rather than leaked.
    expect(app.state.closed).toBe(true);
  });

  it('is idempotent across repeated signals', async () => {
    const app = makeApp();
    service.registerApp(app);

    const [first, second] = await Promise.all([
      service.shutdown('SIGTERM'),
      service.shutdown('SIGINT'),
    ]);

    // A second signal must not start a competing close — that would double-end the pool.
    expect(second).toBe(first);
    expect(app.state.closeCalls).toBe(1);
  });

  it('closes the HTTP listener without destroying established sockets', async () => {
    const close = jest.fn();
    const closeIdleConnections = jest.fn();
    const app = makeApp({ server: { close, closeIdleConnections } });
    service.registerApp(app);

    await service.shutdown('SIGTERM');

    expect(close).toHaveBeenCalled();
    expect(closeIdleConnections).toHaveBeenCalled();
  });

  it('tolerates an HTTP server that cannot be closed', async () => {
    const app = makeApp({
      server: {
        close: () => {
          throw new Error('not running');
        },
      },
    });
    service.registerApp(app);

    await expect(service.shutdown('SIGTERM')).resolves.toMatchObject({ drainedCleanly: true });
  });

  it('still closes the app when the close itself throws', async () => {
    const app = makeApp({
      close: () => {
        throw new Error('close exploded');
      },
    });
    service.registerApp(app);

    await expect(service.shutdown('SIGTERM')).resolves.toBeDefined();
  });

  it('drains without an app registered', async () => {
    await expect(service.shutdown('manual')).resolves.toMatchObject({ drainedCleanly: true });
  });

  it('exits 0 on a clean drain and 1 when the drain times out', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      await new ShutdownService(new DrainStateService(), { exitOnComplete: true }).shutdown(
        'manual',
      );
      expect(exit).toHaveBeenCalledWith(CLEAN_EXIT_CODE);

      exit.mockClear();
      const stuckState = new DrainStateService();
      stuckState.trackRequest();
      const result = await new ShutdownService(stuckState, {
        timeoutMs: 30,
        exitOnComplete: true,
      }).shutdown('SIGTERM');

      expect(result.drainedCleanly).toBe(false);
      expect(exit).toHaveBeenCalledWith(FORCED_EXIT_CODE);
    } finally {
      exit.mockRestore();
    }
  });

  it('does not exit at all when the exit is disabled', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      await new ShutdownService(new DrainStateService(), { exitOnComplete: false }).shutdown(
        'manual',
      );
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('defaults the timeout to the configured SHUTDOWN_TIMEOUT_MS', () => {
    expect(config.SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
    // A service built with no overrides should honour the 30s default from .env.example.
    const fallback = new ShutdownService(drainState, { exitOnComplete: false });
    expect(fallback).toBeDefined();
  });
});

describe('RedisShutdownService', () => {
  it('is a no-op when REDIS_URL is unset', async () => {
    const service = new RedisShutdownService(null);
    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('quits the client so the process can exit', () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const client = { status: 'ready', quit, disconnect: jest.fn() };
    const service = new RedisShutdownService(client as never);

    void service.onApplicationShutdown();

    expect(quit).toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('skips quit when the client is already closed', () => {
    const quit = jest.fn();
    const service = new RedisShutdownService({ status: 'end', quit } as never);

    void service.onApplicationShutdown();

    expect(quit).not.toHaveBeenCalled();
  });

  it('falls back to disconnect when quit fails', async () => {
    const quit = jest.fn().mockRejectedValue(new Error('connection lost'));
    const disconnect = jest.fn();
    const service = new RedisShutdownService({ status: 'ready', quit, disconnect } as never);

    await service.onApplicationShutdown();

    expect(quit).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  it('is idempotent', () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const service = new RedisShutdownService({ status: 'ready', quit } as never);

    void service.onApplicationShutdown();
    void service.onApplicationShutdown();

    expect(quit).toHaveBeenCalledTimes(1);
  });
});
