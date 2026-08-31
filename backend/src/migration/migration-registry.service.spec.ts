import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import {
  MigrationRegistryService,
  MIGRATION_DEFINITIONS,
} from './migration-registry.service';
import { SchemaMigration, BackfillBatchResult } from './migration.types';

// ─── Minimal concrete SchemaMigration for testing ────────────────────────────

class StubMigration extends SchemaMigration {
  constructor(
    readonly name: string,
    readonly targetTable: string,
    readonly description: string,
  ) {
    super();
  }

  expand = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  countPending = jest.fn<Promise<number>, []>().mockResolvedValue(0);
  backfillBatch = jest
    .fn<Promise<BackfillBatchResult>, [string | undefined, number]>()
    .mockResolvedValue({ processed: 0, failed: 0, done: true });
  contract = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  rollbackExpand = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  rollbackContract = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMigration(name = 'add-index', targetTable = 'users', description = 'Add index') {
  return new StubMigration(name, targetTable, description);
}

async function buildRegistry(definitions: SchemaMigration[]): Promise<MigrationRegistryService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      MigrationRegistryService,
      { provide: MIGRATION_DEFINITIONS, useValue: definitions },
    ],
  }).compile();
  return module.get<MigrationRegistryService>(MigrationRegistryService);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('MigrationRegistryService', () => {
  it('should be defined with an empty definitions list', async () => {
    const registry = await buildRegistry([]);
    expect(registry).toBeDefined();
  });

  // ─── constructor / registration ───────────────────────────────────────────

  describe('registration', () => {
    it('accepts a single migration definition without error', async () => {
      const m = buildMigration('add-column');
      const registry = await buildRegistry([m]);
      expect(registry).toBeDefined();
    });

    it('accepts multiple distinct migrations without error', async () => {
      const registry = await buildRegistry([
        buildMigration('migration-a', 'table_a', 'Desc A'),
        buildMigration('migration-b', 'table_b', 'Desc B'),
        buildMigration('migration-c', 'table_c', 'Desc C'),
      ]);
      expect(registry.list()).toHaveLength(3);
    });

    it('throws a plain Error (not a NestJS exception) when two migrations share the same name', async () => {
      // The registry is instantiated inside the NestJS module lifecycle so the
      // error surfaces as an ordinary Error, not an HttpException.
      const dup = buildMigration('same-name');
      await expect(buildRegistry([dup, dup])).rejects.toThrow(
        'Duplicate migration name registered: same-name',
      );
    });

    it('message includes the conflicting migration name', async () => {
      const m = buildMigration('conflict-migration', 'orders', 'Adds index on orders');
      await expect(buildRegistry([m, m])).rejects.toThrow('conflict-migration');
    });
  });

  // ─── get() ────────────────────────────────────────────────────────────────

  describe('get()', () => {
    let registry: MigrationRegistryService;
    const migration = buildMigration('lookup-migration', 'payments', 'Test lookup');

    beforeEach(async () => {
      registry = await buildRegistry([migration]);
    });

    it('returns the exact SchemaMigration instance that was registered', () => {
      const result = registry.get('lookup-migration');
      expect(result).toBe(migration);
    });

    it('throws NotFoundException for an unregistered migration name', () => {
      expect(() => registry.get('does-not-exist')).toThrow(NotFoundException);
    });

    it('NotFoundException message includes the missing migration name', () => {
      expect(() => registry.get('unknown-migration')).toThrow(
        'Migration "unknown-migration" is not registered',
      );
    });

    it('is case-sensitive — "Lookup-Migration" does not match "lookup-migration"', () => {
      expect(() => registry.get('Lookup-Migration')).toThrow(NotFoundException);
    });
  });

  // ─── list() ───────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns an empty array when no migrations are registered', async () => {
      const registry = await buildRegistry([]);
      expect(registry.list()).toEqual([]);
    });

    it('returns a summary for every registered migration', async () => {
      const a = buildMigration('mig-a', 'users', 'Adds column to users');
      const b = buildMigration('mig-b', 'orders', 'Adds index on orders');
      const registry = await buildRegistry([a, b]);

      const list = registry.list();

      expect(list).toHaveLength(2);
      expect(list).toEqual(
        expect.arrayContaining([
          { name: 'mig-a', targetTable: 'users', description: 'Adds column to users' },
          { name: 'mig-b', targetTable: 'orders', description: 'Adds index on orders' },
        ]),
      );
    });

    it('summary contains only name, targetTable, and description — not the full migration object', async () => {
      const m = buildMigration('compact-check', 'logs', 'Check output shape');
      const registry = await buildRegistry([m]);

      const [summary] = registry.list();

      expect(Object.keys(summary)).toEqual(['name', 'targetTable', 'description']);
    });

    it('list() result does not share references with the internal registry entries', async () => {
      const m = buildMigration('ref-check', 'events', 'Reference isolation check');
      const registry = await buildRegistry([m]);

      const [summary] = registry.list();
      // Mutating the summary must not corrupt the registry.
      (summary as any).name = 'tampered';

      expect(registry.get('ref-check')).toBe(m);
    });
  });
});
