import { Module, Global } from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const url = process.env.REDIS_URL;
        if (!url) return null;
        const client = new Redis(url, {
          maxRetriesPerRequest: 3,
          retryStrategy: times => Math.min(times * 100, 3000),
          lazyConnect: true,
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
