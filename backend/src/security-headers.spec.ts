import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import request from 'supertest';

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
      controllers: [HealthController],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirror bootstrap() Helmet configuration from src/main.ts
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: [`'self'`],
            styleSrc: [`'self'`, `'unsafe-inline'`],
            imgSrc: [`'self'`, 'data:', 'https:'],
            scriptSrc: [`'self'`, `'unsafe-inline'`],
          },
        },
        crossOriginEmbedderPolicy: false,
      }),
    );

    // Setup Swagger docs to verify CSP compatibility
    const config = new DocumentBuilder().setTitle('Test API').setVersion('1.0.0').build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

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
