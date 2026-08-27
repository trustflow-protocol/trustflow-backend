import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { IpfsPinningModule } from './ipfs-pinning.module';
import { JwtStrategy } from '../auth/jwt.strategy';
import { computeCidV1Raw } from './cid.util';
import {
  IpfsPinProvider,
  PIN_PROVIDERS,
  PinProviderName,
} from './providers/ipfs-provider.interface';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'ipfs-pinning-e2e-secret';

/**
 * Stands in for a real IPFS pinning backend (Pinata/web3.storage/Infura) — this is the
 * "mock the external IPFS provider" these API integration tests are scoped to: full
 * control over success/failure per test, with zero network access, exercised through the
 * same PIN_PROVIDERS DI token IpfsPinningModule wires the real HTTP providers through.
 */
class FakePinProvider extends IpfsPinProvider {
  readonly name: PinProviderName;
  readonly pinned = new Map<string, Buffer>();
  failPin = false;
  failVerify = false;

  constructor(name: PinProviderName) {
    super();
    this.name = name;
  }

  get isConfigured(): boolean {
    return true;
  }

  async pin(cid: string, content: Buffer): Promise<void> {
    if (this.failPin) throw new Error(`${this.name} refused the pin`);
    this.pinned.set(cid, content);
  }

  async unpin(cid: string): Promise<void> {
    this.pinned.delete(cid);
  }

  async verify(cid: string): Promise<boolean> {
    if (this.failVerify) return false;
    return this.pinned.has(cid);
  }

  reset(): void {
    this.pinned.clear();
    this.failPin = false;
    this.failVerify = false;
  }
}

describe('IPFS Pinning (API integration)', () => {
  let app: INestApplication;
  let providerA: FakePinProvider;
  let providerB: FakePinProvider;
  let authHeader: string;

  const CONTENT_BASE64 = Buffer.from('Hello, TrustFlow!').toString('base64');
  const EXPECTED_CID = computeCidV1Raw(Buffer.from(CONTENT_BASE64, 'base64'));

  beforeAll(async () => {
    providerA = new FakePinProvider(PinProviderName.PINATA);
    providerB = new FakePinProvider(PinProviderName.WEB3_STORAGE);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        IpfsPinningModule,
        JwtModule.register({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '1h' } }),
        PassportModule.register({ defaultStrategy: 'jwt' }),
      ],
      providers: [JwtStrategy],
    })
      .overrideProvider(PIN_PROVIDERS)
      .useValue([providerA, providerB])
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    const address = 'GTESTADDRESS1111111111111111111111111111111111111PINS';
    authHeader = `Bearer ${jwtService.sign({ address, sub: address })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    providerA.reset();
    providerB.reset();
  });

  describe('authentication', () => {
    it('rejects a pin request with no bearer token', async () => {
      await request(app.getHttpServer())
        .post('/ipfs/pins')
        .send({ content: CONTENT_BASE64 })
        .expect(401);
    });

    it('rejects a list request with no bearer token', async () => {
      await request(app.getHttpServer()).get('/ipfs/pins').expect(401);
    });
  });

  describe('POST /ipfs/pins', () => {
    it('pins across both configured providers and returns a HEALTHY record', async () => {
      const res = await request(app.getHttpServer())
        .post('/ipfs/pins')
        .set('Authorization', authHeader)
        .send({ content: CONTENT_BASE64, filename: 'hello.txt' })
        .expect(201);

      expect(res.body.cid).toBe(EXPECTED_CID);
      expect(res.body.status).toBe('HEALTHY');
      expect(res.body.providers).toHaveLength(2);
      expect(res.body.providers.every((p: any) => p.status === 'PINNED')).toBe(true);
      expect(providerA.pinned.has(EXPECTED_CID)).toBe(true);
      expect(providerB.pinned.has(EXPECTED_CID)).toBe(true);
    });

    it('rejects content that does not match expectedCid, without contacting any provider', async () => {
      await request(app.getHttpServer())
        .post('/ipfs/pins')
        .set('Authorization', authHeader)
        .send({ content: CONTENT_BASE64, expectedCid: 'bafkreiwrongcidvaluefortestpurposesonly' })
        .expect(400);

      expect(providerA.pinned.size).toBe(0);
      expect(providerB.pinned.size).toBe(0);
    });

    it('fails over to the remaining provider and reports DEGRADED when one provider fails', async () => {
      providerA.failPin = true;

      const res = await request(app.getHttpServer())
        .post('/ipfs/pins')
        .set('Authorization', authHeader)
        .send({ content: CONTENT_BASE64 })
        .expect(201);

      expect(res.body.status).toBe('DEGRADED');
      const byProvider = Object.fromEntries(
        res.body.providers.map((p: any) => [p.provider, p.status]),
      );
      expect(byProvider[PinProviderName.PINATA]).toBe('FAILED');
      expect(byProvider[PinProviderName.WEB3_STORAGE]).toBe('PINNED');
    });

    it('returns 503 when every registered provider fails to pin', async () => {
      providerA.failPin = true;
      providerB.failPin = true;

      await request(app.getHttpServer())
        .post('/ipfs/pins')
        .set('Authorization', authHeader)
        .send({ content: CONTENT_BASE64 })
        .expect(503);
    });
  });

  describe('GET /ipfs/pins and /ipfs/pins/:cid', () => {
    it('lists a pin created via POST and fetches it by CID', async () => {
      await request(app.getHttpServer())
        .post('/ipfs/pins')
        .set('Authorization', authHeader)
        .send({ content: CONTENT_BASE64 })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get('/ipfs/pins')
        .set('Authorization', authHeader)
        .expect(200);
      expect(list.body.some((p: any) => p.cid === EXPECTED_CID)).toBe(true);

      const single = await request(app.getHttpServer())
        .get(`/ipfs/pins/${EXPECTED_CID}`)
        .set('Authorization', authHeader)
        .expect(200);
      expect(single.body.cid).toBe(EXPECTED_CID);
    });

    it('returns 404 for an unknown CID', async () => {
      await request(app.getHttpServer())
        .get('/ipfs/pins/bafkreiunknowncidnotpinnedanywhereatall')
        .set('Authorization', authHeader)
        .expect(404);
    });
  });

  describe('POST /ipfs/pins/:cid/verify', () => {
    it('automatically restores replication when a provider silently loses the pin', async () => {
      await request(app.getHttpServer())
        .post('/ipfs/pins')
        .set('Authorization', authHeader)
        .send({ content: CONTENT_BASE64 })
        .expect(201);

      // Simulate provider A silently dropping the pin between calls (no failVerify flag —
      // this mirrors a real provider that just no longer has the content).
      providerA.pinned.delete(EXPECTED_CID);

      const res = await request(app.getHttpServer())
        .post(`/ipfs/pins/${EXPECTED_CID}/verify`)
        .set('Authorization', authHeader)
        .expect(200);

      expect(res.body.status).toBe('HEALTHY');
      // The reconcile pass should have re-pinned to provider A to top replication back up.
      expect(providerA.pinned.has(EXPECTED_CID)).toBe(true);
    });

    it('returns 404 when verifying an unknown CID', async () => {
      await request(app.getHttpServer())
        .post('/ipfs/pins/bafkreiunknowncidnotpinnedanywhereatall/verify')
        .set('Authorization', authHeader)
        .expect(404);
    });
  });

  describe('DELETE /ipfs/pins/:cid', () => {
    it('unpins from every provider currently holding the content', async () => {
      await request(app.getHttpServer())
        .post('/ipfs/pins')
        .set('Authorization', authHeader)
        .send({ content: CONTENT_BASE64 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .delete(`/ipfs/pins/${EXPECTED_CID}`)
        .set('Authorization', authHeader)
        .expect(200);

      expect(res.body.status).toBe('UNPINNED');
      expect(providerA.pinned.has(EXPECTED_CID)).toBe(false);
      expect(providerB.pinned.has(EXPECTED_CID)).toBe(false);
    });

    it('returns 404 when unpinning an unknown CID', async () => {
      await request(app.getHttpServer())
        .delete('/ipfs/pins/bafkreiunknowncidnotpinnedanywhereatall')
        .set('Authorization', authHeader)
        .expect(404);
    });
  });
});
