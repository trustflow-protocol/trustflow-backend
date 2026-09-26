import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_ROOT = __dirname;
const ALLOWED_DIRECT_ENV_READS = [
  'config/env.config.ts',
  'config/load-dotenv.ts',
  'config/load-dotenv.bootstrap.ts',
  'test/jest.setup.ts',
];

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return collectTsFiles(fullPath);
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) return [];
    return [fullPath];
  });
}

describe('environment access guardrail', () => {
  it('keeps direct process.env reads inside config/bootstrap/test setup only', () => {
    const offenders = collectTsFiles(SRC_ROOT)
      .map(file => ({
        file,
        relativePath: relative(SRC_ROOT, file).replace(/\\/g, '/'),
        source: readFileSync(file, 'utf8'),
      }))
      .filter(({ relativePath }) => !ALLOWED_DIRECT_ENV_READS.includes(relativePath))
      .filter(({ source }) => source.includes('process.env'))
      .map(({ relativePath }) => relativePath);

    expect(offenders).toEqual([]);
  });
});
