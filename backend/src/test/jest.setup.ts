/**
 * Jest setup file: initializes environment and config before any tests run.
 *
 * This file is loaded once before test suite execution (see jest.config.js setupFiles).
 * It ensures:
 * 1. NODE_ENV is explicitly 'test' so config validation is in test mode
 * 2. JWT_SECRET has a safe test default (not the production-required 16 chars)
 * 3. validateEnv() is called, caching the config so imports in tests work
 *
 * Tests should NOT need `validateEnv()` calls in their body — it happens once here.
 * Tests that need to change config values use `setTestEnv()` and `resetEnvConfig()`
 * from the config module (see env.config.ts).
 */

import { validateEnv, TEST_ONLY_JWT_SECRET } from '../config/env.config';

process.env.NODE_ENV = 'test';

// Ensure JWT_SECRET is set to the test default before validation
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  process.env.JWT_SECRET = TEST_ONLY_JWT_SECRET;
}

// Initialize config once at startup so imports throughout the test suite work
validateEnv();
