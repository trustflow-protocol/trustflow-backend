import { z } from 'zod';

/**
 * Centralized environment variable validation using Zod.
 *
 * Every environment variable read by the application is declared here with its type,
 * format constraints, and required-vs-optional-with-default semantics. Validation
 * runs once at startup (see validateEnv() in main.ts) and fails fast with a readable
 * error listing every invalid/missing variable, rather than silently falling through
 * to defaults or unusable values scattered across the codebase.
 *
 * After validation, typed config values are exported via the `config` object for use
 * throughout the application, replacing inline `process.env.X || fallback` reads.
 */

const EnvSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Server configuration
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGIN: z.string().optional(),
  API_URL: z.string().url().optional().default('http://localhost:3001'),
  BODY_LIMIT_MB: z.coerce.number().int().positive().default(15),

  // Authentication & Security
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters for security'),
  ADMIN_ADDRESSES: z
    .string()
    .optional()
    .describe('Comma-separated list of Stellar addresses with admin access'),

  // Stellar Network Configuration
  STELLAR_NETWORK: z.enum(['TESTNET', 'PUBLIC', 'MAINNET']).default('TESTNET'),
  STELLAR_HORIZON_URL: z.string().url().default('https://horizon-testnet.stellar.org'),
  SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  TRUSTFLOW_CONTRACT_ID: z
    .string()
    .regex(/^C[A-Z2-7]{55}$/, 'TRUSTFLOW_CONTRACT_ID must be a valid Stellar contract address')
    .optional()
    .describe('Required for on-chain operations; optional for off-chain-only deployments'),

  // Stellar failover endpoints (comma-separated URLs)
  STELLAR_HORIZON_ENDPOINTS: z.string().optional(),
  SOROBAN_RPC_ENDPOINTS: z.string().optional(),

  // Redis Configuration
  REDIS_URL: z
    .string()
    .url()
    .optional()
    .describe('Required for rate limiting, outbox relay, and distributed caches'),

  // Database Configuration (PostgreSQL)
  DATABASE_URL: z
    .string()
    .url()
    .optional()
    .describe('PostgreSQL connection string; currently optional infrastructure'),

  // Monitoring & Observability
  SENTRY_DSN: z
    .string()
    .url()
    .optional()
    .describe('Sentry error tracking DSN; errors are logged but not reported when unset'),

  // Discord Integration
  DISCORD_WEBHOOK_URL: z
    .string()
    .url()
    .optional()
    .describe('Discord webhook for dispute notifications'),

  // Rate Limiting Configuration
  RATE_LIMIT_ABUSE_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_ABUSE_THRESHOLD: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(900),

  // Event Processing Configuration
  EVENT_PROCESSING_CONCURRENCY: z.coerce.number().int().positive().default(8),

  // IPFS Pinning Configuration
  IPFS_PINATA_JWT: z.string().optional().describe('Pinata API JWT token'),
  IPFS_WEB3_STORAGE_TOKEN: z.string().optional().describe('Web3.Storage API token'),
  IPFS_INFURA_PROJECT_ID: z.string().optional().describe('Infura IPFS project ID'),
  IPFS_INFURA_PROJECT_SECRET: z.string().optional().describe('Infura IPFS project secret'),

  // Reputation System Configuration
  REPUTATION_DECAY_HALF_LIFE_MS: z.coerce.number().int().positive().optional(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

let validatedConfig: EnvConfig | null = null;

/**
 * Validate environment variables against the schema and cache the result.
 *
 * This function is called once at startup (in main.ts). If validation fails,
 * it throws a ZodError with a readable message listing all invalid/missing
 * variables. The error includes paths and reasons for each failed field.
 *
 * @throws {z.ZodError} when required variables are missing or malformed
 */
export function validateEnv(): EnvConfig {
  if (validatedConfig) {
    return validatedConfig;
  }

  try {
    validatedConfig = EnvSchema.parse(process.env);
    return validatedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessage = error.errors
        .map(err => `  - ${err.path.join('.')}: ${err.message}`)
        .join('\n');

      throw new Error(
        `Environment variable validation failed:\n${errorMessage}\n\n` +
          `Fix the above issues in your .env file or environment configuration.`,
      );
    }
    throw error;
  }
}

/**
 * Get the validated config object. Must call validateEnv() first (typically in main.ts).
 *
 * @throws {Error} if validateEnv() hasn't been called yet
 */
export function getConfig(): EnvConfig {
  if (!validatedConfig) {
    throw new Error('Config not initialized. Call validateEnv() first.');
  }
  return validatedConfig;
}

/**
 * Exported config object for convenient access throughout the application.
 * Replaces scattered `process.env.X || fallback` reads with typed, validated values.
 *
 * Usage:
 *   import { config } from './config/env.config';
 *   const port = config.PORT;  // typed as number, guaranteed to be valid
 */
export const config = new Proxy({} as EnvConfig, {
  get(_target, prop: string) {
    return getConfig()[prop as keyof EnvConfig];
  },
});
