import { Test, TestingModule } from '@nestjs/testing';
import { MigrationStateStore } from './migration-state.store';
import { MigrationPhase, MigrationRun, MigrationStatus } from './migration.types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let idCounter = 0;

function makeRun(overrides: Partial<MigrationRun> = {}): MigrationRun {
  const id = `mig-run-${String(++idCounter).padStart(4, '0')}`;
  return {
    runId: id,
    migrationName: 'test-migration',
    targetTable: 'test_table',
    status: MigrationStatus.PENDING,
    progress: {
      totalRows: 0,
      processedRows: 0,
      failedRows: 0,
      batchSize: 100,
    },
    stepHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────
// Runs against the process-local fallback store (no REDIS_CLIENT provided), which preserves
// object-reference semantics — see escrow.service.spec.ts / gig.service.spec.ts for the
// dual-mode ("with Redis" / fallback) pattern used for the Redis path itself.

describe('MigrationStateStore', () => {
  let store: MigrationStateStore;

  beforeEach(async () => {
    idCounter = 0;
    const module: TestingModule = await Test.createTestingModule({
      providers: [MigrationStateStore],
    }).compile();
    store = module.get<MigrationStateStore>(MigrationStateStore);
  });

  it('should be defined', () => {
    expect(store).toBeDefined();
  });

  // ─── create() ─────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('stores a run so it can be retrieved by findById()', async () => {
      const run = makeRun();
      await store.create(run);

      expect(await store.findById(run.runId)).toBe(run);
    });

    it('does not mutate updatedAt when called (unlike save)', async () => {
      const run = makeRun();
      const originalUpdatedAt = run.updatedAt;
      await store.create(run);

      expect(run.updatedAt).toBe(originalUpdatedAt);
    });

    it('stores multiple distinct runs independently', async () => {
      const a = makeRun({ migrationName: 'mig-a' });
      const b = makeRun({ migrationName: 'mig-b' });
      await store.create(a);
      await store.create(b);

      expect(await store.findById(a.runId)).toBe(a);
      expect(await store.findById(b.runId)).toBe(b);
    });
  });

  // ─── save() ───────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('updates the run and stamps a new updatedAt', async () => {
      const run = makeRun({ status: MigrationStatus.PENDING });
      await store.create(run);

      // Advance the clock slightly so the timestamp is guaranteed to differ.
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2030-01-01T12:00:00.000Z'));

      run.status = MigrationStatus.BACKFILLING;
      await store.save(run);

      expect((await store.findById(run.runId))?.status).toBe(MigrationStatus.BACKFILLING);
      expect((await store.findById(run.runId))?.updatedAt).toBe('2030-01-01T12:00:00.000Z');

      jest.useRealTimers();
    });

    it('mutates the run object in-place with the new updatedAt', async () => {
      const run = makeRun();
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2031-06-15T08:30:00.000Z'));

      await store.save(run);

      expect(run.updatedAt).toBe('2031-06-15T08:30:00.000Z');

      jest.useRealTimers();
    });

    it('overwrites the previously stored version of a run', async () => {
      const run = makeRun({ status: MigrationStatus.EXPANDING });
      await store.create(run);

      run.status = MigrationStatus.COMPLETED;
      await store.save(run);

      expect((await store.findById(run.runId))?.status).toBe(MigrationStatus.COMPLETED);
    });
  });

  // ─── findById() ───────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('returns undefined for an unknown runId (does not throw)', async () => {
      expect(await store.findById('mig-unknown')).toBeUndefined();
    });

    it('returns the run after it has been created', async () => {
      const run = makeRun();
      await store.create(run);

      expect(await store.findById(run.runId)).toEqual(run);
    });

    it('reflects mutations made through save()', async () => {
      const run = makeRun({ status: MigrationStatus.EXPANDING });
      await store.create(run);

      run.status = MigrationStatus.COMPLETED;
      await store.save(run);

      expect((await store.findById(run.runId))?.status).toBe(MigrationStatus.COMPLETED);
    });
  });

  // ─── findAll() ────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('returns an empty array when the store is empty', async () => {
      expect(await store.findAll()).toEqual([]);
    });

    it('returns all stored runs', async () => {
      const a = makeRun();
      const b = makeRun();
      await store.create(a);
      await store.create(b);

      expect(await store.findAll()).toHaveLength(2);
    });

    it('returns runs sorted descending by createdAt (newest first)', async () => {
      const older = makeRun({ createdAt: '2025-01-01T00:00:00.000Z' });
      const newer = makeRun({ createdAt: '2025-06-01T00:00:00.000Z' });
      const newest = makeRun({ createdAt: '2025-12-01T00:00:00.000Z' });

      // Insert in non-chronological order to verify the sort, not insertion order.
      await store.create(newer);
      await store.create(older);
      await store.create(newest);

      const result = await store.findAll();
      expect(result[0].createdAt).toBe('2025-12-01T00:00:00.000Z');
      expect(result[1].createdAt).toBe('2025-06-01T00:00:00.000Z');
      expect(result[2].createdAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('does not mutate the stored collection (returns a snapshot array)', async () => {
      const run = makeRun();
      await store.create(run);

      const snapshot = await store.findAll();
      snapshot.push(makeRun()); // mutate the returned array

      expect(await store.findAll()).toHaveLength(1); // store is unchanged
    });
  });

  // ─── markActive() / findActiveByName() / clearActive() ───────────────────

  describe('active-run tracking', () => {
    it('findActiveByName() returns undefined when no run is active for a migration', async () => {
      expect(await store.findActiveByName('some-migration')).toBeUndefined();
    });

    it('markActive() makes the run findable via findActiveByName()', async () => {
      const run = makeRun({ migrationName: 'tracked-migration' });
      await store.create(run);
      await store.markActive('tracked-migration', run.runId);

      expect(await store.findActiveByName('tracked-migration')).toEqual(run);
    });

    it('clearActive() removes the active-run entry so findActiveByName() returns undefined', async () => {
      const run = makeRun({ migrationName: 'clearable-migration' });
      await store.create(run);
      await store.markActive('clearable-migration', run.runId);
      await store.clearActive('clearable-migration');

      expect(await store.findActiveByName('clearable-migration')).toBeUndefined();
    });

    it('markActive() overwrites a previous active run for the same migration name', async () => {
      const first = makeRun({ migrationName: 'rerun-migration' });
      const second = makeRun({ migrationName: 'rerun-migration' });
      await store.create(first);
      await store.create(second);

      await store.markActive('rerun-migration', first.runId);
      await store.markActive('rerun-migration', second.runId);

      expect(await store.findActiveByName('rerun-migration')).toEqual(second);
    });

    it('clearActive() on a name that was never marked does not throw', async () => {
      await expect(store.clearActive('nonexistent-migration')).resolves.not.toThrow();
    });

    it('active-run tracking is per migration name — clearing one does not affect another', async () => {
      const runA = makeRun({ migrationName: 'mig-a' });
      const runB = makeRun({ migrationName: 'mig-b' });
      await store.create(runA);
      await store.create(runB);
      await store.markActive('mig-a', runA.runId);
      await store.markActive('mig-b', runB.runId);

      await store.clearActive('mig-a');

      expect(await store.findActiveByName('mig-a')).toBeUndefined();
      expect(await store.findActiveByName('mig-b')).toEqual(runB);
    });
  });

  // ─── state transitions (integration-style) ───────────────────────────────

  describe('state transitions', () => {
    it('tracks a run through the full PENDING → COMPLETED lifecycle', async () => {
      const run = makeRun({ status: MigrationStatus.PENDING });
      await store.create(run);

      run.status = MigrationStatus.EXPANDING;
      run.currentPhase = MigrationPhase.EXPAND;
      await store.save(run);
      expect((await store.findById(run.runId))?.status).toBe(MigrationStatus.EXPANDING);

      run.status = MigrationStatus.BACKFILLING;
      run.currentPhase = MigrationPhase.BACKFILL;
      await store.save(run);
      expect((await store.findById(run.runId))?.status).toBe(MigrationStatus.BACKFILLING);

      run.status = MigrationStatus.CONTRACTING;
      run.currentPhase = MigrationPhase.CONTRACT;
      await store.save(run);
      expect((await store.findById(run.runId))?.status).toBe(MigrationStatus.CONTRACTING);

      run.status = MigrationStatus.COMPLETED;
      run.currentPhase = undefined;
      await store.save(run);
      expect((await store.findById(run.runId))?.status).toBe(MigrationStatus.COMPLETED);
    });

    it('tracks a run through the FAILED / ROLLED_BACK states', async () => {
      const run = makeRun({ status: MigrationStatus.BACKFILLING });
      await store.create(run);

      run.status = MigrationStatus.ROLLING_BACK;
      await store.save(run);

      run.status = MigrationStatus.ROLLED_BACK;
      run.rollbackReason = 'backfill error';
      await store.save(run);

      const stored = await store.findById(run.runId);
      expect(stored?.status).toBe(MigrationStatus.ROLLED_BACK);
      expect(stored?.rollbackReason).toBe('backfill error');
    });
  });
});
