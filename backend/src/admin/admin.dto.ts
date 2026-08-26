import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReputationScoreResponseDto } from '../reputation/reputation.dto';
import {
  AnalyticsOverview,
  DisputeAnalytics,
  EscrowAnalytics,
  GigAnalytics,
  MigrationAnalytics,
  ReconciliationAnalytics,
  ReputationAnalytics,
} from './admin.types';

/** Shared shape for a `{ [status]: count }` breakdown — OpenAPI has no enum-keyed map type. */
const STATUS_COUNT_MAP_SCHEMA = {
  type: 'object' as const,
  additionalProperties: { type: 'number' as const },
};

export class EscrowAnalyticsDto implements EscrowAnalytics {
  @ApiProperty() total: number;
  @ApiProperty({
    ...STATUS_COUNT_MAP_SCHEMA,
    example: { pending: 3, active: 12, released: 40, disputed: 2, cancelled: 1 },
  })
  byStatus: Record<string, number>;
  @ApiProperty({ description: 'Sum of amountXLM across every escrow, regardless of status' })
  totalValueXLM: number;
}

export class GigAnalyticsDto implements GigAnalytics {
  @ApiProperty() total: number;
  @ApiProperty({
    ...STATUS_COUNT_MAP_SCHEMA,
    example: { open: 5, accepted: 20, expired: 3, cancelled: 1 },
  })
  byStatus: Record<string, number>;
}

export class DisputeAnalyticsDto implements DisputeAnalytics {
  @ApiProperty() total: number;
  @ApiProperty({ ...STATUS_COUNT_MAP_SCHEMA, example: { VOTING: 2, COMPLETED: 8 } })
  byStep: Record<string, number>;
  @ApiProperty({
    ...STATUS_COUNT_MAP_SCHEMA,
    description: 'Only sagas that have reached a verdict are counted here',
    example: { DEPOSITOR_WINS: 3, BENEFICIARY_WINS: 4, SPLIT: 1 },
  })
  byVerdict: Record<string, number>;
}

export class ReputationAnalyticsDto implements ReputationAnalytics {
  @ApiProperty({ description: 'Distinct addresses with a materialized reputation score' })
  trackedAddresses: number;
  @ApiProperty({ type: [ReputationScoreResponseDto] })
  topAddresses: ReputationScoreResponseDto[];
}

export class MigrationAnalyticsDto implements MigrationAnalytics {
  @ApiProperty() total: number;
  @ApiProperty({ ...STATUS_COUNT_MAP_SCHEMA, example: { COMPLETED: 4, FAILED: 1 } })
  byStatus: Record<string, number>;
}

export class ReconciliationAnalyticsDto implements ReconciliationAnalytics {
  @ApiProperty() totalRuns: number;
  @ApiProperty() totalDriftsDetected: number;
  @ApiProperty() totalDriftsRepaired: number;
  @ApiPropertyOptional({ description: 'completedAt of the most recent run, if any have run yet' })
  lastRunAt?: string;
}

export class AnalyticsOverviewDto implements AnalyticsOverview {
  @ApiProperty() generatedAt: string;
  @ApiProperty({ type: EscrowAnalyticsDto }) escrows: EscrowAnalyticsDto;
  @ApiProperty({ type: GigAnalyticsDto }) gigs: GigAnalyticsDto;
  @ApiProperty({ type: DisputeAnalyticsDto }) disputes: DisputeAnalyticsDto;
  @ApiProperty({ type: ReputationAnalyticsDto }) reputation: ReputationAnalyticsDto;
  @ApiProperty({ type: MigrationAnalyticsDto }) migrations: MigrationAnalyticsDto;
  @ApiProperty({ type: ReconciliationAnalyticsDto }) reconciliation: ReconciliationAnalyticsDto;
}
