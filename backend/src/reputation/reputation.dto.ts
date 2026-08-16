import { ApiProperty } from '@nestjs/swagger';
import {
  ReputationEventLogEntry,
  ReputationEventType,
  ReputationScoreView,
} from './reputation.types';

export class ReputationEventLogEntryDto implements ReputationEventLogEntry {
  @ApiProperty({ enum: ReputationEventType }) type: ReputationEventType;
  @ApiProperty() counterparty: string;
  @ApiProperty({ description: 'Signed contribution to the score from this single event' })
  contribution: number;
  @ApiProperty() occurredAt: string;
}

export class ReputationScoreResponseDto implements ReputationScoreView {
  @ApiProperty({ example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' })
  address: string;

  @ApiProperty({
    description:
      'Time-decayed, Sybil-dampened trust score derived from escrow completion and dispute history',
    example: 42.5,
  })
  score: number;

  @ApiProperty({ description: 'Total escrow/dispute events that have contributed to this score' })
  eventCount: number;

  @ApiProperty({
    description: 'Number of distinct counterparties this address has interacted with',
  })
  distinctCounterparties: number;

  @ApiProperty({ type: [ReputationEventLogEntryDto] })
  recentEvents: ReputationEventLogEntryDto[];

  @ApiProperty() lastUpdatedAt: string;
}
