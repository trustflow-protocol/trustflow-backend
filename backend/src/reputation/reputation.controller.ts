import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ReputationService } from './reputation.service';
import { ReputationScoreResponseDto } from './reputation.dto';
import { REPUTATION_LEADERBOARD_DEFAULT_LIMIT } from './reputation.types';

@ApiTags('Reputation')
@Controller('reputation')
export class ReputationController {
  constructor(private readonly reputationService: ReputationService) {}

  @Get('leaderboard')
  @ApiOperation({ summary: 'List addresses ranked by trust score, highest first' })
  @ApiQuery({ name: 'limit', required: false, example: REPUTATION_LEADERBOARD_DEFAULT_LIMIT })
  @ApiResponse({ status: 200, type: [ReputationScoreResponseDto] })
  getLeaderboard(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    const effectiveLimit =
      limit !== undefined && Number.isFinite(parsed) && parsed > 0
        ? parsed
        : REPUTATION_LEADERBOARD_DEFAULT_LIMIT;
    return this.reputationService.getLeaderboard(effectiveLimit);
  }

  @Get(':address')
  @ApiOperation({
    summary: 'Get the time-decayed, Sybil-dampened trust score for an address',
    description:
      'Score is derived from escrow completion and dispute-resolution history. Repeated interactions ' +
      'with the same counterparty are dampened with diminishing returns to resist wash-trading and ' +
      'self-dealing, and the score exponentially decays toward zero without new activity.',
  })
  @ApiParam({ name: 'address', example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' })
  @ApiResponse({ status: 200, type: ReputationScoreResponseDto })
  getScore(@Param('address') address: string) {
    return this.reputationService.getScore(address);
  }
}
