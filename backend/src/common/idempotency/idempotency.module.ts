import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyKeyService } from './idempotency-key.service';
import { IdempotencyKeyInterceptor } from './idempotency-key.interceptor';
import { RedisModule } from '../redis/redis.module';
import { MonitoringModule } from '../../monitoring/monitoring.module';

@Module({
  imports: [RedisModule, MonitoringModule],
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
