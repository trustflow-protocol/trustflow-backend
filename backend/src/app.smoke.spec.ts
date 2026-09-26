/**
 * Smoke test for application bootstrap — verifies AppModule DI compilation and startup.
 * Catches DI token cycles, missing providers, startup state issues (#480).
 */

import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

describe('AppModule bootstrap (smoke test)', () => {
  let app: INestApplication;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('compiles the AppModule DI container without errors', async () => {
    app = await NestFactory.create(AppModule);
    expect(app).toBeDefined();
  });

  it('successfully starts the app and listens on a port', async () => {
    app = await NestFactory.create(AppModule);
    configureApp(app, { skipSentryInit: true, skipIndexerStart: true });

    const port = 0;
    const server = await app.listen(port);

    expect(server).toBeDefined();
    const address = server.address();
    expect(address).toBeDefined();
    if (typeof address === 'object' && address !== null) {
      expect(address.port).toBeGreaterThan(0);
    }
  });
});
