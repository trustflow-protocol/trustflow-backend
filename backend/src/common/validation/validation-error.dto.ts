import { ApiProperty } from '@nestjs/swagger';

export class FieldErrorDto {
  @ApiProperty({ example: 'address' })
  field!: string;

  @ApiProperty({ example: 'address must be a valid Stellar public key (G...)' })
  message!: string;
}

/** Swagger shape of every 400 caused by invalid input (#368). */
export class ValidationErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Validation failed' })
  message!: string;

  @ApiProperty({ type: [FieldErrorDto] })
  errors!: FieldErrorDto[];

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: '/v1/auth/challenge' })
  path!: string;
}
