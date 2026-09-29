import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { EscrowModule } from './escrow/escrow.module';
import { WebhookModule } from './webhook/webhook.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { StellarModule } from './stellar/stellar.module';
import { SentryModule } from './sentry/sentry.module';
import { RedisModule } from './common/redis/redis.module';
import { DatabaseModule } from './common/database/database.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { UserProfileModule } from './user-profile/user-profile.module';
import { EventIngestionModule } from './event-ingestion/event-ingestion.module';
import { DisputeModule } from './dispute/dispute.module';
import { MigrationModule } from './migration/migration.module';
import { IpfsPinningModule } from './ipfs-pinning/ipfs-pinning.module';
import { GigModule } from './gig/gig.module';
import { EscrowReconciliationModule } from './escrow-reconciliation/escrow-reconciliation.module';
import { ReputationModule } from './reputation/reputation.module';
import { AdminModule } from './admin/admin.module';
import { DeliverableModule } from './deliverable/deliverable.module';
import { MilestoneNotificationsModule } from './milestone-notifications/milestone-notifications.module';
import { SorobanEventIndexerModule } from './soroban-event-indexer/soroban-event-indexer.module';
import { OutboxModule } from './outbox/outbox.module';
import { LoggingModule } from './common/logging/logging.module';
import { CorrelationIdMiddleware } from './common/logging/correlation-id.middleware';
import { ShutdownModule } from './common/shutdown/shutdown.module';
import { DrainMiddleware } from './common/shutdown/drain.middleware';

import { AuditModule } from './audit/audit.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    LoggingModule,
    ShutdownModule,
    SentryModule,
    RedisModule,
    DatabaseModule,
    RateLimitModule,
    IdempotencyModule,
    AuthModule,
    UserProfileModule,
    EscrowModule,
    WebhookModule,
    MonitoringModule,
    StellarModule,
    EventIngestionModule,
    DisputeModule,
    MigrationModule,
    IpfsPinningModule,
    GigModule,
    EscrowReconciliationModule,
    ReputationModule,
    AdminModule,
    DeliverableModule,
    MilestoneNotificationsModule,
    SorobanEventIndexerModule,
    OutboxModule,
    AuditModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Correlation ID first so every later log line — including the drain middleware's own —
    // can be attributed to a request. DrainMiddleware must run after it but before the
    // route handlers, so that a request rejected with 503 during a shutdown is still logged
    // with its correlation ID rather than silently shed.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
    consumer.apply(DrainMiddleware).forRoutes('*');
  }
}
