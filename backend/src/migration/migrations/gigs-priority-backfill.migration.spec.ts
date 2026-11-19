import { Test, TestingModule } from '@nestjs/testing';
import { GigsPriorityBackfillMigration, GigRow } from './gigs-priority-backfill.migration';
import { MigrationRunnerService } from '../migration-runner.service';
import { MigrationRegistryService, MIGRATION_DEFINITIONS } from '../migration-registry.service';
import { MigrationStateStore } from '../migration-state.store';
import { MigrationStatus } from '../migration.types';

const SEED_ROWS: GigRow[] = [
  { id: 'gig-001', title: 'Smart contract security audit', budgetXLM: '500', urgent: true },
  { id: 'gig-002', title: 'Landing page redesign', budgetXLM: '150', urgent: false },
  { id: 'gig-003', title: 'Stellar anchor integration', budgetXLM: '900', urgent: true },
];

describe('GigsPriorityBackfillMigration (unit)', () => {
  let migration: GigsPriorityBackfillMigration;

  beforeEach(() => {
    migration = new GigsPriorityBackfillMigration(SEED_ROWS);
  });

  it('rejects backfill before expand has run', async () => {
    await expect(migration.backfillBatch(undefined, 10)).rejects.toThrow(
      'Cannot backfill gigs.priority before expand() has run',
    );
  });

  it('backfills priority from the legacy urgent flag in batches', async () => {
    await migration.expand();
    expect(await migration.countPending()).toBe(3);

    const first = await migration.backfillBatch(undefined, 2);
    expect(first.processed).toBe(2);
    expect(first.done).toBe(false);

    const second = await migration.backfillBatch(first.nextCursor, 2);
    expect(second.processed).toBe(1);
    expect(second.done).toBe(true);

    expect(migration.getRow('gig-001')?.priority).toBe(5);
    expect(migration.getRow('gig-002')?.priority).toBe(1);
    expect(migration.getRow('gig-003')?.priority).toBe(5);
    expect(await migration.countPending()).toBe(0);
  });

  it('contract drops the legacy urgent flag', async () => {
    await migration.expand();
    await migration.backfillBatch(undefined, 10);
    await migration.contract();

    for (const row of migration.allRows()) {
      expect(row.urgent).toBeUndefined();
    }
  });

  it('rollbackExpand removes the priority column', async () => {
    await migration.expand();
    await migration.backfillBatch(undefined, 10);
    await migration.rollbackExpand();

    for (const row of migration.allRows()) {
      expect(row.priority).toBeUndefined();
    }
  });

  it('rollbackContract restores urgent from priority', async () => {
    await migration.expand();
    await migration.backfillBatch(undefined, 10);
    await migration.contract();
    await migration.rollbackContract();

    expect(migration.getRow('gig-001')?.urgent).toBe(true);
    expect(migration.getRow('gig-002')?.urgent).toBe(false);
    expect(migration.getRow('gig-003')?.urgent).toBe(true);
  });
});

describe('GigsPriorityBackfillMigration (via MigrationRunnerService)', () => {
  let runner: MigrationRunnerService;
  let migration: GigsPriorityBackfillMigration;

  beforeEach(async () => {
    migration = new GigsPriorityBackfillMigration(SEED_ROWS);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MigrationRunnerService,
        MigrationRegistryService,
        MigrationStateStore,
        { provide: MIGRATION_DEFINITIONS, useValue: [migration] },
      ],
    }).compile();

    runner = module.get<MigrationRunnerService>(MigrationRunnerService);
  });

  it('rejects the real run without force, since contract() drops the urgent column', async () => {
    await expect(runner.run(migration.name, { batchSize: 1 })).rejects.toThrow(
      /destructive operation.*force: true/i,
    );
    expect(migration.getRow('gig-001')?.urgent).toBe(true);
  });

  it('allows a dry run to preview a destructive migration without force', async () => {
    const run = await runner.run(migration.name, { dryRun: true });
    expect(run.status).toBe(MigrationStatus.COMPLETED);
  });

  it('runs the gigs migration end to end without locking (batch size of 1)', async () => {
    const run = await runner.run(migration.name, { batchSize: 1, force: true });

    expect(run.status).toBe(MigrationStatus.COMPLETED);
    expect(run.targetTable).toBe('gigs');
    expect(run.progress.processedRows).toBe(3);
    expect(migration.getRow('gig-001')?.priority).toBe(5);
    expect(migration.getRow('gig-001')?.urgent).toBeUndefined();
  });

  it('rolls the gigs table back to its pre-migration shape on manual rollback', async () => {
    const run = await runner.run(migration.name, { batchSize: 10, force: true });
    await runner.rollback(run.runId);

    for (const row of migration.allRows()) {
      expect(row.priority).toBeUndefined();
      expect(row.urgent).toBeDefined();
    }
  });
});
