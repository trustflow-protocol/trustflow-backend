import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  PinProviderName,
  PinRecord,
  PinStatus,
  ProviderPinRecord,
  ProviderPinStatus,
} from './ipfs-pinning.types';

export class PinContentDto {
  @ApiProperty({
    description:
      'Base64-encoded bytes of the deliverable to pin. ' +
      'Maximum decoded size is 10 MB (base64 overhead adds ~33%, so the encoded string cap is ~13.6 MB, ' +
      'enforced here as 14,316,560 base64 characters).',
    example: 'SGVsbG8sIFRydXN0RmxvdyE=',
  })
  @IsBase64()
  @IsNotEmpty()
  @MaxLength(14_316_560, {
    message: 'content exceeds the maximum allowed size of 10 MB (decoded)',
  })
  content: string;

  @ApiPropertyOptional({ description: 'Original filename, stored for display purposes only' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @ApiPropertyOptional({
    description:
      'CID the caller expects the content to hash to. If provided and it does not match the ' +
      'server-computed content hash, the pin request is rejected with 400 before any provider is contacted.',
    example: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
  })
  @IsOptional()
  @IsString()
  expectedCid?: string;

  @ApiPropertyOptional({
    description:
      'Number of providers that must successfully hold the pin. Clamped to the number of registered providers.',
    minimum: 1,
    maximum: 5,
    default: 2,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  replicationFactor?: number;
}

export class ProviderPinRecordDto implements ProviderPinRecord {
  @ApiProperty({ enum: PinProviderName }) provider: PinProviderName;
  @ApiProperty({ enum: ProviderPinStatus }) status: ProviderPinStatus;
  @ApiProperty() attempts: number;
  @ApiPropertyOptional() pinnedAt?: string;
  @ApiPropertyOptional() lastVerifiedAt?: string;
  @ApiPropertyOptional() lastError?: string;
}

export class PinRecordResponseDto implements PinRecord {
  @ApiProperty({ description: 'Content identifier (CIDv1, raw, sha2-256)' })
  cid: string;
  @ApiProperty() size: number;
  @ApiPropertyOptional() filename?: string;
  @ApiProperty() replicationFactor: number;
  @ApiProperty({ enum: PinStatus }) status: PinStatus;
  @ApiProperty({ type: [ProviderPinRecordDto] }) providers: ProviderPinRecordDto[];
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
