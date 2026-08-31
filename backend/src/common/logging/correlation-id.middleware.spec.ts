import { CorrelationIdMiddleware, CORRELATION_ID_HEADER } from './correlation-id.middleware';
import { CorrelationIdStore } from './correlation-id.store';
import { Request, Response } from 'express';
import { Logger } from '@nestjs/common';

function buildReqRes(inboundId?: string) {
  const req = {
    headers: inboundId ? { [CORRELATION_ID_HEADER]: inboundId } : {},
    method: 'GET',
    originalUrl: '/test',
    ip: '127.0.0.1',
  } as unknown as Request & { correlationId?: string };

  const headers: Record<string, string> = {};
  const res = {
    setHeader: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    _headers: headers,
  } as unknown as Response;

  return { req, res, headers };
}

describe('CorrelationIdMiddleware', () => {
  let store: CorrelationIdStore;
  let middleware: CorrelationIdMiddleware;

  beforeEach(() => {
    store = new CorrelationIdStore();
    middleware = new CorrelationIdMiddleware(store);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('generates a UUID correlation ID when no inbound header is present', done => {
    const { req, res } = buildReqRes();

    middleware.use(req, res, () => {
      expect(req.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      done();
    });
  });

  it('propagates an inbound X-Request-Id header instead of generating a new one', done => {
    const inbound = 'upstream-id-abc123';
    const { req, res } = buildReqRes(inbound);

    middleware.use(req, res, () => {
      expect(req.correlationId).toBe(inbound);
      done();
    });
  });

  it('echoes the correlation ID back in the X-Request-Id response header', done => {
    const { req, res, headers } = buildReqRes();

    middleware.use(req, res, () => {
      expect(headers[CORRELATION_ID_HEADER]).toBe(req.correlationId);
      done();
    });
  });

  it('makes the correlation ID available via CorrelationIdStore inside the async context', done => {
    const { req, res } = buildReqRes();

    middleware.use(req, res, () => {
      // Inside the next() callback we are running inside the store's async context.
      expect(store.get()).toBe(req.correlationId);
      done();
    });
  });

  it('returns undefined from the store outside a request context', () => {
    expect(store.get()).toBeUndefined();
  });

  it('keeps independent correlation IDs for concurrent requests', done => {
    const idA = 'request-a';
    const idB = 'request-b';
    const { req: reqA, res: resA } = buildReqRes(idA);
    const { req: reqB, res: resB } = buildReqRes(idB);

    let completedCount = 0;

    const finish = () => {
      completedCount++;
      if (completedCount === 2) done();
    };

    middleware.use(reqA, resA, () => {
      // Simulate async work inside request A's context
      setImmediate(() => {
        expect(store.get()).toBe(idA);
        finish();
      });
    });

    middleware.use(reqB, resB, () => {
      setImmediate(() => {
        expect(store.get()).toBe(idB);
        finish();
      });
    });
  });
});
