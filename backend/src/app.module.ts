import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { EscrowModule } from './escrow/escrow.module';
import { WebhookModule } from './webhook/webhook.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { StellarModule } from './stellar/stellar.module';
import { SentryModule } from './sentry/sentry.module';
import { RedisModule } from './common/redis/redis.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { UserProfileModule } from './user-profile/user-profile.module';
import { GigModule } from './gigs/gig.module';

@Module({
  imports: [
    SentryModule,
    RedisModule,
    RateLimitModule,
    AuthModule,
    UserProfileModule,
    GigModule,
    EscrowModule,
    WebhookModule,
    MonitoringModule,
    StellarModule,
  ],
})
export class AppModule {}
