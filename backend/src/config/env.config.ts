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

/** `.env.example` ships blank values (`DB_HOST=`); treat them as unset. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalPositiveInt = () =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional());
const optionalString = () => z.preprocess(blankToUndefined, z.string().optional());
const optionalBool = () => z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional());

const EnvSchema = z
  .object({
    // Node environment
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Server configuration
    PORT: z.coerce.number().int().positive().default(3001),
    CORS_ORIGIN: z.string().optional(),
    API_URL: z.string().url().optional().default('http://localhost:3001'),
    BODY_LIMIT_MB: z.coerce.number().int().positive().default(15),

    // Authentication & Security
    // JWT_SECRET is required in production but may fall back to a clearly-marked
    // test-only default in non-production environments so local dev/test can boot
    // without a real secret. Production without a secret must fail fast.
    JWT_SECRET: z.string().optional(),
    JWT_SECRET_PREVIOUS: z
      .string()
      .optional()
      .describe('Previous JWT signing secret kept active during a rotation overlap window'),
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
    SOROBAN_START_LEDGER: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Contract deployment ledger to start ingestion from'),

    // Redis Configuration
    REDIS_URL: z
      .string()
      .url()
      .optional()
      .describe('Required for rate limiting, outbox relay, and distributed caches'),

    // Database Configuration (PostgreSQL)
    DATABASE_URL: z
      .preprocess(blankToUndefined, z.string().url().optional())
      .describe('PostgreSQL connection string; currently optional infrastructure'),

    // Monitoring & Observability
    DB_HOST: optionalString(),
    DB_PORT: optionalPositiveInt(),
    DB_NAME: optionalString(),
    DB_USER: optionalString(),
    DB_PASSWORD: optionalString(),
    DB_SSL: optionalBool(),
    DB_SSL_CA: optionalString(),
    DB_SSL_CERT: optionalString(),
    DB_SSL_KEY: optionalString(),
    DB_SSL_REJECT_UNAUTHORIZED: optionalBool(),
    DB_POOL_MAX: optionalPositiveInt(),
    DB_POOL_IDLE_TIMEOUT_MS: optionalPositiveInt(),
    DB_POOL_CONNECTION_TIMEOUT_MS: optionalPositiveInt(),

    SWAGGER_ENABLED: optionalBool().describe(
      'Serve Swagger UI and the OpenAPI JSON; defaults to true outside production, false in production',
    ),
    SWAGGER_USER: optionalString(),
    SWAGGER_PASSWORD: optionalString(),

    SENTRY_DSN: z
      .preprocess(blankToUndefined, z.string().url().optional())
      .describe('Sentry error tracking DSN; errors are logged but not reported when unset'),

    // Discord Integration
    DISCORD_WEBHOOK_URL: z
      .preprocess(blankToUndefined, z.string().url().optional())
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
  })
  .superRefine((data, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (Boolean(data.DB_HOST) !== Boolean(data.DB_NAME)) {
      issue('DB_HOST', 'DB_HOST and DB_NAME must be set together');
    }
    if (data.DATABASE_URL && (data.DB_HOST || data.DB_NAME)) {
      issue('DATABASE_URL', 'set either DATABASE_URL or DB_HOST/DB_NAME, not both');
    }
    if (data.DB_SSL_REJECT_UNAUTHORIZED === 'false' && data.NODE_ENV === 'production') {
      issue(
        'DB_SSL_REJECT_UNAUTHORIZED',
        'disabling PostgreSQL certificate verification is not allowed in production',
      );
    }
    if (Boolean(data.SWAGGER_USER) !== Boolean(data.SWAGGER_PASSWORD)) {
      issue('SWAGGER_USER', 'SWAGGER_USER and SWAGGER_PASSWORD must be set together');
    }
    const swaggerEnabled = data.SWAGGER_ENABLED
      ? data.SWAGGER_ENABLED === 'true'
      : data.NODE_ENV !== 'production';
    if (data.NODE_ENV === 'production' && swaggerEnabled && !data.SWAGGER_USER) {
      issue('SWAGGER_USER', 'protect production Swagger with SWAGGER_USER and SWAGGER_PASSWORD');
    }

    const secret = data.JWT_SECRET;
    const previousSecret = data.JWT_SECRET_PREVIOUS;

    if (data.NODE_ENV === 'production') {
      if (!secret || secret.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'JWT_SECRET is required in production',
        });
      } else if (secret.length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'JWT_SECRET must be at least 16 characters for security',
        });
      }
    } else {
      // Development/test: if a value is explicitly provided it must still meet minimum length
      if (secret !== undefined && secret !== '' && secret.length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'JWT_SECRET must be at least 16 characters for security',
        });
      }
    }

    if (previousSecret !== undefined && previousSecret !== '' && previousSecret.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET_PREVIOUS'],
        message: 'JWT_SECRET_PREVIOUS must be at least 16 characters for security',
      });
    }

    if (secret && previousSecret && secret === previousSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET_PREVIOUS'],
        message: 'JWT_SECRET_PREVIOUS must differ from JWT_SECRET',
      });
    }
  });

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Fallback used only when NODE_ENV !== 'production' and no JWT_SECRET is provided.
 * Clearly marked as test-only so it cannot be mistaken for a production secret.
 */
export const TEST_ONLY_JWT_SECRET =
  'test-only-jwt-secret-for-development-and-test-do-not-use-in-production';

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
    const parsed = EnvSchema.parse(process.env) as EnvConfig;
    // Inject clearly-marked test-only fallback for non-production when no secret is provided
    if (!parsed.JWT_SECRET || parsed.JWT_SECRET.trim() === '') {
      if (parsed.NODE_ENV !== 'production') {
        (parsed as Record<string, unknown>).JWT_SECRET = TEST_ONLY_JWT_SECRET;
      }
    }
    validatedConfig = parsed;
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
 * Deliberately throws instead of lazily calling validateEnv() on first access (#428). The
 * alternative — having `getConfig()` self-initialize — would make every module-level
 * `config.*` read "work by accident" regardless of import order, which is exactly the kind
 * of ordering bug this project keeps hitting: it would silently mask a *new* module-level
 * read added later (no test would ever exercise the "config not initialized yet" path,
 * since it could no longer occur). Keeping the throw means that dependency is explicit and
 * testable: every read of `config`/`getConfig()` must happen inside a factory, constructor,
 * or method body — something Nest (or a test) controls the timing of — never at module
 * evaluation time. `main.ts` still validates first via the top-level `validateEnv()` call;
 * tests validate first via an explicit `validateEnv()` call before importing the module
 * under test (see e.g. `rate-limit.guard.spec.ts`, `stellar.service.spec.ts`). See
 * `env-config-import-order.spec.ts` for a regression test asserting that importing a module
 * which reads `config` does NOT throw, because it no longer reads `config` at import time.
 *
 * @throws {Error} if validateEnv() hasn't been called yet
 */
export function getConfig(): EnvConfig {
  if (!validatedConfig) {
    throw new Error('Config not initialized. Call validateEnv() first.');
  }
  return validatedConfig;
}

export function getJwtVerificationSecrets(): string[] {
  const secrets = [config.JWT_SECRET, config.JWT_SECRET_PREVIOUS].filter(
    (secret): secret is string => Boolean(secret && secret.trim()),
  );

  return [...new Set(secrets)];
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
