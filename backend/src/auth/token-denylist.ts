import { createHash } from 'crypto';
import type { Redis } from 'ioredis';

/**
 * Server-side revocation list for access tokens (#946). Entries are keyed by a SHA-256 of
 * the raw JWT and expire with the token, so the list never outgrows the token TTL.
 * Falls back to process memory when Redis is not configured.
 */
const memory = new Map<string, number>();

function key(token: string): string {
  return `auth:revoked:${createHash('sha256').update(token).digest('hex')}`;
}

export async function revokeToken(
  redis: Redis | null | undefined,
  token: string,
  ttlSeconds: number,
): Promise<void> {
  const ttl = Math.max(1, Math.ceil(ttlSeconds));
  if (redis) {
    await redis.set(key(token), '1', 'EX', ttl);
    return;
  }
  memory.set(key(token), Date.now() + ttl * 1000);
}

export async function isTokenRevoked(
  redis: Redis | null | undefined,
  token: string,
): Promise<boolean> {
  if (redis) {
    return (await redis.exists(key(token))) === 1;
  }
  const expiresAt = memory.get(key(token));
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    memory.delete(key(token));
    return false;
  }
  return true;
}
