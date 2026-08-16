import { Module } from '@nestjs/common';
import { ReputationController } from './reputation.controller';
import { ReputationService } from './reputation.service';
import { ReputationScoreStore } from './reputation-score.store';

@Module({
  controllers: [ReputationController],
  providers: [ReputationService, ReputationScoreStore],
  exports: [ReputationService],
})
export class ReputationModule {}
