import { Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Redis } from 'ioredis';
import { JWT_ALGORITHM, getJwtVerificationSecrets } from '../config/env.config';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import { isTokenRevoked } from './token-denylist';

export interface JwtPayload {
  address: string;
  sub: string;
  iat: number;
  exp: number;
  /** Set on impersonation sessions: the admin wallet acting as `address` (#944). */
  impersonatedBy?: string;
}

const extractBearer = ExtractJwt.fromAuthHeaderAsBearerToken();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly jwtService: JwtService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis | null,
  ) {
    super({
      jwtFromRequest: extractBearer,
      ignoreExpiration: false,
      secretOrPublicKeyProvider: (_request: any, _rawJwtToken: string, done: any) => {
        const secrets = getJwtVerificationSecrets();
        done(null, secrets);
      },
      algorithms: [JWT_ALGORITHM],
      passReqToCallback: true,
    });
  }

  async validate(request: any, payload: JwtPayload) {
    const token = extractBearer(request);
    if (token && (await isTokenRevoked(this.redis, token))) {
      throw new UnauthorizedException('Token has been revoked');
    }
    return {
      address: payload.address,
      sub: payload.sub,
      ...(payload.impersonatedBy ? { impersonatedBy: payload.impersonatedBy } : {}),
    };
  }
}
