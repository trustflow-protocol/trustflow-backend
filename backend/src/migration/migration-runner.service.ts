import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { randomUUID } from 'crypto';
import { MigrationRegistryService } from './migration-registry.service';
import { MigrationStateStore } from './migration-state.store';
import { findDestructiveStatements } from './destructive-sql.util';
import {
  MigrationPhase,
  MigrationRun,
  MigrationStatus,
  MigrationStepRecord,
  SchemaMigration,
} from './migration.types';

const DEFAULT_BATCH_SIZE = 100;

const IN_PROGRESS_STATUSES = new Set<MigrationStatus>([
  MigrationStatus.PENDING,
  MigrationStatus.EXPANDING,
  MigrationStatus.BACKFILLING,
  MigrationStatus.CONTRACTING,
  MigrationStatus.ROLLING_BACK,
]);

export interface RunMigrationOptions {
  batchSize?: number;
  batchDelayMs?: number;
  dryRun?: boolean;
  /** Required when the migration declares a destructive `plannedContractSql()` statement (#971). */
  force?: boolean;
}

/**
 * Orchestrates the expand → backfill → contract lifecycle for registered
 * migrations. Backfill always runs in small, cursor-paginated batches with a
 * yield (or configurable delay) between them, so a large table is never held
 * under a single long-running operation. Any failure automatically triggers
 * the migration's compensating rollback actions.
 */
@Injectable()
export class MigrationRunnerService {
  private readonly logger = new SanitizedLogger(MigrationRunnerService.name);

  constructor(
    private readonly registry: MigrationRegistryService,
    private readonly store: MigrationStateStore,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async findById(runId: string): Promise<MigrationRun> {
    const run = await this.store.findById(runId);
    if (!run) throw new NotFoundException(`Migration run ${runId} not found`);
    return run;
  }

  async findAll(): Promise<MigrationRun[]> {
    return this.store.findAll();
  }

  async run(name: string, options: RunMigrationOptions = {}, adminAddress?: string): Promise<MigrationRun> {
    const migration = this.registry.get(name);

    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const batchDelayMs = options.batchDelayMs ?? 0;
    const dryRun = options.dryRun ?? false;

    // A dry run only previews what would happen, so it's safe to let it surface a destructive
    // statement without `force` — the gate only has to stop an actual apply (#971).
    if (!dryRun) {
      const destructive = findDestructiveStatements(migration.plannedContractSql?.() ?? []);
      if (destructive.length > 0 && !options.force) {
        throw new BadRequestException(
          `Migration "${name}" will run destructive operation(s) during its contract phase: ` +
            `${destructive.join('; ')}. Re-run with "force: true" to proceed.`,
        );
      }
    }

    const now = new Date().toISOString();

    const run: MigrationRun = {
      runId: `mig-${Date.now()}-${randomUUID().slice(0, 8)}`,
      migrationName: name,
      targetTable: migration.targetTable,
      status: MigrationStatus.PENDING,
      progress: { totalRows: 0, processedRows: 0, failedRows: 0, batchSize },
      stepHistory: [],
      dryRun,
      adminAddress,
      createdAt: now,
      updatedAt: now,
    };

    // Dry-run mode: simulate without making changes
    if (dryRun) {
      this.logger.log(`Migration ${name} (${run.runId}) running in DRY-RUN mode`);
      run.status = MigrationStatus.COMPLETED;
      run.completedAt = new Date().toISOString();
      run.progress.totalRows = await migration.countPending();
      this.logger.log(
        `[DRY-RUN] Would process ${run.progress.totalRows} rows in ${Math.ceil(run.progress.totalRows / batchSize)} batches`,
      );
      if (this.audit) {
        await this.audit.logOperation({
          operation: 'MIGRATION_RUN',
          user: adminAddress ?? 'system',
          entityId: run.runId,
          entityType: 'migration',
          metadata: { migrationName: name, dryRun: true },
        });
      }
      return run;
    }

    // Must be this function's first `await` — see claimAndCreate()'s doc comment for why a
    // separate findActiveByName()-then-create() pair would race two overlapping calls.
    const claim = await this.store.claimAndCreate(run);
    if (!claim.claimed) {
      const existing = claim.activeRunId ? await this.store.findById(claim.activeRunId) : undefined;
      if (existing && IN_PROGRESS_STATUSES.has(existing.status)) {
        throw new ConflictException(
          `Migration "${name}" already has an active run (${existing.runId}, status ${existing.status})`,
        );
      }
      // The active marker pointed at a run that's missing or no longer in progress (every
      // terminal path clears it, so this is a stale-data edge case, not the normal flow) —
      // reclaim the slot and create the record now rather than leaving a dangling pointer behind.
      await this.store.markActive(name, run.runId);
      await this.store.create(run);
    }

    try {
      await this.runExpand(migration, run);
      await this.runBackfill(migration, run, batchSize, batchDelayMs);
      await this.runContract(migration, run);

      run.status = MigrationStatus.COMPLETED;
      run.completedAt = new Date().toISOString();
      await this.store.save(run);
      await this.store.clearActive(name);
      if (this.audit) {
        await this.audit.logOperation({
          operation: 'MIGRATION_RUN',
          user: adminAddress ?? 'system',
          entityId: run.runId,
          entityType: 'migration',
          metadata: { migrationName: name, dryRun: false, status: run.status },
        });
      }
      this.logger.log(`Migration ${name} (${run.runId}) completed`);
      return run;
    } catch (error) {
      await this.compensate(migration, run, error);
      throw error;
    }
  }

  /** Manually rolls back a run that is no longer in progress (completed or failed). */
  async rollback(runId: string, adminAddress?: string): Promise<MigrationRun> {
    const run = await this.findById(runId);
    if (IN_PROGRESS_STATUSES.has(run.status)) {
      throw new ConflictException(`Migration run ${runId} is still in progress (${run.status})`);
    }
    if (run.status === MigrationStatus.ROLLED_BACK) {
      throw new BadRequestException(`Migration run ${runId} has already been rolled back`);
    }

    const migration = this.registry.get(run.migrationName);
    await this.compensate(migration, run, new Error('Manual rollback requested'), true);
    if (this.audit) {
      await this.audit.logOperation({
        operation: 'MIGRATION_ROLLBACK',
        user: adminAddress ?? 'system',
        entityId: run.runId,
        entityType: 'migration',
        metadata: { migrationName: run.migrationName, rollbackReason: run.rollbackReason },
      });
    }
    return run;
  }

  /**
   * Reconciles out-of-band schema changes: marks a migration as COMPLETED in the registry
   * with a mandatory audit note, preventing conflicting re-runs.
   */
  async markApplied(
    name: string,
    dto: { reason?: string; justification?: string },
  ): Promise<MigrationRun> {
    const auditNote = (dto.reason || dto.justification || '').trim();
    if (!auditNote) {
      throw new BadRequestException('A mandatory audit note/justification is required to mark migration as applied');
    }

    const migration = this.registry.get(name);

    const now = new Date().toISOString();
    const runId = `mig-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const run: MigrationRun = {
      runId,
      migrationName: name,
      targetTable: migration.targetTable,
      status: MigrationStatus.COMPLETED,
      progress: {
        totalRows: 0,
        processedRows: 0,
        failedRows: 0,
        batchSize: DEFAULT_BATCH_SIZE,
        startedAt: now,
        completedAt: now,
      },
      stepHistory: [
        {
          phase: MigrationPhase.EXPAND,
          startedAt: now,
          completedAt: now,
        },
        {
          phase: MigrationPhase.BACKFILL,
          startedAt: now,
          completedAt: now,
        },
        {
          phase: MigrationPhase.CONTRACT,
          startedAt: now,
          completedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      auditNote,
    };

    const claim = await this.store.claimAndCreate(run);
    if (!claim.claimed) {
      const existing = claim.activeRunId ? await this.store.findById(claim.activeRunId) : undefined;
      if (existing && IN_PROGRESS_STATUSES.has(existing.status)) {
        throw new ConflictException(
          `Migration "${name}" already has an active run (${existing.runId}, status ${existing.status})`,
        );
      }
      await this.store.markActive(name, run.runId);
      await this.store.create(run);
    }

    await this.store.save(run);
    await this.store.clearActive(name);
    this.logger.log(`Migration "${name}" (${run.runId}) manually marked as applied: ${auditNote}`);
    return run;
  }

  // ─── Phases ─────────────────────────────────────────────────────────

  private async runExpand(migration: SchemaMigration, run: MigrationRun): Promise<void> {
    run.status = MigrationStatus.EXPANDING;
    this.recordPhaseStart(run, MigrationPhase.EXPAND);
    await this.store.save(run);

    await migration.expand();

    this.recordPhaseComplete(run, MigrationPhase.EXPAND);
    await this.store.save(run);
    this.logger.log(`Migration ${run.migrationName}: expand complete`);
  }

  private async runBackfill(
    migration: SchemaMigration,
    run: MigrationRun,
    batchSize: number,
    batchDelayMs: number,
  ): Promise<void> {
    run.status = MigrationStatus.BACKFILLING;
    this.recordPhaseStart(run, MigrationPhase.BACKFILL);
    run.progress.totalRows = await migration.countPending();
    run.progress.startedAt = new Date().toISOString();
    await this.store.save(run);

    let cursor: string | undefined;
    let done = run.progress.totalRows === 0;

    while (!done) {
      const result = await migration.backfillBatch(cursor, batchSize);
      run.progress.processedRows += result.processed;
      run.progress.failedRows += result.failed;
      run.progress.cursor = result.nextCursor;
      await this.store.save(run);

      cursor = result.nextCursor;
      done = result.done;

      // Yield between batches so a long backfill never blocks other requests
      // or holds the target table under a single long-running operation.
      if (!done) {
        await new Promise(resolve =>
          batchDelayMs > 0 ? setTimeout(resolve, batchDelayMs) : setImmediate(resolve),
        );
      }
    }

    run.progress.completedAt = new Date().toISOString();
    this.recordPhaseComplete(run, MigrationPhase.BACKFILL);
    await this.store.save(run);
    this.logger.log(
      `Migration ${run.migrationName}: backfill complete ` +
        `(${run.progress.processedRows}/${run.progress.totalRows} rows)`,
    );
  }

  private async runContract(migration: SchemaMigration, run: MigrationRun): Promise<void> {
    run.status = MigrationStatus.CONTRACTING;
    this.recordPhaseStart(run, MigrationPhase.CONTRACT);
    await this.store.save(run);

    await migration.contract();

    this.recordPhaseComplete(run, MigrationPhase.CONTRACT);
    await this.store.save(run);
    this.logger.log(`Migration ${run.migrationName}: contract complete`);
  }

  // ─── Rollback / compensation ──────────────────────────────────────

  private async compensate(
    migration: SchemaMigration,
    run: MigrationRun,
    error: unknown,
    manual = false,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Migration ${run.migrationName} (${run.runId}): rolling back — ${reason}`);

    if (!manual) {
      this.recordPhaseFailed(run, reason);
    }

    run.status = MigrationStatus.ROLLING_BACK;
    run.rollbackReason = reason;
    const contractAttempted = run.stepHistory.some(s => s.phase === MigrationPhase.CONTRACT);
    const expandAttempted = run.stepHistory.some(s => s.phase === MigrationPhase.EXPAND);
    this.recordPhaseStart(run, MigrationPhase.ROLLBACK);
    await this.store.save(run);

    try {
      if (contractAttempted) await migration.rollbackContract();
      if (expandAttempted) await migration.rollbackExpand();

      this.recordPhaseComplete(run, MigrationPhase.ROLLBACK);
      run.status = MigrationStatus.ROLLED_BACK;
      await this.store.clearActive(run.migrationName);
      await this.store.save(run);
    } catch (compensationError) {
      const compensationReason =
        compensationError instanceof Error ? compensationError.message : String(compensationError);
      this.recordPhaseFailed(run, compensationReason);
      run.status = MigrationStatus.FAILED;
      run.failedAt = new Date().toISOString();
      await this.store.clearActive(run.migrationName);
      await this.store.save(run);
      this.logger.error(
        `Migration ${run.migrationName} (${run.runId}): rollback itself failed`,
        compensationError instanceof Error ? compensationError.stack : String(compensationError),
      );
      throw compensationError;
    }
  }

  // ─── Step history helpers ─────────────────────────────────────────

  private recordPhaseStart(run: MigrationRun, phase: MigrationPhase): void {
    run.currentPhase = phase;
    run.stepHistory.push({ phase, startedAt: new Date().toISOString() });
  }

  private recordPhaseComplete(run: MigrationRun, phase: MigrationPhase): void {
    const record = this.lastRecord(run, phase);
    if (record) record.completedAt = new Date().toISOString();
  }

  private recordPhaseFailed(run: MigrationRun, error: string): void {
    if (!run.currentPhase) return;
    const record = this.lastRecord(run, run.currentPhase);
    if (record) {
      record.failedAt = new Date().toISOString();
      record.error = error;
    }
  }

  private lastRecord(run: MigrationRun, phase: MigrationPhase): MigrationStepRecord | undefined {
    return [...run.stepHistory].reverse().find(r => r.phase === phase);
  }
}
