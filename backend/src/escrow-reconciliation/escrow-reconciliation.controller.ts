import { Controller, Get, Post, Param, Body, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { EscrowReconciliationService } from './escrow-reconciliation.service';
import { RunReconciliationDto, ReconciliationRunResponseDto } from './escrow-reconciliation.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../admin/admin.guard';

@ApiTags('Escrow Reconciliation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('escrow-reconciliation')
export class EscrowReconciliationController {
  constructor(private readonly reconciliationService: EscrowReconciliationService) {}

  @Post('run')
  @ApiOperation({
    summary: 'Diff on-chain escrow state against the DB and repair any drift found (admin only)',
    description:
      'Checks every DB escrow linked to a contract ID against its on-chain state, repairing status/amount ' +
      'drift by trusting chain as the source of truth. Optionally also checks the supplied ' +
      'contractEscrowIds for a missed creation event (present on-chain, absent from the DB).',
  })
  @ApiResponse({ status: 201, type: ReconciliationRunResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  run(@Body() dto: RunReconciliationDto) {
    return this.reconciliationService.reconcile(dto.contractEscrowIds ?? []);
  }

  @Get('runs')
  @ApiOperation({ summary: 'List all reconciliation runs, most recent first (admin only)' })
  @ApiResponse({ status: 200, type: [ReconciliationRunResponseDto] })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  listRuns() {
    return this.reconciliationService.findAll();
  }

  @Get('runs/:runId')
  @ApiOperation({ summary: 'Get a reconciliation run by ID, including its drift report (admin only)' })
  @ApiParam({ name: 'runId', example: 'recon-1234567890-abcd1234' })
  @ApiResponse({ status: 200, type: ReconciliationRunResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized — valid JWT required' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin privileges required' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async getRun(@Param('runId') runId: string) {
    const run = await this.reconciliationService.findById(runId);
    if (!run) throw new NotFoundException(`Reconciliation run ${runId} not found`);
    return run;
  }
}
