import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { IDEMPOTENT_KEY } from './idempotency-key.decorator';
import { IdempotencyKeyService } from './idempotency-key.service';

/**
 * Global interceptor that enforces idempotency on endpoints decorated with
 * {@link Idempotent}. Three outcomes per request:
 *
 * 1. **No Idempotency-Key header** — pass through unchanged (backward compatible).
 * 2. **Key seen before, same body** — return the cached response (dedup).
 * 3. **Key seen before, different body** — 422 Unprocessable Entity.
 *
 * On the first successful handler execution the response is cached in Redis
 * under `(endpoint, key)` with a 24-hour TTL so retries within that window
 * are deduplicated.
 */
@Injectable()
export class IdempotencyKeyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotencyService: IdempotencyKeyService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isIdempotent) return next.handle();

    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;

    if (!idempotencyKey) return next.handle();

    const endpoint = `${request.method}:${request.route?.path ?? request.url}`;
    const requestHash = IdempotencyKeyService.hashBody(request.body);

    const existing = await this.idempotencyService.lookup(endpoint, idempotencyKey);

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new HttpException(
          {
            statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            message:
              'Idempotency key has already been used with a different request payload',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      return of(existing.body);
    }

    return next.handle().pipe(
      tap(async (responseBody: unknown) => {
        const response = context.switchToHttp().getResponse();
        await this.idempotencyService.store(
          endpoint,
          idempotencyKey,
          requestHash,
          response.statusCode,
          responseBody,
        );
      }),
    );
  }
}
