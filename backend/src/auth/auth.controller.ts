import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('challenge')
  @ApiOperation({
    summary: 'Get authentication challenge',
    description:
      'Generates a challenge message for wallet signature. The user signs this message with their Stellar wallet to prove ownership.',
  })
  @ApiQuery({
    name: 'address',
    description: 'Stellar wallet address',
    required: true,
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({
    status: 200,
    description: 'Challenge generated successfully',
    schema: {
      type: 'object',
      properties: {
        challenge: {
          type: 'string',
          example: 'Sign this message to authenticate with TrustFlow: 1234567890',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Address parameter required' })
  getChallenge(@Query('address') address: string) {
    if (!address) throw new Error('address required');
    return { challenge: this.authService.generateChallenge(address) };
  }

  @Post('verify')
  @ApiOperation({
    summary: 'Verify wallet signature',
    description:
      'Verifies the signed challenge and returns a JWT token for authenticated API access.',
  })
  @ApiBody({
    description: 'Signature verification details',
    schema: {
      type: 'object',
      required: ['address', 'signature'],
      properties: {
        address: {
          type: 'string',
          description: 'Stellar wallet address',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        signature: {
          type: 'string',
          description: 'Base64-encoded signature of the challenge message',
          example: 'SGVsbG8gV29ybGQh...',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Signature verified, JWT token generated',
    schema: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          description: 'JWT token for API authentication',
          example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  verify(@Body() body: { address: string; signature: string }) {
    const valid = this.authService.verifySignature(body.address, body.signature);
    if (!valid) throw new Error('Invalid signature');
    return { token: this.authService.generateToken(body.address) };
  }
}
