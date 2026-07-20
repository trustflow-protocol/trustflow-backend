import { Module } from '@nestjs/common';
import { EventIngestionService } from './event-ingestion.service';
import { LedgerCursorService } from './ledger-cursor.service';
import { EventProcessorService } from './event-processor.service';
import { EventIngestionController } from './event-ingestion.controller';
import { StellarModule } from '../stellar/stellar.module';
import { EscrowModule } from '../escrow/escrow.module';

@Module({
  imports: [StellarModule, EscrowModule],
  controllers: [EventIngestionController],
  providers: [EventIngestionService, LedgerCursorService, EventProcessorService],
  exports: [EventIngestionService],
})
export class EventIngestionModule {}
