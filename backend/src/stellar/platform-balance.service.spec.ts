import { Test, TestingModule } from '@nestjs/testing';
import { PlatformBalanceService } from './platform-balance.service';
import { StellarService } from './stellar.service';
import { WebhookService } from '../webhook/webhook.service';
import { config } from '../config/env.config';

// Mock the config module
jest.mock('../config/env.config', () => ({
  config: {
    STELLAR_PLATFORM_ADDRESS: 'GTEST123PLATFORMADDRESS',
    STELLAR_LOW_BALANCE_THRESHOLD: 10.0,
    STELLAR_CRITICAL_BALANCE_THRESHOLD: 5.0,
  },
}));

describe('PlatformBalanceService', () => {
  let service: PlatformBalanceService;
  let stellarService: jest.Mocked<StellarService>;
  let webhookService: jest.Mocked<WebhookService>;
  let loggerDebugSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    const mockStellarService = {
      getBalance: jest.fn(),
    };

    const mockWebhookService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformBalanceService,
        {
          provide: StellarService,
          useValue: mockStellarService,
        },
        {
          provide: WebhookService,
          useValue: mockWebhookService,
        },
      ],
    }).compile();

    service = module.get<PlatformBalanceService>(PlatformBalanceService);
    stellarService = module.get(StellarService);
    webhookService = module.get(WebhookService);

    // Spy on logger methods
    loggerDebugSpy = jest.spyOn(service['logger'], 'debug').mockImplementation();
    loggerWarnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation();
    loggerErrorSpy = jest.spyOn(service['logger'], 'error').mockImplementation();

    // Reset lastAlertTime before each test
    service['lastAlertTime'] = 0;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkPlatformBalance - healthy balance', () => {
    it('should log debug message and not trigger alert when balance is healthy', async () => {
      stellarService.getBalance.mockResolvedValue('15.5');

      await service.checkPlatformBalance();

      expect(stellarService.getBalance).toHaveBeenCalledWith('GTEST123PLATFORMADDRESS');
      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Platform account balance healthy: 15.5 XLM'),
      );
      expect(webhookService.dispatch).not.toHaveBeenCalled();
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('checkPlatformBalance - WARNING threshold', () => {
    it('should trigger WARNING alert when balance crosses low threshold', async () => {
      stellarService.getBalance.mockResolvedValue('8.0');

      await service.checkPlatformBalance();

      expect(stellarService.getBalance).toHaveBeenCalledWith('GTEST123PLATFORMADDRESS');
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'Platform account balance low: 8 XLM (threshold: 10 XLM)',
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'platform.balance_alert',
        expect.objectContaining({
          level: 'WARNING',
          address: 'GTEST123PLATFORMADDRESS',
          balance: 8.0,
          message: 'Platform account balance low: 8 XLM (threshold: 10 XLM)',
        }),
      );
      expect(webhookService.dispatch).toHaveBeenCalledTimes(1);
    });

    it('should include timestamp in webhook payload', async () => {
      stellarService.getBalance.mockResolvedValue('8.0');
      const beforeCall = new Date().toISOString();

      await service.checkPlatformBalance();

      const webhookCall = webhookService.dispatch.mock.calls[0];
      const payload = webhookCall[1] as any;
      expect(payload).toHaveProperty('timestamp');
      expect(typeof payload.timestamp).toBe('string');
      expect(new Date(payload.timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(beforeCall).getTime(),
      );
    });
  });

  describe('checkPlatformBalance - CRITICAL threshold', () => {
    it('should trigger CRITICAL alert when balance crosses critical threshold', async () => {
      stellarService.getBalance.mockResolvedValue('3.5');

      await service.checkPlatformBalance();

      expect(stellarService.getBalance).toHaveBeenCalledWith('GTEST123PLATFORMADDRESS');
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'Platform account balance critically low: 3.5 XLM (threshold: 5 XLM)',
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'platform.balance_alert',
        expect.objectContaining({
          level: 'CRITICAL',
          address: 'GTEST123PLATFORMADDRESS',
          balance: 3.5,
          message: 'Platform account balance critically low: 3.5 XLM (threshold: 5 XLM)',
        }),
      );
    });

    it('should prioritize CRITICAL over WARNING when both thresholds crossed', async () => {
      stellarService.getBalance.mockResolvedValue('2.0');

      await service.checkPlatformBalance();

      // Should only trigger CRITICAL alert, not WARNING
      expect(webhookService.dispatch).toHaveBeenCalledTimes(1);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'platform.balance_alert',
        expect.objectContaining({
          level: 'CRITICAL',
        }),
      );
    });
  });

  describe('checkPlatformBalance - cooldown mechanism', () => {
    it('should suppress second alert within cooldown window', async () => {
      stellarService.getBalance.mockResolvedValue('8.0');

      // First alert
      await service.checkPlatformBalance();
      expect(webhookService.dispatch).toHaveBeenCalledTimes(1);

      // Second alert within cooldown (should be suppressed)
      await service.checkPlatformBalance();
      expect(webhookService.dispatch).toHaveBeenCalledTimes(1); // Still just 1
      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Alert cooldown active, skipping notification'),
      );
    });

    it('should allow alert after cooldown period expires', async () => {
      stellarService.getBalance.mockResolvedValue('8.0');

      // First alert
      await service.checkPlatformBalance();
      expect(webhookService.dispatch).toHaveBeenCalledTimes(1);

      // Simulate cooldown expiry by manipulating lastAlertTime
      const alertCooldownMs = 3600000; // 1 hour
      service['lastAlertTime'] = Date.now() - (alertCooldownMs + 1000); // 1 second past cooldown

      // Third alert after cooldown expires
      await service.checkPlatformBalance();
      expect(webhookService.dispatch).toHaveBeenCalledTimes(2);
    });

    it('should track cooldown time correctly', async () => {
      stellarService.getBalance.mockResolvedValue('8.0');

      const beforeFirstAlert = Date.now();
      await service.checkPlatformBalance();
      const afterFirstAlert = Date.now();

      expect(service['lastAlertTime']).toBeGreaterThanOrEqual(beforeFirstAlert);
      expect(service['lastAlertTime']).toBeLessThanOrEqual(afterFirstAlert);
    });
  });

  describe('checkPlatformBalance - no platform address configured', () => {
    it('should return early and not call stellarService when STELLAR_PLATFORM_ADDRESS is not configured', async () => {
      // Temporarily override config
      const originalAddress = config.STELLAR_PLATFORM_ADDRESS;
      (config as any).STELLAR_PLATFORM_ADDRESS = undefined;

      await service.checkPlatformBalance();

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        'STELLAR_PLATFORM_ADDRESS not configured, skipping balance check',
      );
      expect(stellarService.getBalance).not.toHaveBeenCalled();
      expect(webhookService.dispatch).not.toHaveBeenCalled();

      // Restore config
      (config as any).STELLAR_PLATFORM_ADDRESS = originalAddress;
    });

    it('should return early when STELLAR_PLATFORM_ADDRESS is empty string', async () => {
      const originalAddress = config.STELLAR_PLATFORM_ADDRESS;
      (config as any).STELLAR_PLATFORM_ADDRESS = '';

      await service.checkPlatformBalance();

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        'STELLAR_PLATFORM_ADDRESS not configured, skipping balance check',
      );
      expect(stellarService.getBalance).not.toHaveBeenCalled();

      (config as any).STELLAR_PLATFORM_ADDRESS = originalAddress;
    });
  });

  describe('checkPlatformBalance - error handling', () => {
    it('should catch and log error when stellarService.getBalance() rejects', async () => {
      const error = new Error('Network timeout');
      stellarService.getBalance.mockRejectedValue(error);

      await service.checkPlatformBalance();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Failed to check platform account balance: Network timeout',
      );
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });

    it('should handle non-Error exceptions gracefully', async () => {
      stellarService.getBalance.mockRejectedValue('string error');

      await service.checkPlatformBalance();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Failed to check platform account balance: string error',
      );
    });

    it('should not throw error when balance check fails', async () => {
      stellarService.getBalance.mockRejectedValue(new Error('Connection failed'));

      await expect(service.checkPlatformBalance()).resolves.not.toThrow();
    });
  });

  describe('checkPlatformBalance - invalid values', () => {
    it('should log error and skip alerting when balance is NaN', async () => {
      stellarService.getBalance.mockResolvedValue('not-a-number');

      await service.checkPlatformBalance();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid balance or threshold values'),
      );
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });

    it('should log error and skip alerting when thresholds are NaN', async () => {
      const originalLow = config.STELLAR_LOW_BALANCE_THRESHOLD;
      (config as any).STELLAR_LOW_BALANCE_THRESHOLD = NaN;

      stellarService.getBalance.mockResolvedValue('10.0');

      await service.checkPlatformBalance();

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid balance or threshold values'),
      );
      expect(webhookService.dispatch).not.toHaveBeenCalled();

      (config as any).STELLAR_LOW_BALANCE_THRESHOLD = originalLow;
    });
  });

  describe('checkPlatformBalance - webhook dispatch error handling', () => {
    it('should log error when webhook dispatch fails but not throw', async () => {
      stellarService.getBalance.mockResolvedValue('8.0');
      const webhookError = new Error('Webhook service unavailable');
      webhookService.dispatch.mockRejectedValue(webhookError);

      await service.checkPlatformBalance();

      // Wait for promise chain to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(loggerWarnSpy).toHaveBeenCalled(); // Alert was triggered
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Failed to dispatch platform balance alert: Webhook service unavailable',
      );
    });
  });
});
