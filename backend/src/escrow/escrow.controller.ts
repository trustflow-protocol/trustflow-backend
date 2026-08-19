import { Controller, Get, NotFoundException, Post, Body, Param, Query } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { EscrowService } from './escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { WebhookEvent } from '../webhook/webhook.dto';
import { ReputationService } from '../reputation/reputation.service';
import { EscrowReleaseTransactionBuilderService } from '../escrow-write/escrow-release-transaction-builder.service';
import { BuildReleaseTransactionQueryDto } from '../escrow-write/escrow-write.dto';
import { Idempotent } from '../common/idempotency';

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
    private readonly reputationService: ReputationService,
    private readonly escrowReleaseTransactionBuilderService: EscrowReleaseTransactionBuilderService,
  ) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Create new escrow',
    description: 'Creates a new escrow vault with depositor, beneficiary, and amount.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'A unique key (e.g. UUID) to ensure this request is idempotent. ' +
      'Retries with the same key and body return the original response without creating a duplicate. ' +
      'Reusing the key with a different body returns 422.',
    schema: { type: 'string' },
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
  async release(@Param('id') id: string) {
    const escrow = await this.escrowService.release(id);
    await this.reputationService.recordEscrowCompleted(escrow);
    return escrow;
  }

  @Get(':id/release/transaction')
  @ApiOperation({
    summary: 'Build an unsigned on-chain release transaction (prototype, spike #180)',
    description:
      'Builds and simulates a Soroban `release` invocation for a chain-linked escrow. ' +
      'The backend never holds a signing key for this — see the #180 write-path spike write-up. ' +
      'Client flow: (1) call this endpoint to get unsigned XDR, (2) sign it locally with the ' +
      'sourceAccount wallet, (3) submit the signed envelope directly to Soroban RPC — the resulting ' +
      'chain event flows back into this API through the existing event-ingestion pipeline. ' +
      'Requires TRUSTFLOW_CONTRACT_ID to be configured and the escrow to be linked to an on-chain ID.',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID', example: 'esc-1234567890' })
  @ApiQuery({
    name: 'sourceAccount',
    description: 'Stellar address that will sign and submit the transaction',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({
    status: 200,
    description: 'Unsigned release transaction XDR, ready for the caller to sign and submit',
    schema: {
      type: 'object',
      properties: {
        xdr: { type: 'string', example: 'AAAAAgAAAAA...' },
        network: { type: 'string', example: 'TESTNET' },
        networkPassphrase: { type: 'string', example: 'Test SDF Network ; September 2015' },
        contractId: {
          type: 'string',
          example: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        sourceAccount: {
          type: 'string',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid or missing sourceAccount' })
  @ApiResponse({ status: 404, description: 'Escrow not found or not linked to an on-chain escrow' })
  @ApiResponse({ status: 503, description: 'TRUSTFLOW_CONTRACT_ID is not configured' })
  async buildReleaseTransaction(
    @Param('id') id: string,
    @Query() { sourceAccount }: BuildReleaseTransactionQueryDto,
  ) {
    const escrow = await this.escrowService.findById(id);
    if (!escrow) throw new NotFoundException(`Escrow ${id} not found`);
    if (!escrow.contractEscrowId) {
      throw new NotFoundException(`Escrow ${id} is not yet linked to an on-chain escrow`);
    }

    return this.escrowReleaseTransactionBuilderService.buildRelease(
      escrow.contractEscrowId,
      sourceAccount,
    );
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
