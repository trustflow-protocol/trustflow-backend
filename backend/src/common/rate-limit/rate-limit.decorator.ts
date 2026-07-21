import { applyDecorators, SetMetadata } from '@nestjs/common';

export const SKIP_RATE_LIMIT = 'skip_rate_limit';
export const RATE_LIMIT_POINTS = 'rate_limit_points';
export const RATE_LIMIT_DURATION = 'rate_limit_duration';

export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);

export const RateLimit = (points: number, duration: number) =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_POINTS, points),
    SetMetadata(RATE_LIMIT_DURATION, duration),
  );
