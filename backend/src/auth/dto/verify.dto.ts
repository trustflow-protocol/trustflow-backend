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
    message: 'Invalid Stellar public key format',
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
