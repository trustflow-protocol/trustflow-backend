import { ApiProperty } from '@nestjs/swagger';

export class ChallengeResponseDto {
  @ApiProperty({
    description: 'Challenge message to sign with wallet',
    example: 'Sign this message to authenticate with TrustFlow: a1b2c3d4e5f6...',
  })
  challenge: string;
}
