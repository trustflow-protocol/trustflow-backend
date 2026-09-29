import { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'net';
import type { NextFunction, Request, Response } from 'express';
import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { get as httpGet, type Server } from 'http';
import { ShutdownModule, ShutdownService, DrainStateService } from './shutdown.module';
import { DrainMiddleware } from './drain.middleware';

/**
 * End-to-end proof of the drain, over a real HTTP listener.
 *
 * The unit tests in `shutdown.spec.ts` exercise the coordinator against fakes. This suite
 * exists to cover the behaviour that actually caused deploys to drop transactions: a request
 * that has already been received must be allowed to finish when the process is signalled,
 * rather than having its socket torn out from under it.
 */

let handlerDelayMs = 0;

/** A deliberately slow route, standing in for a handler doing real work (settlement, RPC). */
@Controller('slow')
class SlowController {
  @Get()
  async run() {
    const startedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, handlerDelayMs));
    return { startedAt, finishedAt: Date.now() };
  }
}

@Controller('fast')
class FastController {
  @Get()
  ping() {
    return { ok: true };
  }
}

@Module({
  imports: [ShutdownModule],
  controllers: [SlowController, FastController],
})
class TestAppModule {}

describe('graceful shutdown (integration)', () => {
  let app: INestApplication;
  let shutdown: ShutdownService;
  let exit: jest.SpyInstance;

  beforeEach(async () => {
    handlerDelayMs = 0;
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Apply the same middleware AppModule applies, so the drain actually counts requests.
    const middleware = new DrainMiddleware(app.get(DrainStateService));
    app.use((req: Request, res: Response, next: NextFunction) => middleware.use(req, res, next));
    await app.init();
    await app.listen(0);

    shutdown = app.get(ShutdownService);
    shutdown.registerApp(app);
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    exit.mockRestore();
    // Release the drain so the server can close between tests.
    app.get(DrainStateService).beginDrain();
    await app.close();
  });

  it('lets an in-flight request complete before the app is closed', async () => {
    handlerDelayMs = 250;

    const server = app.getHttpServer() as Server;
    const { port } = server.address() as AddressInfo;
    expect(port).toBeGreaterThan(0);

    // A raw http.get is used rather than supertest because supertest is a lazy thenable —
    // it does not put a byte on the wire until it is awaited, so there would be no
    // in-flight request to drain.
    const inFlight = new Promise<{
      status: number;
      body: { startedAt: number; finishedAt: number };
    }>((resolve, reject) => {
      httpGet({ host: '127.0.0.1', port, path: '/slow' }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              startedAt: number;
              finishedAt: number;
            },
          }),
        );
      }).on('error', reject);
    });

    // Wait for the request to actually reach the handler and register as in-flight.
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(app.get(DrainStateService).inFlightCount()).toBe(1);

    const result = await shutdown.shutdown('SIGTERM');
    const response = await inFlight;

    expect(response.status).toBe(200);
    expect(result.drainedCleanly).toBe(true);
    // The handler ran to completion rather than being cut short mid-response.
    expect(response.body.finishedAt).toBeGreaterThanOrEqual(response.body.startedAt);
  });

  it('sheds a new request with 503 once the drain has begun', async () => {
    app.get(DrainStateService).beginDrain();

    const res = await request(app.getHttpServer() as Server).get('/fast');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('reports readiness as down while draining', () => {
    const drainState = app.get(DrainStateService);
    expect(drainState.isDraining()).toBe(false);

    drainState.beginDrain();
    expect(drainState.isDraining()).toBe(true);
  });
});
