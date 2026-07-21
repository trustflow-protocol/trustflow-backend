import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsIn,
  MinLength,
  MaxLength,
  IsOptional,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { DisputeStep, DisputeVerdict, JurorVote, SagaStepRecord } from './dispute.types';

export class EscalateDisputeDto {
  @ApiProperty({ description: 'Stellar address of the initiating party', example: 'GXXX...' })
  @IsString()
  @IsNotEmpty()
  initiator: string;

  @ApiProperty({ description: 'Reason for the dispute', minLength: 10, maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class AssignJurorsDto {
  @ApiProperty({
    description: '3–7 juror Stellar addresses',
    type: [String],
    minItems: 3,
    maxItems: 7,
  })
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(7)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  jurors: string[];
}

export class CastVoteDto {
  @ApiProperty({ description: 'Stellar address of the voting juror' })
  @IsString()
  @IsNotEmpty()
  jurorAddress: string;

  @ApiProperty({ enum: ['depositor', 'beneficiary', 'split'] })
  @IsString()
  @IsIn(['depositor', 'beneficiary', 'split'])
  vote: 'depositor' | 'beneficiary' | 'split';
}

export class ExecutePayoutDto {
  @ApiPropertyOptional({
    description: 'Depositor share percentage for a split verdict (0–100)',
    example: 50,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  splitPercentage?: number;
}

export class SagaStepRecordDto implements SagaStepRecord {
  @ApiProperty({ enum: DisputeStep }) step: DisputeStep;
  @ApiProperty() startedAt: string;
  @ApiPropertyOptional() completedAt?: string;
  @ApiPropertyOptional() failedAt?: string;
  @ApiPropertyOptional() compensatedAt?: string;
  @ApiPropertyOptional() error?: string;
}

export class DisputeSagaResponseDto {
  @ApiProperty() sagaId: string;
  @ApiProperty() escrowId: string;
  @ApiProperty() initiator: string;
  @ApiProperty() reason: string;
  @ApiProperty({ enum: DisputeStep }) currentStep: DisputeStep;
  @ApiPropertyOptional() escalationTxHash?: string;
  @ApiPropertyOptional({ type: [String] }) assignedJurors?: string[];
  @ApiPropertyOptional() votes?: JurorVote[];
  @ApiPropertyOptional({ enum: DisputeVerdict }) verdict?: DisputeVerdict;
  @ApiPropertyOptional() payoutTxHash?: string;
  @ApiProperty({ type: [SagaStepRecordDto] }) stepHistory: SagaStepRecordDto[];
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
  @ApiPropertyOptional() completedAt?: string;
  @ApiPropertyOptional() failedAt?: string;
  @ApiPropertyOptional() compensationReason?: string;
}
