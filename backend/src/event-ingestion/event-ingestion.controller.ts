import { Controller, Post, Get, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { EventIngestionService } from './event-ingestion.service';
import { StartPollingDto, IngestLedgerDto, HandleReorgDto } from './dto/event-ingestion.dto';

@ApiTags('Event Ingestion')
@Controller('event-ingestion')
export class EventIngestionController {
  constructor(private readonly eventIngestionService: EventIngestionService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start polling for Soroban events' })
  @ApiResponse({ status: 200, description: 'Polling started successfully' })
  async startPolling(@Body() dto: StartPollingDto) {
    await this.eventIngestionService.startPolling(dto.contractId);
    return { message: 'Polling started', contractId: dto.contractId };
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop polling for Soroban events' })
  @ApiResponse({ status: 200, description: 'Polling stopped successfully' })
  async stopPolling() {
    this.eventIngestionService.stopPolling();
    return { message: 'Polling stopped' };
  }

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ingest events from a specific ledger' })
  @ApiResponse({ status: 200, description: 'Events ingested successfully' })
  async ingestLedger(@Body() dto: IngestLedgerDto) {
    const results = await this.eventIngestionService.ingestSingleLedger(dto.contractId, dto.ledger);
    return { processed: results.length, results };
  }

  @Post('reorg')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle chain reorg by reprocessing from a ledger' })
  @ApiResponse({ status: 200, description: 'Reorg handled successfully' })
  async handleReorg(@Body() dto: HandleReorgDto) {
    await this.eventIngestionService.handleReorg(dto.contractId, dto.fromLedger);
    return { message: 'Reorg handled', contractId: dto.contractId, fromLedger: dto.fromLedger };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get event ingestion status' })
  @ApiResponse({ status: 200, description: 'Status retrieved successfully' })
  async getStatus() {
    return this.eventIngestionService.getStatus();
  }

  @Post('retry-failed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry all failed events' })
  @ApiResponse({ status: 200, description: 'Failed events retried' })
  async retryFailedEvents() {
    const results = await this.eventIngestionService.retryFailedEvents();
    return { retried: results.length, results };
  }
}
