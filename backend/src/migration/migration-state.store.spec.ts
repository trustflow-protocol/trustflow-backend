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
    it('stores a run so it can be retrieved by findById()', () => {
      const run = makeRun();
      store.create(run);

      expect(store.findById(run.runId)).toBe(run);
    });

    it('does not mutate updatedAt when called (unlike save)', () => {
      const run = makeRun();
      const originalUpdatedAt = run.updatedAt;
      store.create(run);

      expect(run.updatedAt).toBe(originalUpdatedAt);
    });

    it('stores multiple distinct runs independently', () => {
      const a = makeRun({ migrationName: 'mig-a' });
      const b = makeRun({ migrationName: 'mig-b' });
      store.create(a);
      store.create(b);

      expect(store.findById(a.runId)).toBe(a);
      expect(store.findById(b.runId)).toBe(b);
    });
  });

  // ─── save() ───────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('updates the run and stamps a new updatedAt', () => {
      const run = makeRun({ status: MigrationStatus.PENDING });
      store.create(run);

      // Advance the clock slightly so the timestamp is guaranteed to differ.
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2030-01-01T12:00:00.000Z'));

      run.status = MigrationStatus.BACKFILLING;
      store.save(run);

      expect(store.findById(run.runId)?.status).toBe(MigrationStatus.BACKFILLING);
      expect(store.findById(run.runId)?.updatedAt).toBe('2030-01-01T12:00:00.000Z');

      jest.useRealTimers();
    });

    it('mutates the run object in-place with the new updatedAt', () => {
      const run = makeRun();
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2031-06-15T08:30:00.000Z'));

      store.save(run);

      expect(run.updatedAt).toBe('2031-06-15T08:30:00.000Z');

      jest.useRealTimers();
    });

    it('overwrites the previously stored version of a run', () => {
      const run = makeRun({ status: MigrationStatus.EXPANDING });
      store.create(run);

      run.status = MigrationStatus.COMPLETED;
      store.save(run);

      expect(store.findById(run.runId)?.status).toBe(MigrationStatus.COMPLETED);
    });
  });

  // ─── findById() ───────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('returns undefined for an unknown runId (does not throw)', () => {
      expect(store.findById('mig-unknown')).toBeUndefined();
    });

    it('returns the run after it has been created', () => {
      const run = makeRun();
      store.create(run);

      expect(store.findById(run.runId)).toEqual(run);
    });

    it('reflects mutations made through save()', () => {
      const run = makeRun({ status: MigrationStatus.EXPANDING });
      store.create(run);

      run.status = MigrationStatus.COMPLETED;
      store.save(run);

      expect(store.findById(run.runId)?.status).toBe(MigrationStatus.COMPLETED);
    });
  });

  // ─── findAll() ────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('returns an empty array when the store is empty', () => {
      expect(store.findAll()).toEqual([]);
    });

    it('returns all stored runs', () => {
      const a = makeRun();
      const b = makeRun();
      store.create(a);
      store.create(b);

      expect(store.findAll()).toHaveLength(2);
    });

    it('returns runs sorted descending by createdAt (newest first)', () => {
      const older = makeRun({ createdAt: '2025-01-01T00:00:00.000Z' });
      const newer = makeRun({ createdAt: '2025-06-01T00:00:00.000Z' });
      const newest = makeRun({ createdAt: '2025-12-01T00:00:00.000Z' });

      // Insert in non-chronological order to verify the sort, not insertion order.
      store.create(newer);
      store.create(older);
      store.create(newest);

      const result = store.findAll();
      expect(result[0].createdAt).toBe('2025-12-01T00:00:00.000Z');
      expect(result[1].createdAt).toBe('2025-06-01T00:00:00.000Z');
      expect(result[2].createdAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('does not mutate the stored collection (returns a snapshot array)', () => {
      const run = makeRun();
      store.create(run);

      const snapshot = store.findAll();
      snapshot.push(makeRun()); // mutate the returned array

      expect(store.findAll()).toHaveLength(1); // store is unchanged
    });
  });

  // ─── markActive() / findActiveByName() / clearActive() ───────────────────

  describe('active-run tracking', () => {
    it('findActiveByName() returns undefined when no run is active for a migration', () => {
      expect(store.findActiveByName('some-migration')).toBeUndefined();
    });

    it('markActive() makes the run findable via findActiveByName()', () => {
      const run = makeRun({ migrationName: 'tracked-migration' });
      store.create(run);
      store.markActive('tracked-migration', run.runId);

      expect(store.findActiveByName('tracked-migration')).toBe(run);
    });

    it('clearActive() removes the active-run entry so findActiveByName() returns undefined', () => {
      const run = makeRun({ migrationName: 'clearable-migration' });
      store.create(run);
      store.markActive('clearable-migration', run.runId);
      store.clearActive('clearable-migration');

      expect(store.findActiveByName('clearable-migration')).toBeUndefined();
    });

    it('markActive() overwrites a previous active run for the same migration name', () => {
      const first = makeRun({ migrationName: 'rerun-migration' });
      const second = makeRun({ migrationName: 'rerun-migration' });
      store.create(first);
      store.create(second);

      store.markActive('rerun-migration', first.runId);
      store.markActive('rerun-migration', second.runId);

      expect(store.findActiveByName('rerun-migration')).toBe(second);
    });

    it('clearActive() on a name that was never marked does not throw', () => {
      expect(() => store.clearActive('nonexistent-migration')).not.toThrow();
    });

    it('active-run tracking is per migration name — clearing one does not affect another', () => {
      const runA = makeRun({ migrationName: 'mig-a' });
      const runB = makeRun({ migrationName: 'mig-b' });
      store.create(runA);
      store.create(runB);
      store.markActive('mig-a', runA.runId);
      store.markActive('mig-b', runB.runId);

      store.clearActive('mig-a');

      expect(store.findActiveByName('mig-a')).toBeUndefined();
      expect(store.findActiveByName('mig-b')).toBe(runB);
    });
  });

  // ─── state transitions (integration-style) ───────────────────────────────

  describe('state transitions', () => {
    it('tracks a run through the full PENDING → COMPLETED lifecycle', () => {
      const run = makeRun({ status: MigrationStatus.PENDING });
      store.create(run);

      run.status = MigrationStatus.EXPANDING;
      run.currentPhase = MigrationPhase.EXPAND;
      store.save(run);
      expect(store.findById(run.runId)?.status).toBe(MigrationStatus.EXPANDING);

      run.status = MigrationStatus.BACKFILLING;
      run.currentPhase = MigrationPhase.BACKFILL;
      store.save(run);
      expect(store.findById(run.runId)?.status).toBe(MigrationStatus.BACKFILLING);

      run.status = MigrationStatus.CONTRACTING;
      run.currentPhase = MigrationPhase.CONTRACT;
      store.save(run);
      expect(store.findById(run.runId)?.status).toBe(MigrationStatus.CONTRACTING);

      run.status = MigrationStatus.COMPLETED;
      run.currentPhase = undefined;
      store.save(run);
      expect(store.findById(run.runId)?.status).toBe(MigrationStatus.COMPLETED);
    });

    it('tracks a run through the FAILED / ROLLED_BACK states', () => {
      const run = makeRun({ status: MigrationStatus.BACKFILLING });
      store.create(run);

      run.status = MigrationStatus.ROLLING_BACK;
      store.save(run);

      run.status = MigrationStatus.ROLLED_BACK;
      run.rollbackReason = 'backfill error';
      store.save(run);

      const stored = store.findById(run.runId);
      expect(stored?.status).toBe(MigrationStatus.ROLLED_BACK);
      expect(stored?.rollbackReason).toBe('backfill error');
    });
  });
});
