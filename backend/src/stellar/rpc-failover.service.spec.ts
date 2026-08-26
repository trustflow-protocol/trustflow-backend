import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { RpcFailoverService } from './rpc-failover.service';

// Mock environment variables before importing the service
const mockHorizonEndpoints = 'https://horizon-testnet.stellar.org,https://testnet.stellar.org';
const mockSorobanEndpoints = 'https://soroban-testnet.stellar.org,https://rpc-testnet.stellar.org';

describe('RpcFailoverService', () => {
  let service: RpcFailoverService;
  let loggerSpy: jest.SpyInstance;

  beforeEach(async () => {
    // Set environment variables for testing
    process.env.STELLAR_HORIZON_ENDPOINTS = mockHorizonEndpoints;
    process.env.SOROBAN_RPC_ENDPOINTS = mockSorobanEndpoints;

    const module: TestingModule = await Test.createTestingModule({
      providers: [RpcFailoverService],
    }).compile();

    service = module.get<RpcFailoverService>(RpcFailoverService);
    
    // Spy on logger
    loggerSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    delete process.env.STELLAR_HORIZON_ENDPOINTS;
    delete process.env.SOROBAN_RPC_ENDPOINTS;
    jest.clearAllMocks();
    if (service) {
      service.onModuleDestroy();
    }
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should initialize endpoints from environment variables', () => {
    expect(service.getAllHorizonEndpoints()).toHaveLength(2);
    expect(service.getAllSorobanEndpoints()).toHaveLength(2);
    
    const horizonEndpoints = service.getAllHorizonEndpoints();
    expect(horizonEndpoints[0].url).toBe('https://horizon-testnet.stellar.org');
    expect(horizonEndpoints[1].url).toBe('https://testnet.stellar.org');
    
    const sorobanEndpoints = service.getAllSorobanEndpoints();
    expect(sorobanEndpoints[0].url).toBe('https://soroban-testnet.stellar.org');
    expect(sorobanEndpoints[1].url).toBe('https://rpc-testnet.stellar.org');
  });

  it('should set first endpoint as current by default', () => {
    expect(service.getCurrentHorizonEndpoint()).toBe('https://horizon-testnet.stellar.org');
    expect(service.getCurrentSorobanEndpoint()).toBe('https://soroban-testnet.stellar.org');
  });

  it('should handle single endpoint configuration', () => {
    delete process.env.STELLAR_HORIZON_ENDPOINTS;
    delete process.env.SOROBAN_RPC_ENDPOINTS;
    
    // Recreate service with updated env vars
    const newService = new RpcFailoverService();
    
    expect(newService.getCurrentHorizonEndpoint()).toBe('https://horizon-testnet.stellar.org');
    expect(newService.getCurrentSorobanEndpoint()).toBe('https://soroban-testnet.stellar.org');
    
    newService.onModuleDestroy();
  });

  it('should get all endpoints status', () => {
    const horizonEndpoints = service.getAllHorizonEndpoints();
    const sorobanEndpoints = service.getAllSorobanEndpoints();
    
    expect(horizonEndpoints).toBeDefined();
    expect(sorobanEndpoints).toBeDefined();
    
    horizonEndpoints.forEach(ep => {
      expect(ep).toHaveProperty('url');
      expect(ep).toHaveProperty('healthy');
      expect(ep).toHaveProperty('lastChecked');
      expect(ep).toHaveProperty('failureCount');
    });
  });

  describe('endpoint health checks', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
      global.fetch = jest.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should mark endpoint as healthy on successful health check', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
      });

      // We need to manually trigger health check since interval might not run
      const endpoint = service.getAllHorizonEndpoints()[0];
      await (service as any).checkHorizonEndpoint(endpoint);
      
      expect(endpoint.healthy).toBe(true);
      expect(endpoint.failureCount).toBe(0);
      expect(endpoint.lastError).toBeUndefined();
    });

    it('should mark endpoint as unhealthy on failed health check', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const endpoint = service.getAllHorizonEndpoints()[0];
      await (service as any).checkHorizonEndpoint(endpoint);
      
      expect(endpoint.healthy).toBe(false);
      expect(endpoint.failureCount).toBe(1);
      expect(endpoint.lastError).toBe('HTTP 500');
    });

    it('should mark endpoint as unhealthy on fetch error', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const endpoint = service.getAllHorizonEndpoints()[0];
      await (service as any).checkHorizonEndpoint(endpoint);
      
      expect(endpoint.healthy).toBe(false);
      expect(endpoint.failureCount).toBe(1);
      expect(endpoint.lastError).toBe('Network error');
    });
  });

  describe('failover switching', () => {
    it('should switch to healthy endpoint when current becomes unhealthy', () => {
      const horizonEndpoints = service.getAllHorizonEndpoints();
      
      // Simulate first endpoint becoming unhealthy
      horizonEndpoints[0].healthy = false;
      horizonEndpoints[0].failureCount = 3;
      horizonEndpoints[1].healthy = true;
      
      (service as any).switchToHealthyHorizonEndpoint();
      
      expect(service.getCurrentHorizonEndpoint()).toBe(horizonEndpoints[1].url);
    });

    it('should not switch if no healthy endpoints available', () => {
      const originalEndpoint = service.getCurrentHorizonEndpoint();
      const horizonEndpoints = service.getAllHorizonEndpoints();
      
      // Mark all endpoints unhealthy
      horizonEndpoints.forEach(ep => {
        ep.healthy = false;
        ep.failureCount = 3;
      });
      
      (service as any).switchToHealthyHorizonEndpoint();
      
      // Should stay on original endpoint
      expect(service.getCurrentHorizonEndpoint()).toBe(originalEndpoint);
    });

    it('should not switch if already on healthy endpoint', () => {
      const originalEndpoint = service.getCurrentHorizonEndpoint();
      const horizonEndpoints = service.getAllHorizonEndpoints();
      
      // Mark all endpoints healthy
      horizonEndpoints.forEach(ep => {
        ep.healthy = true;
        ep.failureCount = 0;
      });
      
      (service as any).switchToHealthyHorizonEndpoint();
      
      // Should stay on original endpoint
      expect(service.getCurrentHorizonEndpoint()).toBe(originalEndpoint);
    });
  });

  describe('getHorizonServer', () => {
    it('should create Horizon server with current endpoint', async () => {
      const server = await service.getHorizonServer();
      expect(server).toBeDefined();
    });
  });
});