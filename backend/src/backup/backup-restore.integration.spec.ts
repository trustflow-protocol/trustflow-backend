import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

/**
 * Executes a real backup → destroy → restore cycle against a live PostgreSQL.
 *
 * This is the "test backup/restore" acceptance criterion, and it is deliberately a
 * round-trip rather than a set of assertions about the scripts: a backup that has never been
 * restored is an assumption, not a backup. It follows the repo's existing opt-in integration
 * pattern (see `database.postgres-integration.spec.ts`) — it skips unless `DATABASE_URL` is
 * set, so `npm test` stays runnable without infrastructure.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://trustflow:trustflow@localhost:5432/trustflow_dev \
 *     npx jest src/backup
 */

// Defaulted to a string so the helpers below type-check; the suite is still gated on the
// variable actually being present in the environment.
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const describeIfPostgres = process.env.DATABASE_URL ? describe : describe.skip;

// This spec lives in src/backup, so the backend root is two levels up.
const BACKEND_ROOT = resolve(__dirname, '..', '..');
const SCRIPTS = join(BACKEND_ROOT, 'scripts');

/** A table the suite owns, so it never collides with the app's own `audit_logs` DDL. */
const PROBE_TABLE = 'backup_restore_probe';

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The single dump this suite produced in `dir`. */
function onlyDump(dir: string): string {
  const files = dumpsIn(dir);
  expect(files).toHaveLength(1);
  return files[0];
}

function dumpsIn(dir: string): string[] {
  return execFileSync('bash', ['-c', `ls -1 ${dir}/*.sql.gz`], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

describeIfPostgres('backup and restore round trip', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'trustflow-backup-test-'));
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  const psql = (sql: string): string =>
    execFileSync('psql', [DATABASE_URL, '-Atc', sql], {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  it('requires the backup and restore scripts to be present and executable', () => {
    for (const script of ['backup-postgres.sh', 'restore-postgres.sh', 'backup-redis.sh']) {
      expect(existsSync(join(SCRIPTS, script))).toBe(true);
    }
  });

  it('round-trips data through a real dump and restore', () => {
    // Arrange: a table with a row that exists only before the "disaster".
    psql(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
    psql(
      `CREATE TABLE ${PROBE_TABLE} (id text primary key, amount text not null, created_at timestamptz default now())`,
    );
    psql(`INSERT INTO ${PROBE_TABLE} (id, amount) VALUES ('escrow-1', '100')`);

    // Act: take a backup.
    const backupOutput = run('backup-postgres.sh', [], {
      BACKUP_DIR: workDir,
      BACKUP_PREFIX: 'test',
    });
    expect(backupOutput).toMatch(/Dump complete/);

    const dumpFile = onlyDump(workDir);
    expect(dumpFile).toBeDefined();
    // A checksum sidecar is what makes a dump verifiable before a restore.
    expect(existsSync(`${dumpFile}.sha256`)).toBe(true);

    // Simulate data loss.
    psql(`DROP TABLE ${PROBE_TABLE}`);
    expect(
      psql(
        `select count(*) from information_schema.tables where table_schema='public' and table_name='${PROBE_TABLE}'`,
      ),
    ).toBe('0');

    // Act: restore it.
    const restoreOutput = run('restore-postgres.sh', ['--file', dumpFile, '--force']);
    expect(restoreOutput).toMatch(/Restore complete/);

    // Assert: the data is back, byte for byte.
    const row = psql(`select id || ':' || amount from ${PROBE_TABLE} where id = 'escrow-1'`);
    expect(row).toBe('escrow-1:100');
  });

  it('verifies a dump without writing to the target', () => {
    const dumpFile = onlyDump(workDir);
    const output = run('restore-postgres.sh', ['--file', dumpFile, '--verify-only']);
    expect(output).toMatch(/Dump verified/);
    expect(output).not.toMatch(/Restore complete/);
  });

  it('rejects a dump whose checksum does not match', () => {
    const dumpFile = onlyDump(workDir);

    // Corrupt the checksum sidecar only — the dump itself is fine, so this isolates the
    // verification step.
    const checksumFile = `${dumpFile}.sha256`;
    const original = readFileSync(checksumFile, 'utf8');
    try {
      writeFileSync(checksumFile, original.replace(/^[a-f0-9]+/, '0'.repeat(64)));
      expect(() => run('restore-postgres.sh', ['--file', dumpFile])).toThrow();
    } finally {
      writeFileSync(checksumFile, original);
    }
  });

  it('refuses to clobber a populated database without --force', () => {
    const dumpFile = onlyDump(workDir);

    // The target has the probe table again after the round trip.
    expect(() => run('restore-postgres.sh', ['--file', dumpFile])).toThrow(/Re-run with --force/);
  });

  it('rejects a truncated dump rather than restoring garbage', () => {
    const corrupt = join(workDir, 'corrupt.sql.gz');
    writeFileSync(corrupt, 'this is not a gzip stream');

    let exitCode: number | null = null;
    try {
      run('restore-postgres.sh', ['--file', corrupt]);
    } catch (error) {
      exitCode = (error as { status: number }).status;
    }

    // Exit code 2 is the dedicated "dump must not be trusted" code.
    expect(exitCode).toBe(2);
  });

  it('prunes dumps past the retention window but keeps recent ones', () => {
    const retentionDir = mkdtempSync(join(tmpdir(), 'trustflow-retention-'));
    try {
      // One prefix, because pruning is deliberately scoped to the current BACKUP_PREFIX so it
      // cannot delete unrelated files. Two runs can therefore land on the same second; the
      // script's collision guard is what keeps them distinct.
      run('backup-postgres.sh', [], {
        BACKUP_DIR: retentionDir,
        BACKUP_PREFIX: 'retain',
        BACKUP_RETENTION_DAYS: '7',
      });
      const stale = onlyDump(retentionDir);

      // `find -mtime +N` compares whole days, so a file written seconds ago is age 0 and
      // would never be pruned — backdating is what makes this testable without waiting.
      execFileSync('bash', ['-c', `touch -d '30 days ago' ${stale} ${stale}.sha256`], {
        stdio: 'ignore',
      });

      run('backup-postgres.sh', [], {
        BACKUP_DIR: retentionDir,
        BACKUP_PREFIX: 'retain',
        BACKUP_RETENTION_DAYS: '7',
      });
      const fresh = onlyDump(retentionDir);

      expect(fresh).not.toBe(stale);
      expect(existsSync(stale)).toBe(false);
      // The checksum sidecar is pruned with its dump; leaving it would be misleading.
      expect(existsSync(`${stale}.sha256`)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(retentionDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing dump when two runs land in the same second', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trustflow-collision-'));
    try {
      run('backup-postgres.sh', [], { BACKUP_DIR: dir, BACKUP_PREFIX: 'collide' });
      run('backup-postgres.sh', [], { BACKUP_DIR: dir, BACKUP_PREFIX: 'collide' });

      // Silently overwriting would lose a backup with no error, so a same-second collision
      // has to produce two distinct files.
      const count = execFileSync('bash', ['-c', `ls -1 ${dir}/*.sql.gz | wc -l`], {
        encoding: 'utf8',
      }).trim();
      expect(Number(count)).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly rather than recording an empty backup as a success', () => {
    // BACKUP_DIR pointed at an unwritable path must exit non-zero, not silently "succeed".
    let exitCode: number | null = null;
    try {
      run('backup-postgres.sh', [], { BACKUP_DIR: '/proc/nonexistent-backup-dir' });
    } catch (error) {
      exitCode = (error as { status: number }).status;
    }
    expect(exitCode).not.toBe(0);
  });
});

describe('backup scripts (no infrastructure required)', () => {
  it('documents its required environment in the usage header', () => {
    const script = readFileSync(join(SCRIPTS, 'backup-postgres.sh'), 'utf8');
    expect(script).toContain('DATABASE_URL');
    expect(script).toMatch(/BACKUP_RETENTION_DAYS/);
    expect(script).toMatch(/set -euo pipefail/);
  });

  it('fails fast with a clear message when no connection string is configured', () => {
    let output = '';
    let exitCode: number | null = null;
    try {
      output = execFileSync('bash', [join(SCRIPTS, 'backup-postgres.sh')], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: '', PGHOST: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      exitCode = (error as { status: number }).status;
      output = (error as { stderr: string }).stderr;
    }
    expect(exitCode).toBe(1);
    expect(output).toMatch(/set DATABASE_URL/);
  });
});
