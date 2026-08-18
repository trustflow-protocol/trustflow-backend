import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GigService } from './gig.service';
import { WebhookService } from '../webhook/webhook.service';
import { AcceptGigDto, AcceptGigSchema, CreateGigDto, CreateGigSchema } from './gig.dto';
import { GIG_EVENTS } from './gig.entity';
import { JwtAuthGuard } from '../auth/auth.guard';

@ApiTags('Gigs')
@Controller('gigs')
export class GigController {
  constructor(
    private readonly gigService: GigService,
    private readonly webhookService: WebhookService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Post a gig solicitation',
    description:
      'Creates an open gig solicitation. If nobody accepts it within the response window ' +
      '(default 72h), the background expiry sweep automatically marks it as expired.',
  })
  @ApiBody({
    description: 'Gig solicitation details',
    schema: {
      type: 'object',
      required: ['creator', 'title', 'budgetXLM'],
      properties: {
        creator: {
          type: 'string',
          description: 'Stellar address of the gig creator',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        title: { type: 'string', example: 'Build a Soroban escrow audit report' },
        budgetXLM: { type: 'string', description: 'Budget in XLM', example: '250' },
        responseWindowHours: {
          type: 'number',
          description: 'Hours to wait for a response before expiring. Defaults to 72.',
          example: 72,
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Gig solicitation created',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'gig-1234567890-ab12cd' },
        creator: { type: 'string' },
        title: { type: 'string' },
        budgetXLM: { type: 'string' },
        status: { type: 'string', enum: ['open', 'accepted', 'expired', 'cancelled'] },
        createdAt: { type: 'string', format: 'date-time' },
        respondBy: { type: 'string', format: 'date-time' },
      },
    },
  })
  async create(@Body() dto: CreateGigDto) {
    const validated = CreateGigSchema.parse(dto);
    const gig = await this.gigService.create(validated);
    await this.webhookService.dispatch(GIG_EVENTS.GIG_CREATED, gig);
    return gig;
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a gig solicitation by ID',
    description: 'Retrieves gig details including status and response deadline.',
  })
  @ApiParam({ name: 'id', description: 'Gig ID', example: 'gig-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'Gig solicitation details' })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  findOne(@Param('id') id: string) {
    return this.gigService.findById(id);
  }

  @Get('creator/:address')
  @ApiOperation({ summary: 'List gig solicitations posted by a creator' })
  @ApiParam({
    name: 'address',
    description: 'Stellar address of the gig creator',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({ status: 200, description: 'List of gig solicitations' })
  findByCreator(@Param('address') address: string) {
    return this.gigService.findByCreator(address);
  }

  @Post(':id/accept')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Accept a gig solicitation',
    description: 'Marks an open gig as accepted, removing it from the expiry sweep.',
  })
  @ApiParam({ name: 'id', description: 'Gig ID', example: 'gig-1234567890-ab12cd' })
  @ApiBody({
    description: 'Acceptance details',
    schema: {
      type: 'object',
      required: ['responder'],
      properties: {
        responder: {
          type: 'string',
          description: 'Stellar address of the responder',
          example: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Gig accepted successfully' })
  @ApiResponse({ status: 400, description: 'Gig is not open' })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  async accept(@Param('id') id: string, @Body() dto: AcceptGigDto) {
    const validated = AcceptGigSchema.parse(dto);
    const gig = await this.gigService.accept(id, validated.responder);
    await this.webhookService.dispatch(GIG_EVENTS.GIG_ACCEPTED, gig);
    return gig;
  }

  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Cancel a gig solicitation',
    description: 'Withdraws an open gig solicitation, removing it from the expiry sweep.',
  })
  @ApiParam({ name: 'id', description: 'Gig ID', example: 'gig-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'Gig cancelled successfully' })
  @ApiResponse({ status: 400, description: 'Gig is not open' })
  @ApiResponse({ status: 404, description: 'Gig not found' })
  async cancel(@Param('id') id: string) {
    const gig = await this.gigService.cancel(id);
    await this.webhookService.dispatch(GIG_EVENTS.GIG_CANCELLED, gig);
    return gig;
  }
}
