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
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../redis/redis.module';
import { SKIP_RATE_LIMIT, RATE_LIMIT_POINTS, RATE_LIMIT_DURATION } from './rate-limit.decorator';

const DEFAULT_POINTS = 100;
const DEFAULT_DURATION = 60;
const DEFAULT_ABUSE_WINDOW = 300;
const DEFAULT_ABUSE_THRESHOLD = 5;
const DEFAULT_LOCKOUT_DURATION = 900;

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(bucket[1])
local updated_at = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  updated_at = now
end

local elapsed = math.max(0, now - updated_at)
tokens = math.min(capacity, tokens + (elapsed * capacity / refill_ms))

if tokens < 1 then
  redis.call('HMSET', key, 'tokens', tokens, 'updatedAt', now)
  redis.call('PEXPIRE', key, ttl_ms)
  return {0, tokens, math.ceil((1 - tokens) * refill_ms / capacity / 1000)}
end

tokens = tokens - 1
redis.call('HMSET', key, 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', key, ttl_ms)
return {1, tokens, 0}
`;

const ABUSE_LOCKOUT_SCRIPT = `
local abuse_key = KEYS[1]
local lockout_key = KEYS[2]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local window_seconds = tonumber(ARGV[3])
local threshold = tonumber(ARGV[4])
local lockout_seconds = tonumber(ARGV[5])
local member = ARGV[6]

redis.call('ZREMRANGEBYSCORE', abuse_key, 0, now - window_ms)
redis.call('ZADD', abuse_key, now, member)
redis.call('EXPIRE', abuse_key, window_seconds)

local abuse_count = redis.call('ZCARD', abuse_key)
if abuse_count >= threshold then
  redis.call('SET', lockout_key, '1', 'EX', lockout_seconds)
  return lockout_seconds
end

return 0
`;

type RateLimitIdentity = {
  scope: 'ip' | 'wallet';
  value: string;
};

type RateLimitDecision = {
  allowed: boolean;
  retryAfter: number;
  scope: string;
};

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly reflector: Reflector,
  ) {}

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

    for (const identity of identities) {
      const decision = await this.checkIdentity(identity, route, points, duration);

      if (!decision.allowed) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests - rate limit exceeded',
            retryAfter: decision.retryAfter,
            scope: decision.scope,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }

  private async checkIdentity(
    identity: RateLimitIdentity,
    route: string,
    points: number,
    duration: number,
  ): Promise<RateLimitDecision> {
    const scope = `${identity.scope}:${identity.value}`;
    const lockoutKey = this.buildKey('lockout', identity.scope, identity.value, route);
    const lockoutTtl = await this.redis!.ttl(lockoutKey);

    if (lockoutTtl > 0) {
      return { allowed: false, retryAfter: lockoutTtl, scope };
    }

    const bucketKey = this.buildKey('bucket', identity.scope, identity.value, route);
    const now = Date.now();
    const ttlMs = duration * 2 * 1000;
    const result = (await this.redis!.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      bucketKey,
      points,
      duration * 1000,
      now,
      ttlMs,
    )) as [number, number, number];

    if (Number(result[0]) === 1) {
      return { allowed: true, retryAfter: 0, scope };
    }

    const retryAfter = await this.recordAbuse(identity, route, Number(result[2]) || duration);
    return { allowed: false, retryAfter, scope };
  }

  private async recordAbuse(
    identity: RateLimitIdentity,
    route: string,
    retryAfter: number,
  ): Promise<number> {
    const abuseWindow = this.getPositiveInteger(
      'RATE_LIMIT_ABUSE_WINDOW_SECONDS',
      DEFAULT_ABUSE_WINDOW,
    );
    const abuseThreshold = this.getPositiveInteger(
      'RATE_LIMIT_ABUSE_THRESHOLD',
      DEFAULT_ABUSE_THRESHOLD,
    );
    const lockoutDuration = this.getPositiveInteger(
      'RATE_LIMIT_LOCKOUT_SECONDS',
      DEFAULT_LOCKOUT_DURATION,
    );
    const now = Date.now();
    const abuseKey = this.buildKey('abuse', identity.scope, identity.value, route);
    const lockoutKey = this.buildKey('lockout', identity.scope, identity.value, route);
    const lockoutApplied = await this.redis!.eval(
      ABUSE_LOCKOUT_SCRIPT,
      2,
      abuseKey,
      lockoutKey,
      now,
      abuseWindow * 1000,
      abuseWindow,
      abuseThreshold,
      lockoutDuration,
      `${now}:${randomUUID()}`,
    );

    return Number(lockoutApplied) > 0 ? Number(lockoutApplied) : retryAfter;
  }

  private getIdentities(request: any): RateLimitIdentity[] {
    const ip = this.normalizeIdentity(
      request.ip ||
        request.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
        request.connection?.remoteAddress ||
        'unknown',
    );
    const wallet = this.extractWallet(request);
    const identities: RateLimitIdentity[] = [{ scope: 'ip', value: ip }];

    if (wallet) {
      identities.push({ scope: 'wallet', value: this.normalizeIdentity(wallet) });
    }

    return identities;
  }

  private extractWallet(request: any): string | undefined {
    return (
      request.user?.address ||
      request.user?.sub ||
      request.body?.address ||
      request.body?.walletAddress ||
      request.query?.address ||
      request.query?.walletAddress ||
      request.params?.address ||
      request.params?.walletAddress
    );
  }

  private getRoute(request: any): string {
    const method = request.method || 'GET';
    const route = request.route?.path || request.url || '/';
    return this.normalizeIdentity(`${method}:${route}`);
  }

  private buildKey(prefix: string, scope: string, identity: string, route: string): string {
    return `ratelimit:${prefix}:${scope}:${identity}:${route}`;
  }

  private normalizeIdentity(value: string): string {
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9:._-]/g, '_');
  }

  private getPositiveInteger(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
