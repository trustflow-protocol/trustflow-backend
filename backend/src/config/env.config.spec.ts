import { validateEnv } from './env.config';

describe('Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
    // Clear the cached config
    jest.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should validate and return config with all defaults when only JWT_SECRET is set', () => {
    process.env = {
      JWT_SECRET: 'test-secret-at-least-16-chars',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');
    const config = freshValidateEnv();

    expect(config.JWT_SECRET).toBe('test-secret-at-least-16-chars');
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3001);
    expect(config.STELLAR_NETWORK).toBe('TESTNET');
    expect(config.STELLAR_HORIZON_URL).toBe('https://horizon-testnet.stellar.org');
  });

  it('should throw when JWT_SECRET is missing', () => {
    process.env = {};

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');

    expect(() => freshValidateEnv()).toThrow('Environment variable validation failed');
    expect(() => freshValidateEnv()).toThrow('JWT_SECRET');
  });

  it('should throw when JWT_SECRET is too short', () => {
    process.env = {
      JWT_SECRET: 'short',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');

    expect(() => freshValidateEnv()).toThrow('JWT_SECRET must be at least 16 characters');
  });

  it('should throw when PORT is not a number', () => {
    process.env = {
      JWT_SECRET: 'test-secret-at-least-16-chars',
      PORT: 'not-a-number',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');

    expect(() => freshValidateEnv()).toThrow('Environment variable validation failed');
  });

  it('should throw when NODE_ENV is invalid', () => {
    process.env = {
      JWT_SECRET: 'test-secret-at-least-16-chars',
      NODE_ENV: 'invalid-env',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');

    expect(() => freshValidateEnv()).toThrow('Environment variable validation failed');
  });

  it('should accept valid production config', () => {
    process.env = {
      NODE_ENV: 'production',
      JWT_SECRET: 'production-secret-at-least-16-chars',
      PORT: '8080',
      CORS_ORIGIN: 'https://trustflow.xyz',
      API_URL: 'https://api.trustflow.xyz',
      STELLAR_NETWORK: 'PUBLIC',
      STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-rpc.stellar.org',
      TRUSTFLOW_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4',
      REDIS_URL: 'redis://localhost:6379',
      SENTRY_DSN: 'https://example@sentry.io/123456',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');
    const config = freshValidateEnv();

    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(8080);
    expect(config.STELLAR_NETWORK).toBe('PUBLIC');
    expect(config.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('should throw when TRUSTFLOW_CONTRACT_ID has invalid format', () => {
    process.env = {
      JWT_SECRET: 'test-secret-at-least-16-chars',
      TRUSTFLOW_CONTRACT_ID: 'invalid-contract-id',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');

    expect(() => freshValidateEnv()).toThrow(
      'TRUSTFLOW_CONTRACT_ID must be a valid Stellar contract address',
    );
  });

  it('should throw when URL fields are malformed', () => {
    process.env = {
      JWT_SECRET: 'test-secret-at-least-16-chars',
      STELLAR_HORIZON_URL: 'not-a-url',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');

    expect(() => freshValidateEnv()).toThrow('Environment variable validation failed');
  });

  it('should coerce numeric environment variables from strings', () => {
    process.env = {
      JWT_SECRET: 'test-secret-at-least-16-chars',
      PORT: '4000',
      BODY_LIMIT_MB: '20',
      RATE_LIMIT_ABUSE_THRESHOLD: '10',
      EVENT_PROCESSING_CONCURRENCY: '16',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');
    const config = freshValidateEnv();

    expect(config.PORT).toBe(4000);
    expect(config.BODY_LIMIT_MB).toBe(20);
    expect(config.RATE_LIMIT_ABUSE_THRESHOLD).toBe(10);
    expect(config.EVENT_PROCESSING_CONCURRENCY).toBe(16);
  });

  it('should accept MAINNET as legacy alias for PUBLIC', () => {
    process.env = {
      JWT_SECRET: 'test-secret-at-least-16-chars',
      STELLAR_NETWORK: 'MAINNET',
    };

    const { validateEnv: freshValidateEnv } = jest.requireActual('./env.config');
    const config = freshValidateEnv();

    // The validation should accept MAINNET, but stellar.config.ts normalizes it to PUBLIC
    expect(config.STELLAR_NETWORK).toBe('MAINNET');
  });
});
