import { Module } from '@nestjs/common';
import { SorobanEventIndexerService } from './soroban-event-indexer.service';
import { SorobanEventIndexerController } from './soroban-event-indexer.controller';

@Module({
  controllers: [SorobanEventIndexerController],
  providers: [SorobanEventIndexerService],
  exports: [SorobanEventIndexerService],
})
export class SorobanEventIndexerModule {}
