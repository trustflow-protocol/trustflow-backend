import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * #222 — every `process.env.X` referenced under `backend/src` must be
 * documented in the repo-root `.env.example`, so a new contributor can
 * discover every knob without grepping the source.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = __dirname;
const ENV_EXAMPLE = join(REPO_ROOT, '.env.example');

/** Runtime facts, not configuration — set by the runner, not copied from `.env.example`. */
const RUNTIME_ONLY = new Set(['NODE_ENV']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

function referencedEnvVars(): Set<string> {
  const vars = new Set<string>();
  for (const file of walk(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      vars.add(match[1]);
    }
  }
  return vars;
}

function documentedEnvVars(): Set<string> {
  const text = readFileSync(ENV_EXAMPLE, 'utf8');
  const vars = new Set<string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*#?\s*([A-Z_][A-Z0-9_]*)=/);
    if (match) vars.add(match[1]);
  }
  return vars;
}

describe('.env.example coverage (#222)', () => {
  const referenced = referencedEnvVars();
  const documented = documentedEnvVars();

  it('references at least the known set of env vars (sanity check that the grep works)', () => {
    expect(referenced.has('REDIS_URL')).toBe(true);
    expect(referenced.has('JWT_SECRET')).toBe(true);
  });

  it('documents the vars this issue called out', () => {
    for (const v of [
      'CORS_ORIGIN',
      'API_URL',
      'SENTRY_DSN',
      'RATE_LIMIT_ABUSE_WINDOW_SECONDS',
      'RATE_LIMIT_ABUSE_THRESHOLD',
      'RATE_LIMIT_LOCKOUT_SECONDS',
    ]) {
      expect(documented.has(v)).toBe(true);
    }
  });

  it('documents every process.env var referenced in backend/src', () => {
    const missing = [...referenced].filter(v => !documented.has(v) && !RUNTIME_ONLY.has(v)).sort();
    expect(missing).toEqual([]);
  });
});
