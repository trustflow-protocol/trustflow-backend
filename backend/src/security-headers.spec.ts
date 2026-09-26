import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get } from '@nestjs/common';
import request from 'supertest';
import { configureApp } from './app.setup';
import { SentryModule } from './sentry/sentry.module';
import { LoggingModule } from './common/logging/logging.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { validateEnv } from './config/env.config';

// configureApp() reads config.BODY_LIMIT_MB/CORS_ORIGIN/NODE_ENV, which requires
// validateEnv() to have run first — normally done once in main.ts.
validateEnv();

@Controller('health')
class HealthController {
  @Get()
  getHealth() {
    return { status: 'ok' };
  }
}

describe('Security Headers (Helmet)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      // SentryModule/LoggingModule/MonitoringModule provide the SentryService,
      // CorrelationIdStore and MetricsHttpInterceptor that configureApp() wires up —
      // the same stack a real request goes through, rather than a hand-rolled subset.
      imports: [SentryModule, LoggingModule, MonitoringModule],
      controllers: [HealthController],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Exercise the real Helmet config and Swagger UI mounting from configureApp(),
    // not a hand-copied subset — this is the regression #420-style drift guards against.
    configureApp(app, { skipSentryInit: true, skipIndexerStart: true });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Standard Security Headers', () => {
    it('returns standard Helmet security headers on API responses', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-dns-prefetch-control']).toBe('off');
      expect(res.headers['x-download-options']).toBe('noopen');
      expect(res.headers['x-permitted-cross-domain-policies']).toBe('none');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('returns Content-Security-Policy with Swagger UI-compatible directives', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);

      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("img-src 'self' data: https:");
    });
  });

  describe('Swagger UI (/api/docs)', () => {
    it('serves Swagger UI endpoint successfully with security headers', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs/').expect(200);

      expect(res.text).toContain('swagger-ui');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeDefined();
    });
  });
});
