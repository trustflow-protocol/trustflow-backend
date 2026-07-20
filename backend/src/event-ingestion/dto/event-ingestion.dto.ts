import { IsString, IsOptional, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class StartPollingDto {
  @ApiPropertyOptional({ description: 'Contract ID to monitor' })
  @IsString()
  @IsOptional()
  contractId?: string;
}

export class IngestLedgerDto {
  @ApiProperty({ description: 'Contract ID to ingest events for' })
  @IsString()
  contractId: string;

  @ApiProperty({ description: 'Ledger sequence to ingest' })
  @IsNumber()
  ledger: number;
}

export class HandleReorgDto {
  @ApiProperty({ description: 'Contract ID affected by reorg' })
  @IsString()
  contractId: string;

  @ApiProperty({ description: 'Ledger sequence to reprocess from' })
  @IsNumber()
  fromLedger: number;
}
