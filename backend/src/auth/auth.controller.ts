import { Controller, Post, Body, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBody } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { VerifyDto } from './dto/verify.dto';
import { ChallengeResponseDto } from './dto/challenge-response.dto';
import { TokenResponseDto } from './dto/token-response.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('challenge')
  @ApiOperation({
    summary: 'Get authentication challenge',
    description:
      'Generates a single-use, time-limited challenge message for wallet signature. ' +
      'The challenge nonce is stored server-side with a 60-second TTL and is enforceably single-use. ' +
      'In multi-node deployments, nonces are stored in Redis for distributed replay protection.',
  })
  @ApiQuery({
    name: 'address',
    description: 'Stellar wallet address (G... public key)',
    required: true,
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({
    status: 200,
    description: 'Challenge generated successfully (valid for 60 seconds)',
    type: ChallengeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid Stellar address format',
  })
  async getChallenge(@Query('address') address: string): Promise<ChallengeResponseDto> {
    if (!address) throw new Error('address required');
    return { challenge: await this.authService.generateChallenge(address) };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify wallet signature',
    description:
      'Verifies the Stellar wallet-signed challenge and returns a JWT token. ' +
      'The challenge nonce is consumed atomically (single-use) and replay attempts are blocked. ' +
      'Each nonce is only valid for 60 seconds after generation.',
  })
  @ApiBody({
    type: VerifyDto,
    description: 'Signature verification details',
  })
  @ApiResponse({
    status: 200,
    description: 'Signature verified, JWT token generated',
    type: TokenResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid signature, expired challenge, or replay attempt blocked',
  })
  async verify(@Body() verifyDto: VerifyDto): Promise<TokenResponseDto> {
    const valid = await this.authService.verifySignature(verifyDto.address, verifyDto.signature);
    if (!valid) throw new Error('Invalid signature');
    return { token: this.authService.generateToken(verifyDto.address) };
  }
}
