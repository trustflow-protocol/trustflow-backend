import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { DatabaseService } from './common/database/database.service';
import { JwtAuthGuard } from './auth/auth.guard';
import { EscrowService } from './escrow/escrow.service';

describe('API Version Routing', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      // override db service to prevent postgres connection attempts in test
      .overrideProvider(DatabaseService)
      .useValue({
        isConfigured: false,
        getPool: jest.fn(),
        query: jest.fn(),
      })
      .overrideProvider(EscrowService)
      .useValue({
        findById: jest.fn(),
        release: jest.fn(),
      })
      .compile();

    app = module.createNestApplication();
    
    // We test that configureApp enables URI version routing with v1 default
    configureApp(app, { skipSentryInit: true, skipIndexerStart: true });
    
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('routes to v1 by default', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.status).toBe(200);
    
    const resUnversioned = await request(app.getHttpServer()).get('/health');
    expect(resUnversioned.status).toBe(404);
  });
});
