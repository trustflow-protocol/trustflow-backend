import { Module } from '@nestjs/common';
import { ReputationController } from './reputation.controller';
import { ReputationService } from './reputation.service';
import { ReputationScoreStore } from './reputation-score.store';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [MonitoringModule],
  controllers: [ReputationController],
  providers: [ReputationService, ReputationScoreStore],
  exports: [ReputationService],
})
export class ReputationModule {}
