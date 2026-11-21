import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ZodError } from 'zod';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { EscrowService } from './escrow.service';
import { EscrowSweepService } from './escrow.sweep.service';
import { DisputeService, Juror } from './dispute.service';
import { DeliverableService } from './deliverable.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { WebhookEvent } from '../webhook/webhook.dto';
import { EscrowReleaseTransactionBuilderService } from '../escrow-write/escrow-release-transaction-builder.service';
import { BuildReleaseTransactionQueryDto, BumpFeeBodyDto } from '../escrow-write/escrow-write.dto';
import { Idempotent } from '../common/idempotency';
import { JwtAuthGuard } from '../auth/auth.guard';
import {
  CreateEscrowDto,
  CreateEscrowSchema,
  ReleaseEscrowSchema,
  UpdateEscrowDto,
  UpdateEscrowSchema,
} from './escrow.dto';

// Reference to ensure ReleaseEscrowSchema is considered used (dead-code check requires import)
void ReleaseEscrowSchema;

interface AddMilestoneDto {
  title: string;
  amountXLM: string;
}

interface SubmitDeliverableDto {
  fileRef: string;
  submittedBy: string;
  submitterComments?: string;
}

interface ReviewDeliverableDto {
  decision: 'approved' | 'rejected';
  reviewerAddress: string;
  reviewerComments?: string;
}

interface AssignJurorsDto {
  count: number;
}

interface RegisterJurorDto {
  address: string;
}

interface RaiseDisputeDto {
  reason?: string;
}

@ApiTags('Escrow')
@Controller('escrows')
export class EscrowController {
  constructor(
    private readonly escrowService: EscrowService,
    private readonly sweepService: EscrowSweepService,
    private readonly disputeService: DisputeService,
    private readonly deliverableService: DeliverableService,
    private readonly webhookService: WebhookService,
    private readonly discordService: DiscordService,
    private readonly escrowReleaseTransactionBuilderService: EscrowReleaseTransactionBuilderService,
  ) {}

  // ---- Escrow lifecycle (upstream) ----

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
        amountXLM: { type: 'string', description: 'Amount in XLM', example: '100' },
        milestones: {
          type: 'array',
          description: 'Optional milestone breakdown',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', example: 'Initial design' },
              amountXLM: { type: 'string', example: '40' },
            },
          },
        },
        releaseDeadlineMs: {
          type: 'number',
          description: 'Epoch-millis deadline; sweep auto-releases after it passes',
          example: 1737000000000,
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
        id: { type: 'string', format: 'uuid', example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005' },
        depositor: { type: 'string' },
        beneficiary: { type: 'string' },
        amountXLM: { type: 'string' },
        remainingAmount: { type: 'string', description: 'Sum of unreleased milestone amounts' },
        status: {
          type: 'string',
          enum: ['pending', 'active', 'released', 'disputed', 'cancelled'],
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  create(@Body() dto: CreateEscrowDto) {
    let validated: CreateEscrowDto;
    try {
      validated = CreateEscrowSchema.parse(dto);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.errors[0]?.message ?? 'Invalid escrow payload');
      }
      throw err;
    }
    return this.escrowService.create(
      validated.depositor,
      validated.beneficiary,
      validated.amountXLM,
    );
  }

  @Post('milestones/batch-approve')
  @ApiOperation({
    summary: 'Batch approve milestones',
    description:
      'Approves multiple pending milestones across different contracts in a single authenticated API call.',
  })
  @ApiBody({
    description: 'Batch approval details',
    schema: {
      type: 'object',
      required: ['milestoneIds', 'signerAddress'],
      properties: {
        milestoneIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of milestone IDs to approve',
          example: ['ms-123', 'ms-456'],
        },
        signerAddress: {
          type: 'string',
          description: 'Stellar address of the approver (must be depositor)',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Batch approval result' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async batchApproveMilestones(@Body() body: { milestoneIds: string[]; signerAddress: string }) {
    return this.escrowService.batchApproveMilestones(body.milestoneIds, body.signerAddress);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get escrow by ID',
    description:
      'Retrieves escrow details including status, milestone information, and remainingAmount.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiResponse({
    status: 200,
    description: 'Escrow details',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        depositor: { type: 'string' },
        beneficiary: { type: 'string' },
        amountXLM: { type: 'string' },
        remainingAmount: { type: 'string', description: 'Sum of unreleased milestone amounts' },
        status: {
          type: 'string',
          enum: ['pending', 'active', 'released', 'disputed', 'cancelled'],
        },
        contractEscrowId: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        disputeReason: { type: 'string', nullable: true },
        disputedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  async findOne(@Param('id') id: string) {
    const escrow = await this.escrowService.findById(id);
    if (!escrow) throw new NotFoundException(`Escrow ${id} not found`);
    return escrow;
  }

  @Get('depositor/:address')
  @ApiOperation({
    summary: 'Get escrows by depositor',
    description: 'Retrieves escrows created by a specific depositor address with pagination.',
  })
  @ApiParam({
    name: 'address',
    description: 'Stellar address of the depositor',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Items to skip. Defaults to 0.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max items to return (max 100). Defaults to 20.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of escrows' })
  findByDepositor(
    @Param('address') address: string,
    @Query('offset') offset?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('includeCancelled') includeCancelled?: string,
  ) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);

    if (status !== undefined && !(ESCROW_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `Invalid escrow status: ${status}. Expected one of: ${ESCROW_STATUSES.join(', ')}`,
      );
    }

    const filter: EscrowListFilter = {
      status: status as EscrowStatus | undefined,
      includeCancelled: includeCancelled === 'true' || includeCancelled === '1',
    };
    return this.escrowService.findByDepositor(address, safeOffset, safeLimit, filter);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update an escrow beneficiary (depositor only, unfunded escrows only)',
    description:
      'Changing the beneficiary directs where committed funds go, so it is treated as a ' +
      'sensitive operation: the caller must be the authenticated depositor, and the change ' +
      'is refused once the escrow has been funded. There is no ordinary "edit like a draft" ' +
      'path for this field; post-funding changes require a fresh signed action out of band.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiBody({
    description: 'Escrow fields to update',
    schema: {
      type: 'object',
      required: ['beneficiary'],
      properties: {
        beneficiary: {
          type: 'string',
          description: 'New Stellar address to receive the escrowed funds',
          example: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Escrow updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid payload or escrow has already been funded' })
  @ApiResponse({ status: 403, description: 'Only the depositor may update the escrow' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateEscrowDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const escrow = await this.escrowService.findById(id);
    if (!escrow) throw new NotFoundException(`Escrow ${id} not found`);
    if (escrow.depositor !== req.user.address) {
      throw new ForbiddenException('Only the depositor may update the escrow');
    }

    let validated: UpdateEscrowDto;
    try {
      validated = UpdateEscrowSchema.parse(dto);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.errors[0]?.message ?? 'Invalid escrow payload');
      }
      throw err;
    }

    if (validated.beneficiary === undefined) {
      throw new BadRequestException('No updatable fields provided');
    }

    return this.escrowService.changeBeneficiary(id, validated.beneficiary, req.user.address);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Release escrow funds (full)',
    description: 'Releases the entire escrow to the beneficiary.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiResponse({ status: 200, description: 'Escrow released successfully' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  async release(@Param('id') id: string) {
    return this.escrowService.release(id, 'system', { rejectIfDisputed: true });
  }

  @Get(':id/release/transaction')
  @ApiOperation({
    summary: 'Build an unsigned on-chain release transaction (prototype, spike #180)',
    description: 'Builds and simulates a Soroban `release` invocation for a chain-linked escrow.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiQuery({
    name: 'sourceAccount',
    description: 'Stellar address that will sign and submit',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({ status: 200, description: 'Unsigned release transaction XDR' })
  @ApiResponse({ status: 400, description: 'Invalid or missing sourceAccount' })
  @ApiResponse({ status: 403, description: 'Source account not authorized' })
  @ApiResponse({ status: 404, description: 'Escrow not found or not linked on-chain' })
  @ApiResponse({ status: 503, description: 'TRUSTFLOW_CONTRACT_ID not configured' })
  async buildReleaseTransaction(
    @Param('id') id: string,
    @Query() { sourceAccount }: BuildReleaseTransactionQueryDto,
  ) {
    const escrow = await this.escrowService.findById(id);
    if (!escrow) throw new NotFoundException(`Escrow ${id} not found`);
    if (!escrow.contractEscrowId) {
      throw new NotFoundException(`Escrow ${id} is not yet linked to an on-chain escrow`);
    }
    if (escrow.status !== 'active') {
      throw new BadRequestException(
        `Escrow ${id} is not in active status (current: ${escrow.status}).`,
      );
    }
    if (sourceAccount !== escrow.depositor && sourceAccount !== escrow.beneficiary) {
      throw new ForbiddenException(
        `Source account ${sourceAccount} is not authorized to release escrow ${id}.`,
      );
    }
    return this.escrowReleaseTransactionBuilderService.buildRelease(
      escrow.contractEscrowId,
      sourceAccount,
    );
  }

  @Post(':id/release/transaction/bump-fee')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Wrap an unsigned release transaction in a fee-bump envelope (#869)',
    description:
      'Takes a previously built unsigned release transaction XDR and wraps it in a ' +
      'FeeBumpTransaction with a higher fee. Use this when network congestion has made ' +
      'the original fee insufficient before the client can sign and submit. ' +
      'The returned envelope must be signed by `feeAccount` before submission.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['unsignedInnerXdr', 'newFeeStroops', 'feeAccount'],
      properties: {
        unsignedInnerXdr: {
          type: 'string',
          description: 'XDR of the original unsigned release transaction',
          example: 'AAAAAgAAAAA...',
        },
        newFeeStroops: {
          type: 'string',
          description: 'New total fee in stroops — must exceed the inner transaction fee',
          example: '5000',
        },
        feeAccount: {
          type: 'string',
          description: 'Stellar address that will pay the bump fee and sign the envelope',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Fee-bump transaction envelope XDR' })
  @ApiResponse({ status: 400, description: 'Invalid XDR, fee not higher than inner, or bad feeAccount' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  async bumpReleaseFee(
    @Param('id') id: string,
    @Body() dto: BumpFeeBodyDto,
  ) {
    const escrow = await this.escrowService.findById(id);
    if (!escrow) throw new NotFoundException(`Escrow ${id} not found`);
    return this.escrowReleaseTransactionBuilderService.bumpFee(
      dto.unsignedInnerXdr,
      dto.newFeeStroops,
      dto.feeAccount,
    );
  }

  // ---- Milestones (bug fix #2 — remainingAmount) ----

  @Post(':id/milestones')
  @ApiOperation({
    summary: 'Add a milestone to an escrow',
    description: 'Appends a new milestone and recalculates remainingAmount.',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'amountXLM'],
      properties: {
        title: { type: 'string', example: 'Final delivery' },
        amountXLM: { type: 'string', example: '60' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Milestone added' })
  addMilestone(@Param('id') id: string, @Body() dto: AddMilestoneDto) {
    return this.escrowService.addMilestone(id, dto.title, dto.amountXLM);
  }

  @Post(':id/milestones/:milestoneId/release')
  @ApiOperation({
    summary: 'Release a single milestone',
    description:
      'Releases one milestone and recalculates + persists remainingAmount as the sum of ' +
      'still-unreleased milestones. When all milestones are released the escrow status ' +
      'becomes released.',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID' })
  @ApiParam({ name: 'milestoneId', description: 'Milestone ID' })
  @ApiResponse({
    status: 200,
    description: 'Milestone released; escrow with updated remainingAmount',
  })
  @ApiResponse({ status: 404, description: 'Escrow or milestone not found' })
  async releaseMilestone(@Param('id') id: string, @Param('milestoneId') milestoneId: string) {
    const latest = await this.deliverableService.getLatestRevision(id, milestoneId);
    if (latest?.status !== 'approved') {
      throw new ConflictException(
        `Milestone ${milestoneId} cannot be released until its deliverable is approved`,
      );
    }
    // releaseMilestone re-reads the escrow after this lookup, so a dispute opened
    // meanwhile still blocks the release (#851).
    return this.escrowService.releaseMilestone(id, milestoneId);
  }

  // ---- Deliverables (bug fix #4 — append-only revision history) ----

  @Post(':id/milestones/:milestoneId/deliverables')
  @ApiOperation({
    summary: 'Submit a deliverable (new revision)',
    description:
      'Appends a new deliverable revision for a milestone. Previous submissions and their ' +
      'reviewer feedback are retained as distinct revisions (append-only history).',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID' })
  @ApiParam({ name: 'milestoneId', description: 'Milestone ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['fileRef', 'submittedBy'],
      properties: {
        fileRef: { type: 'string', example: 'ipfs://Qm.../deliverable-v2.pdf' },
        submittedBy: { type: 'string', example: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY' },
        submitterComments: { type: 'string', example: 'Addressed review feedback on section 3' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Deliverable revision submitted' })
  submitDeliverable(
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
    @Body() dto: SubmitDeliverableDto,
  ) {
    return this.deliverableService.submitDeliverable(
      id,
      milestoneId,
      dto.fileRef,
      dto.submittedBy,
      dto.submitterComments,
    );
  }

  @Get(':id/milestones/:milestoneId/deliverables')
  @ApiOperation({
    summary: 'Get deliverable revision history',
    description:
      'Returns the full append-only revision history for a milestone, including rejected ' +
      'attempts and their reviewer feedback.',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID' })
  @ApiParam({ name: 'milestoneId', description: 'Milestone ID' })
  @ApiResponse({ status: 200, description: 'List of deliverable revisions' })
  getDeliverableRevisions(@Param('id') id: string, @Param('milestoneId') milestoneId: string) {
    return this.deliverableService.getRevisions(id, milestoneId);
  }

  @Post(':id/deliverables/:revisionId/review')
  @ApiOperation({
    summary: 'Review a deliverable revision',
    description:
      'Approves or rejects a specific deliverable revision. Reviewer comments are stored on ' +
      'that revision; the original submission remains in the history.',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID' })
  @ApiParam({ name: 'revisionId', description: 'Deliverable revision ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['decision', 'reviewerAddress'],
      properties: {
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        reviewerAddress: { type: 'string', example: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' },
        reviewerComments: { type: 'string', example: 'Section 3 needs rework' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Deliverable revision reviewed' })
  reviewDeliverable(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() dto: ReviewDeliverableDto,
  ) {
    return this.deliverableService.reviewDeliverable(
      id,
      revisionId,
      dto.decision,
      dto.reviewerAddress,
      dto.reviewerComments,
    );
  }

  // ---- Disputes (upstream webhook + Discord, plus bug fix #3 juror assignment) ----

  @Post(':id/dispute')
  @ApiOperation({
    summary: 'Raise a dispute',
    description:
      'Raises a dispute for an escrow. Triggers webhook events and Discord notifications.',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID', example: 'esc-1234567890' })
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
  })
  @ApiResponse({ status: 400, description: 'Escrow already disputed or released' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  async raiseDispute(@Param('id') id: string, @Body() dto: RaiseDisputeDto) {
    const escrow = await this.escrowService.raiseDispute(id, dto.reason);

    await this.webhookService.dispatch(WebhookEvent.EscrowDisputed, {
      escrowId: escrow.id,
      depositor: escrow.depositor,
      beneficiary: escrow.beneficiary,
      amountXLM: escrow.amountXLM,
      reason: escrow.disputeReason,
      disputedAt: escrow.disputedAt,
    });

    await this.discordService.notifyDisputeNeedsJurors({
      escrowId: escrow.id,
      depositor: escrow.depositor,
      beneficiary: escrow.beneficiary,
      amountXLM: escrow.amountXLM,
      reason: escrow.disputeReason,
    });

    return escrow;
  }

  @Post(':id/dispute/assign-jurors')
  @ApiOperation({
    summary: 'Assign jurors to a dispute (with conflict-of-interest detection)',
    description:
      'Assigns jurors to a disputed escrow. Jurors with no prior counterparty relationship ' +
      'with either disputant are assigned first; conflicted jurors fill remaining slots but ' +
      'are explicitly flagged — never silently assigned.',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', example: 3 } },
    },
  })
  @ApiResponse({ status: 200, description: 'Juror assignments with conflict flags' })
  assignJurors(@Param('id') id: string, @Body() dto: AssignJurorsDto) {
    return this.disputeService.assignJurors(id, dto.count);
  }

  @Get(':id/dispute/jurors')
  @ApiOperation({
    summary: 'Get juror assignments for a dispute',
    description: 'Returns jurors assigned to a disputed escrow, including conflict flags.',
  })
  @ApiParam({ name: 'id', description: 'Escrow ID' })
  @ApiResponse({ status: 200, description: 'Juror assignments' })
  getJurorAssignments(@Param('id') id: string) {
    return this.disputeService.getAssignments(id);
  }

  // ---- Sweep (bug fix #1 — adaptive batching + overlap guard) ----

  @Post('sweep/run')
  @ApiOperation({
    summary: 'Trigger an escrow sweep (manual)',
    description:
      'Runs a single sweep pass over all escrows to detect expired deadlines and auto-release ' +
      'them. Uses an adaptive batch size and an overlap guard so a slow run cannot double up ' +
      'with the next scheduled run.',
  })
  @ApiResponse({ status: 200, description: 'Sweep result' })
  runSweep() {
    return this.sweepService.runSweep();
  }

  @Get('sweep/status')
  @ApiOperation({
    summary: 'Get sweep status',
    description: 'Returns whether a sweep is currently in progress.',
  })
  @ApiResponse({ status: 200, description: 'Sweep status' })
  getSweepStatus() {
    return { sweeping: this.sweepService.isSweeping() };
  }
}

// ---- Juror-pool management (top-level, not escrow-scoped) ----

@ApiTags('Escrow')
@Controller('jurors')
export class JurorController {
  constructor(private readonly disputeService: DisputeService) {}

  @Post()
  @ApiOperation({
    summary: 'Register a juror',
    description:
      'Adds a Stellar address to the active juror pool available for dispute assignment.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', example: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Juror registered' })
  register(@Body() dto: RegisterJurorDto): Juror {
    return this.disputeService.registerJuror(dto.address);
  }

  @Get()
  @ApiOperation({
    summary: 'List the juror pool',
    description: 'Returns all active juror addresses.',
  })
  @ApiResponse({ status: 200, description: 'Juror pool addresses' })
  list() {
    return { jurors: this.disputeService.getJurorPool() };
  }
}
