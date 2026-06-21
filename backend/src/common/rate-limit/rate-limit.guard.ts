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
import { REDIS_CLIENT } from '../redis/redis.module';
import { SKIP_RATE_LIMIT, RATE_LIMIT_POINTS, RATE_LIMIT_DURATION } from './rate-limit.decorator';

const DEFAULT_POINTS = 100;
const DEFAULT_DURATION = 60;

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
    const key = this.buildKey(request);

    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, duration);
    }

    if (current > points) {
      const ttl = await this.redis.ttl(key);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests — rate limit exceeded',
          retryAfter: ttl,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private buildKey(request: any): string {
    const ip = request.ip || request.connection?.remoteAddress || 'unknown';
    const route = request.route?.path || request.url || '/';
    return `ratelimit:${ip}:${route}`;
  }
}
