import { Injectable, Logger } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { STELLAR_CONFIG } from './stellar.config';

interface EndpointStatus {
  url: string;
  healthy: boolean;
  lastChecked: Date;
  failureCount: number;
  lastError?: string;
}

@Injectable()
export class RpcFailoverService {
  private readonly logger = new Logger(RpcFailoverService.name);
  private horizonEndpoints: EndpointStatus[] = [];
  private sorobanEndpoints: EndpointStatus[] = [];
  private currentHorizonEndpoint: string;
  private currentSorobanEndpoint: string;
  private healthCheckInterval: NodeJS.Timeout;
  private readonly HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds
  private readonly MAX_FAILURES_BEFORE_UNHEALTHY = 3;
  private readonly HEALTH_CHECK_TIMEOUT_MS = 5000;

  constructor() {
    this.initializeEndpoints();
    this.startHealthChecks();
  }

  private initializeEndpoints() {
    // Initialize Horizon endpoints
    this.horizonEndpoints = STELLAR_CONFIG.horizonEndpoints.map(url => ({
      url,
      healthy: true,
      lastChecked: new Date(),
      failureCount: 0,
    }));

    // Initialize Soroban endpoints
    this.sorobanEndpoints = STELLAR_CONFIG.sorobanRpcEndpoints.map(url => ({
      url,
      healthy: true,
      lastChecked: new Date(),
      failureCount: 0,
    }));

    // Set current endpoints to first in list (primary)
    this.currentHorizonEndpoint = this.horizonEndpoints[0]?.url || STELLAR_CONFIG.horizonUrl;
    this.currentSorobanEndpoint = this.sorobanEndpoints[0]?.url || STELLAR_CONFIG.sorobanRpcUrl;

    this.logger.log(`Initialized ${this.horizonEndpoints.length} Horizon endpoints`);
    this.logger.log(`Initialized ${this.sorobanEndpoints.length} Soroban RPC endpoints`);
  }

  private startHealthChecks() {
    this.healthCheckInterval = setInterval(
      () => this.performHealthChecks(),
      this.HEALTH_CHECK_INTERVAL_MS,
    );
    this.logger.log(`Started health checks every ${this.HEALTH_CHECK_INTERVAL_MS}ms`);
  }

  private async performHealthChecks() {
    await Promise.all([
      ...this.horizonEndpoints.map(endpoint => this.checkHorizonEndpoint(endpoint)),
      ...this.sorobanEndpoints.map(endpoint => this.checkSorobanEndpoint(endpoint)),
    ]);
  }

  private async checkHorizonEndpoint(endpoint: EndpointStatus): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(`${endpoint.url}/ledgers?order=desc&limit=1`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        endpoint.healthy = true;
        endpoint.failureCount = 0;
        endpoint.lastError = undefined;
      } else {
        endpoint.healthy = false;
        endpoint.failureCount++;
        endpoint.lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      endpoint.healthy = false;
      endpoint.failureCount++;
      endpoint.lastError = error instanceof Error ? error.message : 'Unknown error';
      
      // If current endpoint is unhealthy, try to switch to a healthy one
      if (endpoint.url === this.currentHorizonEndpoint && endpoint.failureCount >= this.MAX_FAILURES_BEFORE_UNHEALTHY) {
        this.switchToHealthyHorizonEndpoint();
      }
    } finally {
      endpoint.lastChecked = new Date();
    }
  }

  private async checkSorobanEndpoint(endpoint: EndpointStatus): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(`${endpoint.url}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        endpoint.healthy = true;
        endpoint.failureCount = 0;
        endpoint.lastError = undefined;
      } else {
        endpoint.healthy = false;
        endpoint.failureCount++;
        endpoint.lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      endpoint.healthy = false;
      endpoint.failureCount++;
      endpoint.lastError = error instanceof Error ? error.message : 'Unknown error';
      
      // If current endpoint is unhealthy, try to switch to a healthy one
      if (endpoint.url === this.currentSorobanEndpoint && endpoint.failureCount >= this.MAX_FAILURES_BEFORE_UNHEALTHY) {
        this.switchToHealthySorobanEndpoint();
      }
    } finally {
      endpoint.lastChecked = new Date();
    }
  }

  private switchToHealthyHorizonEndpoint() {
    const healthyEndpoint = this.horizonEndpoints.find(ep => ep.healthy);
    if (healthyEndpoint && healthyEndpoint.url !== this.currentHorizonEndpoint) {
      this.logger.warn(`Switching Horizon endpoint from ${this.currentHorizonEndpoint} to ${healthyEndpoint.url}`);
      this.currentHorizonEndpoint = healthyEndpoint.url;
    } else if (!healthyEndpoint) {
      this.logger.error('No healthy Horizon endpoints available');
    }
  }

  private switchToHealthySorobanEndpoint() {
    const healthyEndpoint = this.sorobanEndpoints.find(ep => ep.healthy);
    if (healthyEndpoint && healthyEndpoint.url !== this.currentSorobanEndpoint) {
      this.logger.warn(`Switching Soroban RPC endpoint from ${this.currentSorobanEndpoint} to ${healthyEndpoint.url}`);
      this.currentSorobanEndpoint = healthyEndpoint.url;
    } else if (!healthyEndpoint) {
      this.logger.error('No healthy Soroban RPC endpoints available');
    }
  }

  getCurrentHorizonEndpoint(): string {
    return this.currentHorizonEndpoint;
  }

  getCurrentSorobanEndpoint(): string {
    return this.currentSorobanEndpoint;
  }

  getAllHorizonEndpoints(): EndpointStatus[] {
    return [...this.horizonEndpoints];
  }

  getAllSorobanEndpoints(): EndpointStatus[] {
    return [...this.sorobanEndpoints];
  }

  async getHorizonServer(): Promise<Horizon.Server> {
    // Try current endpoint first
    try {
      return new Horizon.Server(this.currentHorizonEndpoint);
    } catch (error) {
      this.logger.warn(`Failed to create Horizon server for ${this.currentHorizonEndpoint}: ${error}`);
      // Fall back to primary endpoint from config
      return new Horizon.Server(STELLAR_CONFIG.horizonUrl);
    }
  }

  onModuleDestroy() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }
}