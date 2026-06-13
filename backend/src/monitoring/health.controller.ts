import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { MetricsService } from './metrics.service';

@ApiTags('Monitoring')
@Controller()
export class HealthController {
  constructor(private health: HealthService, private metrics: MetricsService) {}

  @Get('health')
  @ApiOperation({
    summary: 'Health check',
    description: 'Returns the health status of the API. Used for liveness and readiness probes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Service is healthy',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', format: 'date-time' },
        uptime: { type: 'number', example: 12345 },
      },
    },
  })
  @ApiResponse({ status: 503, description: 'Service is unhealthy' })
  async getHealth() {
    return this.health.check();
  }

  @Get('metrics')
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
          example: '# HELP http_requests_total Total HTTP requests\n# TYPE http_requests_total counter\nhttp_requests_total 1234',
        },
      },
    },
  })
  @ApiExcludeEndpoint() // Exclude from main docs since it's Prometheus format
  getMetrics() {
    return this.metrics.toPrometheus();
  }
}
