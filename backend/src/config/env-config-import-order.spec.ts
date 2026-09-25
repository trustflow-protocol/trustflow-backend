/**
 * Regression coverage for #428: AuthModule used to read `config.JWT_SECRET` at
 * module-evaluation time (via `JwtModule.register({ secret: config.JWT_SECRET, ... })`).
 * Because ES imports are hoisted, `AppModule`'s import chain reached that read before
 * `main.ts`'s explicit `validateEnv()` call ever ran, so simply importing the module graph
 * crashed with "Config not initialized. Call validateEnv() first." — not the readable
 * validation error `validateEnv()` produces.
 *
 * This file intentionally does NOT call validateEnv() anywhere above, and Jest gives each
 * spec file its own fresh module registry, so requiring AuthModule below exercises exactly
 * the "config not yet initialized" ordering that used to crash at import time.
 */
describe('module import order does not depend on validateEnv() having run (#428)', () => {
  it('does not throw when AuthModule is required before validateEnv()', () => {
    expect(() => {
      require('../auth/auth.module');
    }).not.toThrow();
  });
});
