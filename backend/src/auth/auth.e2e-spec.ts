import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';

describe('Auth (E2E)', () => {
  let app: INestApplication;
  let authService: AuthService;

  const TEST_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    authService = moduleFixture.get<AuthService>(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /auth/challenge', () => {
    it('returns a challenge string for a valid address', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/challenge')
        .query({ address: TEST_ADDRESS })
        .expect(200);

      expect(res.body).toHaveProperty('challenge');
      expect(typeof res.body.challenge).toBe('string');
      expect(res.body.challenge).toContain('Sign this message to authenticate with TrustFlow:');
    });

    it('returns 400 or error when address is missing', async () => {
      const res = await request(app.getHttpServer()).get('/auth/challenge').expect(500);

      // The controller throws a raw Error('address required') which NestJS turns into 500
      expect(res.status).toBe(500);
    });
  });

  describe('POST /auth/verify', () => {
    it('returns a JWT token for a valid signature', async () => {
      // First get a challenge
      const challengeRes = await request(app.getHttpServer())
        .get('/auth/challenge')
        .query({ address: TEST_ADDRESS })
        .expect(200);

      const challenge = challengeRes.body.challenge;

      // Mock the signature verification to return true
      jest.spyOn(authService, 'verifySignature').mockResolvedValueOnce(true);
      jest.spyOn(authService, 'generateToken').mockReturnValueOnce('mock-e2e-jwt-token');

      const verifyRes = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ address: TEST_ADDRESS, signature: 'SGVsbG8gV29ybGQh' })
        .expect(200);

      expect(verifyRes.body).toHaveProperty('token');
      expect(verifyRes.body.token).toBe('mock-e2e-jwt-token');

      jest.restoreAllMocks();
    });

    it('returns 500 for an invalid signature', async () => {
      // Get a challenge first
      await request(app.getHttpServer())
        .get('/auth/challenge')
        .query({ address: TEST_ADDRESS })
        .expect(200);

      // Mock verifySignature to return false
      jest.spyOn(authService, 'verifySignature').mockResolvedValueOnce(false);

      const res = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ address: TEST_ADDRESS, signature: 'invalid-sig' })
        .expect(500);

      jest.restoreAllMocks();
    });

    it('rejects request with missing address field', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ signature: 'SGVsbG8gV29ybGQh' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('rejects request with missing signature field', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ address: TEST_ADDRESS })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });
  });

  describe('full auth flow', () => {
    it('challenge → verify → token works end-to-end', async () => {
      // Step 1: Get challenge
      const challengeRes = await request(app.getHttpServer())
        .get('/auth/challenge')
        .query({ address: TEST_ADDRESS })
        .expect(200);

      const challenge = challengeRes.body.challenge;
      expect(challenge).toBeTruthy();

      // Step 2: Verify signature and get token
      jest.spyOn(authService, 'verifySignature').mockResolvedValueOnce(true);
      jest.spyOn(authService, 'generateToken').mockReturnValueOnce('flow-jwt-token');

      const verifyRes = await request(app.getHttpServer())
        .post('/auth/verify')
        .send({ address: TEST_ADDRESS, signature: 'dGVzdC1zaWduYXR1cmU=' })
        .expect(200);

      expect(verifyRes.body.token).toBe('flow-jwt-token');

      jest.restoreAllMocks();
    });
  });
});
