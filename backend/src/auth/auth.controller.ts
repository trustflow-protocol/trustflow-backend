import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ChallengeDto } from './dto/challenge.dto';
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
    type: ChallengeResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Address parameter required' })
  getChallenge(@Query('address') address: string): ChallengeResponseDto {
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
    type: VerifyDto,
    description: 'Signature verification details',
  })
  @ApiResponse({
    status: 200,
    description: 'Signature verified, JWT token generated',
    type: TokenResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  verify(@Body() verifyDto: VerifyDto): TokenResponseDto {
    const valid = this.authService.verifySignature(verifyDto.address, verifyDto.signature);
    if (!valid) throw new Error('Invalid signature');
    return { token: this.authService.generateToken(verifyDto.address) };
  }
}
