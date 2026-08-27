import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MigrationRegistryService } from './migration-registry.service';
import { MigrationRunnerService } from './migration-runner.service';

/**
 * Runs every registered schema migration automatically when the backend boots, instead
 * of requiring an operator to trigger each one manually via `POST /migrations/:name/run`.
 *
 * Gated by `RUN_MIGRATIONS_ON_STARTUP` (defaults to enabled outside `NODE_ENV=test`, so
 * running the app's own test suite never has the side effect of executing migrations).
 * Migrations run sequentially — a failure in one is logged and does not prevent the
 * others from running or block application startup, since a partially-migrated backend
 * that still serves traffic is preferable to one that never comes up at all.
 */
@Injectable()
export class MigrationStartupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MigrationStartupService.name);

  constructor(
    private readonly registry: MigrationRegistryService,
    private readonly runner: MigrationRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('Automatic startup migrations disabled (RUN_MIGRATIONS_ON_STARTUP=false)');
      return;
    }

    const definitions = this.registry.list();
    if (definitions.length === 0) return;

    this.logger.log(`Running ${definitions.length} registered schema migration(s) on startup`);

    let succeeded = 0;
    let failed = 0;

    for (const definition of definitions) {
      try {
        await this.runner.run(definition.name);
        succeeded += 1;
        this.logger.log(`Startup migration "${definition.name}" completed`);
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Startup migration "${definition.name}" failed`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    this.logger.log(`Startup migrations complete: ${succeeded} succeeded, ${failed} failed`);
  }

  private isEnabled(): boolean {
    const raw = process.env.RUN_MIGRATIONS_ON_STARTUP;
    if (raw !== undefined) return raw !== 'false';
    return process.env.NODE_ENV !== 'test';
  }
}
