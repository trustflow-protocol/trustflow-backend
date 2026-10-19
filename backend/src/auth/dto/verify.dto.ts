import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyDto {
  @ApiProperty({
    description: 'Stellar wallet address',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^G[A-Z0-9]{55}$/, {
    message: 'address must be a valid Stellar public key (G...)',
  })
  address: string;

  @ApiProperty({
    description: 'Base64-encoded signature of the challenge message',
    example: 'SGVsbG8gV29ybGQh...',
  })
  @IsString()
  @IsNotEmpty()
  signature: string;
}
