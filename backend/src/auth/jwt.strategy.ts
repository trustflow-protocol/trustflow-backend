import { Injectable } from '@nestjs/common';

export interface JwtPayload {
  address: string;
  iat: number;
}

@Injectable()
export class JwtStrategy {
  validate(payload: JwtPayload) {
    if (!payload.address || !payload.iat) return null;
    const maxAge = 24 * 60 * 60 * 1000;
    if (Date.now() - payload.iat > maxAge) return null;
    return { address: payload.address };
  }
}
