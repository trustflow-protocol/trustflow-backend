import { Test, TestingModule } from '@nestjs/testing';
import { SentryService } from './sentry.service';

// Mock @sentry/node so tests never make network calls
jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn().mockReturnValue('mock-event-id'),
  captureMessage: jest.fn().mockReturnValue('mock-msg-id'),
  withScope: jest.fn((cb: (scope: unknown) => unknown) => {
    const scope = { setTag: jest.fn(), setExtra: jest.fn(), setUser: jest.fn() };
    return cb(scope);
  }),
}));

import * as Sentry from '@sentry/node';

describe('SentryService', () => {
  let service: SentryService;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };

    const module: TestingModule = await Test.createTestingModule({
      providers: [SentryService],
    }).compile();

    service = module.get<SentryService>(SentryService);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('init()', () => {
    it('should not call Sentry.init when SENTRY_DSN is missing', () => {
      delete process.env.SENTRY_DSN;
      service.init();
      expect(Sentry.init).not.toHaveBeenCalled();
      expect(service.isInitialized()).toBe(false);
    });

    it('should call Sentry.init with correct options when DSN is set', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      process.env.NODE_ENV = 'production';
      service.init();
      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://test@sentry.io/1',
          environment: 'production',
          enabled: true,
        }),
      );
      expect(service.isInitialized()).toBe(true);
    });

    it('should use lower tracesSampleRate in production', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      process.env.NODE_ENV = 'production';
      service.init();
      expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ tracesSampleRate: 0.2 }));
    });

    it('should use full tracesSampleRate in non-production', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      process.env.NODE_ENV = 'development';
      service.init();
      expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ tracesSampleRate: 1.0 }));
    });
  });

  describe('captureException()', () => {
    it('should return empty string when Sentry is not initialized', () => {
      const result = service.captureException(new Error('test'));
      expect(result).toBe('');
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('should call Sentry.captureException and return event id when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      service.init();
      const result = service.captureException(new Error('boom'), 'TestContext');
      expect(Sentry.captureException).toHaveBeenCalled();
      expect(result).toBe('mock-event-id');
    });
  });

  describe('captureMessage()', () => {
    it('should return empty string when Sentry is not initialized', () => {
      const result = service.captureMessage('hello');
      expect(result).toBe('');
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('should call Sentry.captureMessage with level when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/1';
      service.init();
      const result = service.captureMessage('deploy notice', 'warning');
      expect(Sentry.captureMessage).toHaveBeenCalledWith('deploy notice', 'warning');
      expect(result).toBe('mock-msg-id');
    });
  });

  describe('isInitialized()', () => {
    it('should return false before init is called', () => {
      expect(service.isInitialized()).toBe(false);
    });

    it('should return false when DSN is absent even after init', () => {
      delete process.env.SENTRY_DSN;
      service.init();
      expect(service.isInitialized()).toBe(false);
    });
  });
});
