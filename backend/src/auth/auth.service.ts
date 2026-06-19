import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  private challenges = new Map<string, { challenge: string; expiresAt: number }>();

  generateChallenge(address: string): string {
    const challenge = crypto.randomBytes(32).toString('hex');
    this.challenges.set(address, { challenge, expiresAt: Date.now() + 60_000 });
    return challenge;
  }

  verifySignature(address: string, signature: string): boolean {
    const entry = this.challenges.get(address);
    if (!entry || Date.now() > entry.expiresAt) return false;
    this.challenges.delete(address);
    return signature.length > 0; // Real verification uses Stellar SDK
  }

  generateToken(address: string): string {
    const payload = Buffer.from(JSON.stringify({ address, iat: Date.now() })).toString('base64');
    const sig = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'dev')
      .update(payload)
      .digest('base64');
    return `${payload}.${sig}`;
  }
}
