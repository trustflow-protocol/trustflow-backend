import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RpcFailoverService } from './rpc-failover.service';

interface EndpointStatusResponse {
  url: string;
  healthy: boolean;
  lastChecked: string;
  failureCount: number;
  lastError?: string;
}

interface RpcStatusResponse {
  currentHorizonEndpoint: string;
  currentSorobanEndpoint: string;
  horizonEndpoints: EndpointStatusResponse[];
  sorobanEndpoints: EndpointStatusResponse[];
  timestamp: string;
}

@ApiTags('RPC Status')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('rpc-status')
export class RpcStatusController {
  constructor(private readonly rpcFailoverService: RpcFailoverService) {}

  @Get()
  @ApiOperation({
    summary: 'Get current RPC endpoint status and health information',
    description:
      'Returns the health status of all configured Horizon and Soroban RPC endpoints, including which endpoint is currently active.',
  })
  @ApiResponse({
    status: 200,
    description: 'RPC endpoint status information',
    schema: {
      example: {
        currentHorizonEndpoint: 'https://horizon-testnet.stellar.org',
        currentSorobanEndpoint: 'https://soroban-testnet.stellar.org',
        horizonEndpoints: [
          {
            url: 'https://horizon-testnet.stellar.org',
            healthy: true,
            lastChecked: '2024-01-01T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        sorobanEndpoints: [
          {
            url: 'https://soroban-testnet.stellar.org',
            healthy: true,
            lastChecked: '2024-01-01T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  getStatus(): RpcStatusResponse {
    const horizonEndpoints = this.rpcFailoverService.getAllHorizonEndpoints();
    const sorobanEndpoints = this.rpcFailoverService.getAllSorobanEndpoints();

    return {
      currentHorizonEndpoint: this.rpcFailoverService.getCurrentHorizonEndpoint(),
      currentSorobanEndpoint: this.rpcFailoverService.getCurrentSorobanEndpoint(),
      horizonEndpoints: horizonEndpoints.map(ep => ({
        url: ep.url,
        healthy: ep.healthy,
        lastChecked: ep.lastChecked.toISOString(),
        failureCount: ep.failureCount,
        lastError: ep.lastError,
      })),
      sorobanEndpoints: sorobanEndpoints.map(ep => ({
        url: ep.url,
        healthy: ep.healthy,
        lastChecked: ep.lastChecked.toISOString(),
        failureCount: ep.failureCount,
        lastError: ep.lastError,
      })),
      timestamp: new Date().toISOString(),
    };
  }
}
