import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SorobanEventIndexerService } from './soroban-event-indexer.service';

@ApiTags('Soroban Events')
@Controller('events/soroban')
export class SorobanEventIndexerController {
  constructor(private readonly indexerService: SorobanEventIndexerService) {}

  @Get()
  @ApiOperation({ summary: 'List indexed Soroban contract events' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max events to return (default 50)' })
  @ApiResponse({ status: 200, description: 'List of indexed events' })
  getEvents(@Query('limit') limit?: string) {
    return this.indexerService.getEvents(limit ? parseInt(limit, 10) : 50);
  }
}
