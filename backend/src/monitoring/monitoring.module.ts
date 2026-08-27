import { Module } from '@nestjs/common';
import { HealthService } from './health.service';
import { MetricsService } from './metrics.service';
import { HealthController } from './health.controller';
import { DatabaseModule } from '../common/database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [HealthService, MetricsService],
  exports: [HealthService, MetricsService],
})
export class MonitoringModule {}
