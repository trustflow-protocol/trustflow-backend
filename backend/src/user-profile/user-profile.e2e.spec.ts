import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { RedisModule } from '../common/redis/redis.module';
import { SentryModule } from '../sentry/sentry.module';
import { LoggingModule } from '../common/logging/logging.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { configureApp } from '../app.setup';
import { validateEnv } from '../config/env.config';
import { UserProfileModule } from './user-profile.module';
import { UserType } from './user-profile.entity';

// configureApp() reads config.* — requires validateEnv() to have run first.
validateEnv();

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
      imports: [
        RedisModule,
        AuthModule,
        UserProfileModule,
        SentryModule,
        LoggingModule,
        MonitoringModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app, { skipSentryInit: true, skipIndexerStart: true });
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

// Covers #446: the read endpoints used to return the raw stored profile, so anyone could
// harvest every registered user's email address with one list, search or lookup call.
describe('UserProfile (E2E) — email privacy', () => {
  let app: INestApplication;
  let authService: AuthService;

  const OWNER_ADDRESS = 'G' + 'C'.repeat(55);
  const OTHER_ADDRESS = 'G' + 'D'.repeat(55);
  const OWNER_EMAIL = 'private.owner@example.com';
  const OWNER_NAME = 'Privacy Probe Owner';
  let profileId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        RedisModule,
        AuthModule,
        UserProfileModule,
        SentryModule,
        LoggingModule,
        MonitoringModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app, { skipSentryInit: true, skipIndexerStart: true });
    await app.init();
    authService = moduleFixture.get<AuthService>(AuthService);

    const created = await request(app.getHttpServer())
      .post('/profiles')
      .set('Authorization', `Bearer ${authService.generateToken(OWNER_ADDRESS)}`)
      .send({
        walletAddress: OWNER_ADDRESS,
        name: OWNER_NAME,
        userType: UserType.FREELANCER,
        email: OWNER_EMAIL,
      })
      .expect(201);
    profileId = created.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const ownerToken = () => `Bearer ${authService.generateToken(OWNER_ADDRESS)}`;

  it('returns the email to the owner when they create their profile', async () => {
    const res = await request(app.getHttpServer())
      .post('/profiles')
      .set('Authorization', `Bearer ${authService.generateToken(OTHER_ADDRESS)}`)
      .send({
        walletAddress: OTHER_ADDRESS,
        name: 'Second Owner',
        userType: UserType.CLIENT,
        email: 'second.owner@example.com',
      })
      .expect(201);

    expect(res.body.email).toBe('second.owner@example.com');
  });

  it('omits the email from the unauthenticated list', async () => {
    const res = await request(app.getHttpServer()).get('/profiles').expect(200);

    expect(res.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('@example.com');
    for (const profile of res.body.data) expect(profile).not.toHaveProperty('email');
  });

  it('omits the email from search results', async () => {
    const res = await request(app.getHttpServer())
      .get('/profiles/search')
      .query({ q: 'Privacy Probe' })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe(OWNER_NAME);
    expect(JSON.stringify(res.body)).not.toContain(OWNER_EMAIL);
  });

  it('omits the email from a lookup by id', async () => {
    const res = await request(app.getHttpServer()).get(`/profiles/${profileId}`).expect(200);

    expect(res.body.name).toBe(OWNER_NAME);
    expect(res.body).not.toHaveProperty('email');
  });

  it('omits the email from a lookup by wallet address', async () => {
    const res = await request(app.getHttpServer())
      .get(`/profiles/wallet/${OWNER_ADDRESS}`)
      .expect(200);

    expect(res.body.walletAddress).toBe(OWNER_ADDRESS);
    expect(res.body).not.toHaveProperty('email');
  });

  it('does not reveal the email to another authenticated user through GET /profiles/:id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/profiles/${profileId}`)
      .set('Authorization', `Bearer ${authService.generateToken(OTHER_ADDRESS)}`)
      .expect(200);

    expect(res.body).not.toHaveProperty('email');
  });

  it('lets the owner read their own email through GET /profiles/me', async () => {
    const res = await request(app.getHttpServer())
      .get('/profiles/me')
      .set('Authorization', ownerToken())
      .expect(200);

    expect(res.body.walletAddress).toBe(OWNER_ADDRESS);
    expect(res.body.email).toBe(OWNER_EMAIL);
  });

  it('requires authentication for GET /profiles/me', async () => {
    await request(app.getHttpServer()).get('/profiles/me').expect(401);
  });

  it('answers 404 on GET /profiles/me for a wallet without a profile', async () => {
    const stranger = 'G' + 'E'.repeat(55);
    await request(app.getHttpServer())
      .get('/profiles/me')
      .set('Authorization', `Bearer ${authService.generateToken(stranger)}`)
      .expect(404);
  });

  it('returns the email from an update only to the owner', async () => {
    const asOwner = await request(app.getHttpServer())
      .put(`/profiles/${profileId}`)
      .set('Authorization', ownerToken())
      .send({ bio: 'Updated by the owner' })
      .expect(200);
    expect(asOwner.body.email).toBe(OWNER_EMAIL);

    const asOther = await request(app.getHttpServer())
      .put(`/profiles/${profileId}`)
      .set('Authorization', `Bearer ${authService.generateToken(OTHER_ADDRESS)}`)
      .send({ bio: 'Updated by someone else' })
      .expect(200);
    expect(asOther.body).not.toHaveProperty('email');
  });
});
