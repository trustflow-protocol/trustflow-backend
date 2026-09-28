import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { MetricsService } from './metrics.service';
import { SkipRateLimit } from '../common/rate-limit/rate-limit.decorator';

@ApiTags('Monitoring')
@Controller()
export class HealthController {
  constructor(
    private health: HealthService,
    private metrics: MetricsService,
  ) {}

  @Get('health/live')
  @SkipRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Returns 200 if the process is up. Does not check external dependencies. Used for Kubernetes liveness probes.',
  })
  @ApiResponse({ status: 200, description: 'Process is alive' })
  async getLiveness(): Promise<import('./health.service').LivenessProbe> {
    return this.health.liveness();
  }

  @Get('health/ready')
  @SkipRateLimit()
  @ApiOperation({
    summary: 'Readiness probe',
    description: 'Returns 200 if ready to handle traffic, 503 if critical dependencies are down.',
  })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  @ApiResponse({ status: 503, description: 'Service is not ready' })
  async getReadiness(): Promise<import('./health.service').ReadinessProbe> {
    const result = await this.health.readiness();
    if (result.status === 'down') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }

  @Get('health')
  @SkipRateLimit()
  @ApiOperation({
    summary: 'Health check (use /health/live or /health/ready instead)',
    description: 'Returns the health status of the API. Returns 503 if down or degraded.',
  })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  @ApiResponse({ status: 503, description: 'Service is unhealthy' })
  async getHealth(): Promise<import('./health.service').HealthStatus> {
    const result = await this.health.check();
    if (result.status === 'down') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }

  @Get('metrics')
  @SkipRateLimit()
  @ApiOperation({
    summary: 'Prometheus metrics',
    description: 'Returns metrics in Prometheus format for monitoring and alerting.',
  })
  @ApiResponse({
    status: 200,
    description: 'Prometheus metrics',
    content: {
      'text/plain': {
        schema: {
          type: 'string',
          example:
            '# HELP http_requests_total Total HTTP requests\n# TYPE http_requests_total counter\nhttp_requests_total 1234',
        },
      },
    },
  })
  @ApiExcludeEndpoint() // Exclude from main docs since it's Prometheus format
  getMetrics() {
    return this.metrics.toPrometheus();
  }
}
