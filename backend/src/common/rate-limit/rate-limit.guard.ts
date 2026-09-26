import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Redis, Result } from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../redis/redis.module';
import { SKIP_RATE_LIMIT, RATE_LIMIT_POINTS, RATE_LIMIT_DURATION } from './rate-limit.decorator';
import { config } from '../../config/env.config';

const DEFAULT_POINTS = 100;
const DEFAULT_DURATION = 60;

/** Minimal shape of the HTTP request object that rate-limiting reads from. */
interface RateLimitRequest {
  ip?: string;
  method?: string;
  url?: string;
  route?: { path?: string };
  headers?: Record<string, string | string[] | undefined>;
  connection?: { remoteAddress?: string };
  user?: { address?: string; sub?: string };
}

/**
 * Combines the lockout check, token-bucket consume, and (on rejection) abuse recording for
 * a single identity into one atomic round trip — previously three separate Redis commands
 * (`TTL`, `EVAL`, and a second `EVAL` on rejection) run sequentially. Also closes two
 * correctness gaps that came from splitting those steps: the lockout check could no longer
 * race against a lockout applied by another node between the `TTL` read and the bucket
 * consume, and the clock is now `redis.call('TIME')` — the single authoritative clock for
 * every API node — instead of each node's own `Date.now()`, so skewed node clocks no longer
 * produce inconsistent refill/abuse-window math.
 *
 * KEYS[1] = bucket key, KEYS[2] = lockout key, KEYS[3] = abuse key (all three share a
 * `{...}` hash tag over the identity+route so they land on the same Redis Cluster slot —
 * required for this script to run at all once Redis is clustered).
 *
 * ARGV[1] = capacity, ARGV[2] = refill window (ms), ARGV[3] = bucket key TTL (ms),
 * ARGV[4] = abuse window (ms), ARGV[5] = abuse window (seconds, for EXPIRE),
 * ARGV[6] = abuse threshold, ARGV[7] = lockout duration (seconds),
 * ARGV[8] = unique member for this attempt's abuse-window ZSET entry.
 *
 * Returns { allowed: 0 | 1, retryAfter: seconds }.
 */
const RATE_LIMIT_SCRIPT = `
local bucket_key = KEYS[1]
local lockout_key = KEYS[2]
local abuse_key = KEYS[3]

local capacity = tonumber(ARGV[1])
local refill_ms = tonumber(ARGV[2])
local bucket_ttl_ms = tonumber(ARGV[3])
local abuse_window_ms = tonumber(ARGV[4])
local abuse_window_seconds = tonumber(ARGV[5])
local abuse_threshold = tonumber(ARGV[6])
local lockout_seconds = tonumber(ARGV[7])
local member = ARGV[8]

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local lockout_pttl = redis.call('PTTL', lockout_key)
if lockout_pttl and lockout_pttl > 0 then
  return {0, math.ceil(lockout_pttl / 1000)}
end

local bucket = redis.call('HMGET', bucket_key, 'tokens', 'updatedAt')
local tokens = tonumber(bucket[1])
local updated_at = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  updated_at = now
end

local elapsed = math.max(0, now - updated_at)
tokens = math.min(capacity, tokens + (elapsed * capacity / refill_ms))

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', bucket_key, 'tokens', tokens, 'updatedAt', now)
  redis.call('PEXPIRE', bucket_key, bucket_ttl_ms)
  return {1, 0}
end

redis.call('HSET', bucket_key, 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', bucket_key, bucket_ttl_ms)

local retry_after = math.ceil((1 - tokens) * refill_ms / capacity / 1000)

redis.call('ZREMRANGEBYSCORE', abuse_key, 0, now - abuse_window_ms)
redis.call('ZADD', abuse_key, now, member)
redis.call('EXPIRE', abuse_key, abuse_window_seconds)

local abuse_count = redis.call('ZCARD', abuse_key)
if abuse_count >= abuse_threshold then
  redis.call('SET', lockout_key, '1', 'EX', lockout_seconds)
  return {0, lockout_seconds}
end

return {0, retry_after}
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    rateLimitCheck(
      bucketKey: string,
      lockoutKey: string,
      abuseKey: string,
      capacity: number,
      refillMs: number,
      bucketTtlMs: number,
      abuseWindowMs: number,
      abuseWindowSeconds: number,
      abuseThreshold: number,
      lockoutSeconds: number,
      member: string,
    ): Result<[number, number], Context>;
  }
}

type RateLimitIdentity = {
  scope: 'ip' | 'wallet';
  value: string;
};

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  // Not DI-managed: verify() takes the secret per call, so no module wiring is needed,
  // and this guard runs as a global APP_GUARD before route-level JwtAuthGuard populates
  // request.user, so it must be able to verify the bearer token itself.
  private readonly jwtService = new JwtService();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly reflector: Reflector,
  ) {
    // Registers redis.rateLimitCheck() (and pipeline.rateLimitCheck()) backed by EVALSHA,
    // with ioredis handling the SCRIPT LOAD + NOSCRIPT-triggered re-send transparently — the
    // Lua source is sent to Redis at most once per connection instead of on every request.
    if (this.redis && typeof this.redis.rateLimitCheck !== 'function') {
      this.redis.defineCommand('rateLimitCheck', { numberOfKeys: 3, lua: RATE_LIMIT_SCRIPT });
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    if (!this.redis) {
      this.logger.warn('Redis not configured — rate limiting disabled');
      return true;
    }

    const points =
      this.reflector.getAllAndOverride<number>(RATE_LIMIT_POINTS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_POINTS;

    const duration =
      this.reflector.getAllAndOverride<number>(RATE_LIMIT_DURATION, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_DURATION;

    const request = context.switchToHttp().getRequest();
    const route = this.getRoute(request);
    const identities = this.getIdentities(request);

    const abuseWindow = config.RATE_LIMIT_ABUSE_WINDOW_SECONDS;
    const abuseThreshold = config.RATE_LIMIT_ABUSE_THRESHOLD;
    const lockoutDuration = config.RATE_LIMIT_LOCKOUT_SECONDS;

    // One pipeline for every identity on this request (at most two: ip, wallet) — one
    // network round trip instead of a sequential TTL+EVAL(+EVAL) per identity.
    const pipeline = this.redis.pipeline();
    for (const identity of identities) {
      const keys = this.buildKeys(identity.scope, identity.value, route);
      pipeline.rateLimitCheck(
        keys.bucket,
        keys.lockout,
        keys.abuse,
        points,
        duration * 1000,
        duration * 2 * 1000,
        abuseWindow * 1000,
        abuseWindow,
        abuseThreshold,
        lockoutDuration,
        randomUUID(),
      );
    }

    const results = (await pipeline.exec()) ?? [];

    for (let i = 0; i < identities.length; i++) {
      const [error, raw] = results[i] ?? [];
      if (error) throw error;

      const [allowed, retryAfter] = raw as [number, number];
      if (Number(allowed) !== 1) {
        const identity = identities[i];
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests - rate limit exceeded',
            retryAfter: Number(retryAfter),
            scope: `${identity.scope}:${identity.value}`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }

  private getIdentities(request: RateLimitRequest): RateLimitIdentity[] {
    const xForwarded = request.headers?.['x-forwarded-for'];
    const forwarded = Array.isArray(xForwarded) ? xForwarded[0] : xForwarded?.split(',')[0]?.trim();
    const ip = this.normalizeIdentity(
      request.ip || forwarded || request.connection?.remoteAddress || 'unknown',
    );
    const wallet = this.extractVerifiedWallet(request);
    const identities: RateLimitIdentity[] = [{ scope: 'ip', value: ip }];

    if (wallet) {
      identities.push({ scope: 'wallet', value: this.normalizeIdentity(wallet) });
    }

    return identities;
  }

  /**
   * Only a verified wallet identity may select a wallet-scoped bucket. `request.user` is
   * set exclusively by an already-verified auth strategy — but this guard is registered
   * globally and therefore runs before route-level guards like JwtAuthGuard, so
   * `request.user` is not populated yet on authenticated routes. Verify the bearer token
   * here instead of trusting it. Caller-controlled body/query/param fields are never
   * consulted: an unverified value would let a client rotate identities to dodge limits.
   */
  private extractVerifiedWallet(request: RateLimitRequest): string | undefined {
    const verifiedAddress = request.user?.address || request.user?.sub;
    if (verifiedAddress) {
      return verifiedAddress;
    }

    const token = this.extractBearerToken(request);
    if (!token) {
      return undefined;
    }

    try {
      const payload = this.jwtService.verify<{ address?: string; sub?: string }>(token, {
        secret: config.JWT_SECRET,
      });
      return payload.address || payload.sub;
    } catch {
      return undefined;
    }
  }

  private extractBearerToken(request: RateLimitRequest): string | undefined {
    const header = request.headers?.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith('Bearer ')) {
      return undefined;
    }
    const token = value.slice('Bearer '.length).trim();
    return token || undefined;
  }

  private getRoute(request: RateLimitRequest): string {
    const method = request.method || 'GET';
    const route = request.route?.path || request.url || '/';
    return this.normalizeIdentity(`${method}:${route}`);
  }

  /**
   * All three keys for one identity share a `{...}` hash tag over scope+identity+route, so
   * Redis Cluster maps them to the same slot — required for the combined Lua script (which
   * touches all three) to run at all once Redis is clustered.
   */
  private buildKeys(
    scope: string,
    identity: string,
    route: string,
  ): { bucket: string; lockout: string; abuse: string } {
    const tag = `${scope}:${identity}:${route}`;
    return {
      bucket: `ratelimit:{${tag}}:bucket`,
      lockout: `ratelimit:{${tag}}:lockout`,
      abuse: `ratelimit:{${tag}}:abuse`,
    };
  }

  private normalizeIdentity(value: string): string {
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9:._-]/g, '_');
  }
}
