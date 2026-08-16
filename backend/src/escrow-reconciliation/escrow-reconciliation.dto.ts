import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator';
import { DriftRecord, DriftType, ReconciliationRun } from './escrow-reconciliation.types';

export class RunReconciliationDto {
  @ApiPropertyOptional({
    description:
      'Contract escrow IDs to check for a missed creation event (present on-chain, absent from the DB). ' +
      'Not required for ordinary status/amount drift, which is checked automatically for every ' +
      'DB-linked escrow.',
    example: ['esc-chain-0x1a2b'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  contractEscrowIds?: string[];
}

export class DriftRecordDto implements DriftRecord {
  @ApiProperty() contractEscrowId: string;
  @ApiProperty({ enum: DriftType }) driftType: DriftType;
  @ApiPropertyOptional() dbValue?: Record<string, unknown>;
  @ApiPropertyOptional() chainValue?: Record<string, unknown>;
  @ApiProperty() repaired: boolean;
  @ApiPropertyOptional() repairError?: string;
  @ApiProperty() detectedAt: string;
}

export class ReconciliationRunResponseDto implements ReconciliationRun {
  @ApiProperty() runId: string;
  @ApiProperty() startedAt: string;
  @ApiProperty() completedAt: string;
  @ApiProperty() checked: number;
  @ApiProperty() driftCount: number;
  @ApiProperty() repairedCount: number;
  @ApiProperty({ type: [DriftRecordDto] }) drifts: DriftRecordDto[];
}
