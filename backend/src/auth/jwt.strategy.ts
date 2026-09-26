import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { getJwtVerificationSecrets } from '../config/env.config';

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
      secretOrKeyProvider: (_request, rawJwtToken, done) => {
        const verificationSecrets = getJwtVerificationSecrets();

        if (verificationSecrets.length === 0) {
          return done(new Error('JWT secret is not configured'));
        }

        const trySecret = (index: number): void => {
          const secret = verificationSecrets[index];
          try {
            this.jwtService.verify(rawJwtToken, { secret });
            return done(null, secret);
          } catch {
            if (index === verificationSecrets.length - 1) {
              return done(new Error('Invalid token'));
            }
            return trySecret(index + 1);
          }
        };

        return trySecret(0);
      },
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JwtPayload) {
    return { address: payload.address, sub: payload.sub };
  }
}
