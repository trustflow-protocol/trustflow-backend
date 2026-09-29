import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

@ApiTags('Outbox')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('outbox')
export class OutboxController {
  constructor(
    private readonly outbox: OutboxService,
    private readonly relay: OutboxRelayService,
  ) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Inspect a durable domain event (admin only)',
    description: 'Returns event delivery state, including its consumer-facing deduplication key.',
  })
  @ApiParam({ name: 'id', description: 'Outbox event UUID' })
  @ApiResponse({ status: 200, description: 'Outbox event found' })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  @ApiResponse({ status: 404, description: 'Outbox event not found' })
  async findOne(@Param('id') id: string) {
    const event = await this.outbox.findById(id);
    if (!event) throw new NotFoundException(`Outbox event ${id} not found`);
    return event;
  }

  @Post('relay')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Run one outbox relay batch (admin only)',
    description:
      'Operational endpoint for draining due events without waiting for the scheduled relay.',
  })
  @ApiResponse({
    status: 202,
    description: 'Relay batch processed',
    schema: { example: { processed: 3 } },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  async relayNow() {
    return { processed: await this.relay.runOnce() };
  }
}
