import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { RedisModule } from '../common/redis/redis.module';
import { UserProfileModule } from './user-profile.module';
import { UserType } from './user-profile.entity';

// Covers #205: POST /profiles previously had no auth guard at all, so
// anyone could create a profile for any wallet address without proving
// they controlled it. These tests exercise the real JwtAuthGuard/
// JwtStrategy pipeline (not a mocked guard) via supertest, the same way
// auth.e2e-spec.ts does for the auth flow itself.
describe('UserProfile (E2E) — POST /profiles auth', () => {
  let app: INestApplication;
  let authService: AuthService;

  // Stellar addresses are base32 (A-Z, 2-7 only — no 0/1/8/9), enforced by
  // STELLAR_ADDRESS_REGEX in user-profile.dto.ts; these must satisfy it or
  // CreateUserProfileSchema.parse() throws before the auth check ever runs.
  const OWNER_ADDRESS = 'G' + 'A'.repeat(55);
  const OTHER_ADDRESS = 'G' + 'B'.repeat(55);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      // RedisModule is @Global() in the real app (bootstrapped once via
      // AppModule), but a standalone TestingModule needs it imported
      // explicitly — AuthModule's NonceStoreService depends on its
      // REDIS_CLIENT token even though nothing in this spec touches nonces.
      imports: [RedisModule, AuthModule, UserProfileModule],
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

  function payload(walletAddress: string) {
    return {
      walletAddress,
      name: 'Jane Doe',
      userType: UserType.FREELANCER,
    };
  }

  it('rejects an unauthenticated request', async () => {
    const res = await request(app.getHttpServer())
      .post('/profiles')
      .send(payload(OWNER_ADDRESS))
      .expect(401);

    expect(res.body.message).toBeDefined();
  });

  it('rejects a walletAddress that does not match the authenticated wallet', async () => {
    const token = authService.generateToken(OWNER_ADDRESS);

    const res = await request(app.getHttpServer())
      .post('/profiles')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(OTHER_ADDRESS))
      .expect(403);

    expect(res.body.message).toContain('walletAddress must match');
  });

  it('creates the profile when walletAddress matches the authenticated wallet', async () => {
    const token = authService.generateToken(OWNER_ADDRESS);

    const res = await request(app.getHttpServer())
      .post('/profiles')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(OWNER_ADDRESS))
      .expect(201);

    expect(res.body.walletAddress).toBe(OWNER_ADDRESS);
  });

  it('rejects a re-registration attempt for an address that was never proven-owned', async () => {
    // Regression for the original bug: an attacker who squatted on
    // OTHER_ADDRESS before its real owner registered would have locked the
    // real owner out via ConflictException. With the identity check in
    // place, the attacker's request never gets past 403 in the first
    // place, so the real owner's own authenticated attempt succeeds.
    const attackerToken = authService.generateToken(OWNER_ADDRESS);
    await request(app.getHttpServer())
      .post('/profiles')
      .set('Authorization', `Bearer ${attackerToken}`)
      .send(payload(OTHER_ADDRESS))
      .expect(403);

    const realOwnerToken = authService.generateToken(OTHER_ADDRESS);
    const res = await request(app.getHttpServer())
      .post('/profiles')
      .set('Authorization', `Bearer ${realOwnerToken}`)
      .send(payload(OTHER_ADDRESS))
      .expect(201);

    expect(res.body.walletAddress).toBe(OTHER_ADDRESS);
  });
});
