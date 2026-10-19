import { Test, TestingModule } from '@nestjs/testing';
import { RpcStatusController } from './rpc-status.controller';
import { RpcFailoverService } from './rpc-failover.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ExecutionContext } from '@nestjs/common';

describe('RpcStatusController', () => {
  let controller: RpcStatusController;
  let rpcFailoverService: jest.Mocked<RpcFailoverService>;

  const mockHorizonEndpoints = [
    {
      url: 'https://horizon-testnet.stellar.org',
      healthy: true,
      lastChecked: new Date('2024-01-01T00:00:00.000Z'),
      failureCount: 0,
      lastError: undefined,
    },
    {
      url: 'https://testnet.stellar.org',
      healthy: false,
      lastChecked: new Date('2024-01-01T00:05:00.000Z'),
      failureCount: 3,
      lastError: 'Connection timeout',
    },
  ];

  const mockSorobanEndpoints = [
    {
      url: 'https://soroban-testnet.stellar.org',
      healthy: true,
      lastChecked: new Date('2024-01-01T00:00:00.000Z'),
      failureCount: 0,
      lastError: undefined,
    },
    {
      url: 'https://rpc-testnet.stellar.org',
      healthy: true,
      lastChecked: new Date('2024-01-01T00:10:00.000Z'),
      failureCount: 0,
      lastError: undefined,
    },
  ];

  beforeEach(async () => {
    const mockRpcFailoverService = {
      getCurrentHorizonEndpoint: jest.fn(),
      getCurrentSorobanEndpoint: jest.fn(),
      getAllHorizonEndpoints: jest.fn(),
      getAllSorobanEndpoints: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RpcStatusController],
      providers: [
        {
          provide: RpcFailoverService,
          useValue: mockRpcFailoverService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => true,
      })
      .compile();

    controller = module.get<RpcStatusController>(RpcStatusController);
    rpcFailoverService = module.get(RpcFailoverService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getStatus', () => {
    it('should return formatted RPC status with all endpoint information', () => {
      rpcFailoverService.getCurrentHorizonEndpoint.mockReturnValue(
        'https://horizon-testnet.stellar.org',
      );
      rpcFailoverService.getCurrentSorobanEndpoint.mockReturnValue(
        'https://soroban-testnet.stellar.org',
      );
      rpcFailoverService.getAllHorizonEndpoints.mockReturnValue(mockHorizonEndpoints);
      rpcFailoverService.getAllSorobanEndpoints.mockReturnValue(mockSorobanEndpoints);

      const result = controller.getStatus();

      expect(result).toMatchObject({
        currentHorizonEndpoint: 'https://horizon-testnet.stellar.org',
        currentSorobanEndpoint: 'https://soroban-testnet.stellar.org',
        horizonEndpoints: [
          {
            url: 'https://horizon-testnet.stellar.org',
            healthy: true,
            lastChecked: '2024-01-01T00:00:00.000Z',
            failureCount: 0,
          },
          {
            url: 'https://testnet.stellar.org',
            healthy: false,
            lastChecked: '2024-01-01T00:05:00.000Z',
            failureCount: 3,
            lastError: 'Connection timeout',
          },
        ],
        sorobanEndpoints: [
          {
            url: 'https://soroban-testnet.stellar.org',
            healthy: true,
            lastChecked: '2024-01-01T00:00:00.000Z',
            failureCount: 0,
          },
          {
            url: 'https://rpc-testnet.stellar.org',
            healthy: true,
            lastChecked: '2024-01-01T00:10:00.000Z',
            failureCount: 0,
          },
        ],
      });
      expect(result.timestamp).toBeDefined();
      expect(typeof result.timestamp).toBe('string');
    });

    it('should correctly map Date objects to ISO strings', () => {
      rpcFailoverService.getCurrentHorizonEndpoint.mockReturnValue('https://horizon.example.com');
      rpcFailoverService.getCurrentSorobanEndpoint.mockReturnValue('https://soroban.example.com');
      rpcFailoverService.getAllHorizonEndpoints.mockReturnValue([mockHorizonEndpoints[0]]);
      rpcFailoverService.getAllSorobanEndpoints.mockReturnValue([mockSorobanEndpoints[0]]);

      const result = controller.getStatus();

      expect(result.horizonEndpoints[0].lastChecked).toBe('2024-01-01T00:00:00.000Z');
      expect(result.sorobanEndpoints[0].lastChecked).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should include lastError when present', () => {
      rpcFailoverService.getCurrentHorizonEndpoint.mockReturnValue('https://horizon.example.com');
      rpcFailoverService.getCurrentSorobanEndpoint.mockReturnValue('https://soroban.example.com');
      rpcFailoverService.getAllHorizonEndpoints.mockReturnValue([mockHorizonEndpoints[1]]);
      rpcFailoverService.getAllSorobanEndpoints.mockReturnValue([mockSorobanEndpoints[0]]);

      const result = controller.getStatus();

      expect(result.horizonEndpoints[0].lastError).toBe('Connection timeout');
    });

    it('should not include lastError when undefined', () => {
      rpcFailoverService.getCurrentHorizonEndpoint.mockReturnValue('https://horizon.example.com');
      rpcFailoverService.getCurrentSorobanEndpoint.mockReturnValue('https://soroban.example.com');
      rpcFailoverService.getAllHorizonEndpoints.mockReturnValue([mockHorizonEndpoints[0]]);
      rpcFailoverService.getAllSorobanEndpoints.mockReturnValue([mockSorobanEndpoints[0]]);

      const result = controller.getStatus();

      expect(result.horizonEndpoints[0].lastError).toBeUndefined();
    });

    it('should handle empty endpoint arrays', () => {
      rpcFailoverService.getCurrentHorizonEndpoint.mockReturnValue('https://horizon.example.com');
      rpcFailoverService.getCurrentSorobanEndpoint.mockReturnValue('https://soroban.example.com');
      rpcFailoverService.getAllHorizonEndpoints.mockReturnValue([]);
      rpcFailoverService.getAllSorobanEndpoints.mockReturnValue([]);

      const result = controller.getStatus();

      expect(result.horizonEndpoints).toEqual([]);
      expect(result.sorobanEndpoints).toEqual([]);
      expect(result.currentHorizonEndpoint).toBe('https://horizon.example.com');
      expect(result.currentSorobanEndpoint).toBe('https://soroban.example.com');
    });
  });

  describe('JWT Authentication', () => {
    it('should be protected by JwtAuthGuard', () => {
      const guards = Reflect.getMetadata('__guards__', RpcStatusController);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
    });

    it('should require authentication on getStatus endpoint', () => {
      const guards = Reflect.getMetadata('__guards__', controller.getStatus);
      // Guard is applied at controller level, so check there
      const controllerGuards = Reflect.getMetadata('__guards__', RpcStatusController);
      expect(controllerGuards).toContain(JwtAuthGuard);
    });
  });
});
