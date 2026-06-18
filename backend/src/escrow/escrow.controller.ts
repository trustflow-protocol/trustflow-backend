import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { EscrowService } from './escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { WebhookEvent } from '../webhook/webhook.dto';

interface CreateEscrowDto {
  depositor: string;
  beneficiary: string;
  amountXLM: string;
}

interface RaiseDisputeDto {
  reason?: string;
}

@ApiTags('Escrow')
@Controller('escrows')
export class EscrowController {
  constructor(
    private readonly escrowService: EscrowService,
    private readonly webhookService: WebhookService,
    private readonly discordService: DiscordService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create new escrow',
    description: 'Creates a new escrow vault with depositor, beneficiary, and amount.',
  })
  @ApiBody({
    description: 'Escrow creation details',
    schema: {
      type: 'object',
      required: ['depositor', 'beneficiary', 'amountXLM'],
      properties: {
        depositor: {
          type: 'string',
          description: 'Stellar address of the depositor',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        beneficiary: {
          type: 'string',
          description: 'Stellar address of the beneficiary',
          example: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        },
        amountXLM: {
          type: 'string',
          description: 'Amount in XLM',
          example: '100',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Escrow created successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'esc-1234567890' },
        depositor: { type: 'string' },
        beneficiary: { type: 'string' },
        amountXLM: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'active', 'released', 'disputed'] },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  create(@Body() dto: CreateEscrowDto) {
    return this.escrowService.create(dto.depositor, dto.beneficiary, dto.amountXLM);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get escrow by ID',
    description: 'Retrieves escrow details including status and milestone information.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: 'esc-1234567890',
  })
  @ApiResponse({
    status: 200,
    description: 'Escrow details',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        depositor: { type: 'string' },
        beneficiary: { type: 'string' },
        amountXLM: { type: 'string' },
        status: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        disputeReason: { type: 'string', nullable: true },
        disputedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  findOne(@Param('id') id: string) {
    return this.escrowService.findById(id);
  }

  @Get('depositor/:address')
  @ApiOperation({
    summary: 'Get escrows by depositor',
    description: 'Retrieves all escrows created by a specific depositor address.',
  })
  @ApiParam({
    name: 'address',
    description: 'Stellar address of the depositor',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({
    status: 200,
    description: 'List of escrows',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          depositor: { type: 'string' },
          beneficiary: { type: 'string' },
          amountXLM: { type: 'string' },
          status: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  })
  findByDepositor(@Param('address') address: string) {
    return this.escrowService.findByDepositor(address);
  }

  @Post(':id/release')
  @ApiOperation({
    summary: 'Release escrow funds',
    description: 'Approves a milestone tranche and releases funds to the beneficiary.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: 'esc-1234567890',
  })
  @ApiResponse({
    status: 200,
    description: 'Escrow released successfully',
  })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  release(@Param('id') id: string) {
    return this.escrowService.release(id);
  }

  @Post(':id/dispute')
  @ApiOperation({
    summary: 'Raise a dispute',
    description:
      'Raises a dispute for an escrow. Triggers webhook events and Discord notifications to alert jurors.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: 'esc-1234567890',
  })
  @ApiBody({
    description: 'Dispute details',
    schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Reason for the dispute',
          example: 'Work not delivered as specified',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Dispute raised successfully. Discord notification sent if configured.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', example: 'disputed' },
        disputeReason: { type: 'string' },
        disputedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Escrow already disputed or released' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  async raiseDispute(@Param('id') id: string, @Body() dto: RaiseDisputeDto) {
    const escrow = await this.escrowService.raiseDispute(id, dto.reason);

    // Dispatch webhook event
    await this.webhookService.dispatch(WebhookEvent.DisputeRaised, {
      escrowId: escrow.id,
      depositor: escrow.depositor,
      beneficiary: escrow.beneficiary,
      amountXLM: escrow.amountXLM,
      reason: escrow.disputeReason,
      disputedAt: escrow.disputedAt,
    });

    // Send Discord notification
    await this.discordService.notifyDisputeNeedsJurors({
      escrowId: escrow.id,
      depositor: escrow.depositor,
      beneficiary: escrow.beneficiary,
      amountXLM: escrow.amountXLM,
      reason: escrow.disputeReason,
    });

    return escrow;
  }
}
