import { Controller, Post, Body, Get, Query, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBody } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { VerifyDto } from './dto/verify.dto';
import { ChallengeDto } from './dto/challenge.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ChallengeResponseDto } from './dto/challenge-response.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { RateLimit, RateLimitOnRedisError } from '../common/rate-limit/rate-limit.decorator';
import { config } from '../config/env.config';
import { ValidationErrorResponseDto } from '../common/validation/validation-error.dto';

@ApiTags('Authentication')
@Controller('auth')
// Fail closed if Redis is down: an unthrottled login flow invites brute-forcing, so these
// routes answer 503 + Retry-After instead of skipping the limiter.
@RateLimitOnRedisError('deny')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('challenge')
  // Stricter than the global default (#369). Thunks so the env is read per request.
  @RateLimit(
    () => config.AUTH_CHALLENGE_RATE_LIMIT_POINTS,
    () => config.AUTH_CHALLENGE_RATE_LIMIT_DURATION,
  )
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
    description: 'Missing or invalid Stellar address',
    type: ValidationErrorResponseDto,
  })
  @ApiResponse({ status: 429, description: 'Too many challenge requests (see Retry-After)' })
  async getChallenge(@Query() query: ChallengeDto): Promise<ChallengeResponseDto> {
    return { challenge: await this.authService.generateChallenge(query.address) };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit(
    () => config.AUTH_VERIFY_RATE_LIMIT_POINTS,
    () => config.AUTH_VERIFY_RATE_LIMIT_DURATION,
  )
  @ApiOperation({
    summary: 'Verify wallet signature',
    description:
      'Verifies the Stellar wallet-signed challenge and returns JWT access and refresh tokens. ' +
      'The challenge nonce is consumed atomically (single-use) and replay attempts are blocked. ' +
      'Each nonce is only valid for 60 seconds after generation. Access token expires in 1 hour; ' +
      'refresh token expires in 7 days and is single-use.',
  })
  @ApiBody({
    type: VerifyDto,
    description: 'Signature verification details',
  })
  @ApiResponse({
    status: 200,
    description: 'Signature verified, JWT and refresh tokens generated',
    type: TokenResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid signature, expired challenge, or replay attempt blocked',
  })
  @ApiResponse({ status: 400, description: 'Invalid request body', type: ValidationErrorResponseDto })
  @ApiResponse({ status: 429, description: 'Too many verification attempts (see Retry-After)' })
  async verify(@Body() verifyDto: VerifyDto): Promise<TokenResponseDto> {
    const valid = await this.authService.verifySignature(verifyDto.address, verifyDto.signature);
    if (!valid) throw new UnauthorizedException('Invalid signature');
    const refreshToken = await this.authService.generateRefreshToken(verifyDto.address);
    return {
      token: this.authService.generateToken(verifyDto.address, 3600),
      refreshToken,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token',
    description:
      'Obtains a new access token using a valid refresh token without re-signing. ' +
      'Refresh tokens are single-use and rotated on each refresh. ' +
      'Reusing an already-used or expired refresh token returns 401 and revokes the token family.',
  })
  @ApiBody({
    type: RefreshDto,
    description: 'Refresh token and address',
  })
  @ApiResponse({
    status: 200,
    description: 'New access and refresh tokens issued',
    type: TokenResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired, or already-used refresh token',
  })
  async refresh(@Body() refreshDto: RefreshDto): Promise<TokenResponseDto> {
    const result = await this.authService.refreshAccessToken(refreshDto.refreshToken, refreshDto.address);
    if (!result) {
      throw new UnauthorizedException('Invalid, expired, or already-used refresh token');
    }
    return {
      token: result.token,
      refreshToken: result.refreshToken,
    };
  }
}
