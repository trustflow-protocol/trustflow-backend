import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyKeyService } from './idempotency-key.service';
import { IdempotencyKeyInterceptor } from './idempotency-key.interceptor';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [
    IdempotencyKeyService,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyKeyInterceptor,
    },
  ],
  exports: [IdempotencyKeyService],
})
export class IdempotencyModule {}
