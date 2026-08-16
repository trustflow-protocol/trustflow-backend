import { Controller, Get, Post, Param, Body, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { EscrowReconciliationService } from './escrow-reconciliation.service';
import { RunReconciliationDto, ReconciliationRunResponseDto } from './escrow-reconciliation.dto';
import { JwtAuthGuard } from '../auth/auth.guard';

@ApiTags('Escrow Reconciliation')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('escrow-reconciliation')
export class EscrowReconciliationController {
  constructor(private readonly reconciliationService: EscrowReconciliationService) {}

  @Post('run')
  @ApiOperation({
    summary: 'Diff on-chain escrow state against the DB and repair any drift found',
    description:
      'Checks every DB escrow linked to a contract ID against its on-chain state, repairing status/amount ' +
      'drift by trusting chain as the source of truth. Optionally also checks the supplied ' +
      'contractEscrowIds for a missed creation event (present on-chain, absent from the DB).',
  })
  @ApiResponse({ status: 201, type: ReconciliationRunResponseDto })
  run(@Body() dto: RunReconciliationDto) {
    return this.reconciliationService.reconcile(dto.contractEscrowIds ?? []);
  }

  @Get('runs')
  @ApiOperation({ summary: 'List all reconciliation runs, most recent first' })
  @ApiResponse({ status: 200, type: [ReconciliationRunResponseDto] })
  listRuns() {
    return this.reconciliationService.findAll();
  }

  @Get('runs/:runId')
  @ApiOperation({ summary: 'Get a reconciliation run by ID, including its drift report' })
  @ApiParam({ name: 'runId', example: 'recon-1234567890-abcd1234' })
  @ApiResponse({ status: 200, type: ReconciliationRunResponseDto })
  @ApiResponse({ status: 404, description: 'Run not found' })
  getRun(@Param('runId') runId: string) {
    const run = this.reconciliationService.findById(runId);
    if (!run) throw new NotFoundException(`Reconciliation run ${runId} not found`);
    return run;
  }
}
