import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isTokenRevoked, revokeToken } from './token-denylist';
import { JwtStrategy } from './jwt.strategy';

describe('token denylist (#946)', () => {
  it('marks a revoked token as revoked in memory without affecting others', async () => {
    await revokeToken(null, 'token-a', 60);
    expect(await isTokenRevoked(null, 'token-a')).toBe(true);
    expect(await isTokenRevoked(null, 'token-b')).toBe(false);
  });

  it('stores revocations in Redis with the remaining token TTL', async () => {
    const redis = { set: jest.fn(), exists: jest.fn().mockResolvedValue(1) };
    await revokeToken(redis as any, 'token-c', 120);
    expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^auth:revoked:[0-9a-f]{64}$/), '1', 'EX', 120);
    expect(await isTokenRevoked(redis as any, 'token-c')).toBe(true);
  });

  it('JwtStrategy rejects a token after logout revoked it', async () => {
    const strategy = new JwtStrategy(new JwtService(), null);
    const payload = { address: 'GADDR', sub: 'GADDR', iat: 0, exp: 0 };
    const request = { headers: { authorization: 'Bearer token-d' } };

    await expect(strategy.validate(request, payload)).resolves.toEqual({ address: 'GADDR', sub: 'GADDR' });
    await revokeToken(null, 'token-d', 60);
    await expect(strategy.validate(request, payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
