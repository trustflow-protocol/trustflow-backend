import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { STELLAR_ADDRESS_REGEX } from '../escrow/escrow.dto';

export class BuildReleaseTransactionQueryDto {
  @ApiProperty({
    description: 'Stellar address that will sign and submit the transaction',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(STELLAR_ADDRESS_REGEX, { message: 'sourceAccount must be a valid Stellar address' })
  sourceAccount: string;
}
