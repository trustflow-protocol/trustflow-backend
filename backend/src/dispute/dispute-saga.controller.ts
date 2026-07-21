import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { DisputeSagaService } from './dispute-saga.service';
import {
  EscalateDisputeDto,
  AssignJurorsDto,
  CastVoteDto,
  ExecutePayoutDto,
  DisputeSagaResponseDto,
} from './dispute.dto';
import { JwtAuthGuard } from '../auth/auth.guard';

@ApiTags('Dispute Resolution')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('dispute')
export class DisputeSagaController {
  constructor(private readonly sagaService: DisputeSagaService) {}

  @Get()
  @ApiOperation({ summary: 'List all dispute sagas' })
  @ApiResponse({ status: 200, type: [DisputeSagaResponseDto] })
  findAll() {
    return this.sagaService.findAll();
  }

  @Get(':sagaId')
  @ApiOperation({ summary: 'Get a dispute saga by ID' })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 404, description: 'Saga not found' })
  findOne(@Param('sagaId') sagaId: string) {
    return this.sagaService.findById(sagaId);
  }

  @Get('escrow/:escrowId')
  @ApiOperation({ summary: 'Get the active dispute saga for an escrow' })
  @ApiParam({ name: 'escrowId', example: 'esc-1234567890' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  findByEscrow(@Param('escrowId') escrowId: string) {
    return this.sagaService.findByEscrowId(escrowId);
  }

  @Post('escrow/:escrowId/escalate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Step 1 — Escalate dispute',
    description:
      'Opens a new dispute saga for the escrow. Freezes the escrow and notifies juror pool via Discord. ' +
      'Compensating action: restores escrow status to active if this step fails.',
  })
  @ApiParam({ name: 'escrowId', example: 'esc-1234567890' })
  @ApiResponse({ status: 201, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 400, description: 'Escrow already released' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  @ApiResponse({ status: 409, description: 'Active saga already exists for this escrow' })
  escalate(@Param('escrowId') escrowId: string, @Body() dto: EscalateDisputeDto) {
    return this.sagaService.escalate(escrowId, dto);
  }

  @Post(':sagaId/assign-jurors')
  @ApiOperation({
    summary: 'Step 2 — Assign jurors',
    description:
      'Assigns 3–7 jurors to the dispute. ' +
      'Compensating action: clears the juror list and reverts the saga to the assignment step.',
  })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 400, description: 'Saga not at JUROR_ASSIGNMENT step' })
  assignJurors(@Param('sagaId') sagaId: string, @Body() dto: AssignJurorsDto) {
    return this.sagaService.assignJurors(sagaId, dto);
  }

  @Post(':sagaId/vote')
  @ApiOperation({
    summary: 'Step 3 — Cast a juror vote',
    description:
      'Records a vote from an assigned juror. When all jurors have voted, the verdict is computed ' +
      'automatically via majority rule and the saga advances to the PAYOUT step. ' +
      'Compensating action: removes the vote if an error occurs mid-recording.',
  })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 400, description: 'Juror not assigned or saga not at VOTING step' })
  @ApiResponse({ status: 409, description: 'Juror has already voted' })
  castVote(@Param('sagaId') sagaId: string, @Body() dto: CastVoteDto) {
    return this.sagaService.castVote(sagaId, dto);
  }

  @Post(':sagaId/payout')
  @ApiOperation({
    summary: 'Step 4 — Execute payout',
    description:
      'Releases funds based on the recorded verdict. For SPLIT verdicts, an optional ' +
      'splitPercentage (0–100, depositor share) can be provided; defaults to 50. ' +
      'Compensating action: re-flags the escrow as disputed and marks it for manual admin review.',
  })
  @ApiParam({ name: 'sagaId', example: 'saga-1234567890-abc' })
  @ApiResponse({ status: 200, type: DisputeSagaResponseDto })
  @ApiResponse({ status: 400, description: 'No verdict or saga not at PAYOUT step' })
  executePayout(@Param('sagaId') sagaId: string, @Body() dto: ExecutePayoutDto) {
    return this.sagaService.executePayout(sagaId, dto);
  }
}
