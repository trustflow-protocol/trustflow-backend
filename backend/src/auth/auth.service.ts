import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';

@Injectable()
export class AuthService {
  private challenges = new Map<string, { challenge: string; expiresAt: number }>();

  constructor(private jwtService: JwtService) {}

  generateChallenge(address: string): string {
    const nonce = crypto.randomBytes(32).toString('hex');
    const challenge = `Sign this message to authenticate with TrustFlow: ${nonce}`;
    this.challenges.set(address, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 minutes
    return challenge;
  }

  verifySignature(address: string, signature: string): boolean {
    const entry = this.challenges.get(address);
    if (!entry) {
      throw new UnauthorizedException('Challenge not found or expired');
    }
    if (Date.now() > entry.expiresAt) {
      this.challenges.delete(address);
      throw new UnauthorizedException('Challenge expired');
    }

    try {
      const challenge = entry.challenge;
      const signatureBuffer = Buffer.from(signature, 'base64');
      const challengeBuffer = Buffer.from(challenge, 'utf-8');
      
      // Verify the signature using Stellar SDK
      const keypair = StellarSdk.Keypair.fromPublicKey(address);
      const isValid = keypair.verify(challengeBuffer, signatureBuffer);
      
      if (isValid) {
        this.challenges.delete(address);
        return true;
      }
      
      return false;
    } catch (error) {
      throw new UnauthorizedException('Invalid signature');
    }
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
