import { ApiProperty } from '@nestjs/swagger';

export class TokenResponseDto {
  @ApiProperty({
    description: 'JWT token for API authentication (expires in 1 hour)',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  token!: string;

  @ApiProperty({
    description: 'Opaque refresh token for obtaining a new access token (expires in 7 days, single-use)',
    example: 'abc123def456...',
    required: false,
  })
  refreshToken?: string;
}
