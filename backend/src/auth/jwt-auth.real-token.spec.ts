import { Controller, Get, INestApplication, Req, UseGuards } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from './auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { JWT_ALGORITHM, setTestEnv } from '../config/env.config';

@Controller('protected')
class ProtectedController {
  @Get()
  @UseGuards(JwtAuthGuard)
  getProtected(@Req() req: { user: { address: string; sub: string } }) {
    return req.user;
  }
}

describe('JwtAuthGuard and JwtStrategy real-token flow', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  beforeEach(async () => {
    setTestEnv({
      NODE_ENV: 'test',
      JWT_SECRET: 'real-token-test-secret-at-least-16-chars',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({
          secret: 'real-token-test-secret-at-least-16-chars',
          signOptions: { algorithm: JWT_ALGORITHM, expiresIn: '1h' },
        }),
      ],
      controllers: [ProtectedController],
      providers: [JwtStrategy],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    jwtService = moduleRef.get(JwtService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a real HS256 token and exposes the validated user', async () => {
    const token = jwtService.sign({
      address: 'GREALTOKENADDRESS',
      sub: 'GREALTOKENADDRESS',
    });

    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect({ address: 'GREALTOKENADDRESS', sub: 'GREALTOKENADDRESS' });
  });

  it('rejects a token signed with a different HMAC algorithm', async () => {
    const token = jwtService.sign(
      { address: 'GREALTOKENADDRESS', sub: 'GREALTOKENADDRESS' },
      { algorithm: 'HS384' },
    );

    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
