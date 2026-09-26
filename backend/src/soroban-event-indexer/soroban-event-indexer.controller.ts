import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SorobanEventIndexerService } from './soroban-event-indexer.service';

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;

@ApiTags('Soroban Events')
@Controller('events/soroban')
export class SorobanEventIndexerController {
  constructor(private readonly indexerService: SorobanEventIndexerService) {}

  @Get()
  @ApiOperation({ summary: 'List indexed Soroban contract events' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Max events to return (default ${DEFAULT_EVENT_LIMIT}, max ${MAX_EVENT_LIMIT})`,
  })
  @ApiResponse({ status: 200, description: 'List of indexed events' })
  getEvents(@Query('limit') limit?: string) {
    const parsedLimit = limit === undefined ? DEFAULT_EVENT_LIMIT : Number.parseInt(limit, 10);

    if (
      limit === undefined ||
      (limit !== undefined && limit.trim() !== '' && /^\d+$/.test(limit.trim()) && parsedLimit >= 1 && parsedLimit <= MAX_EVENT_LIMIT)
    ) {
      return this.indexerService.getEvents(parsedLimit);
    }

    throw new BadRequestException(
      `Query param 'limit' must be an integer between 1 and ${MAX_EVENT_LIMIT}`,
    );
  }
}
