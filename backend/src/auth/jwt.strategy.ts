import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JWT_ALGORITHM, getJwtVerificationSecrets } from '../config/env.config';

export interface JwtPayload {
  address: string;
  sub: string;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly jwtService: JwtService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrPublicKeyProvider: (_request: any, _rawJwtToken: string, done: any) => {
        const secrets = getJwtVerificationSecrets();
        done(null, secrets);
      },
      algorithms: [JWT_ALGORITHM],
    });
  }

  async validate(payload: JwtPayload) {
    return { address: payload.address, sub: payload.sub };
  }
}
