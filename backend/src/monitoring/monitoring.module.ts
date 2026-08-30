import { Module } from '@nestjs/common';
import { HealthService } from './health.service';
import { MetricsService } from './metrics.service';
import { HealthController } from './health.controller';
import { MetricsHttpInterceptor } from './metrics-http.interceptor';
import { DatabaseModule } from '../common/database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [HealthService, MetricsService, MetricsHttpInterceptor],
  exports: [HealthService, MetricsService, MetricsHttpInterceptor],
})
export class MonitoringModule {}
