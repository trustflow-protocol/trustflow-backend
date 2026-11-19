import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * #990 — guards the two things that actually prevent dashboard drift from recurring:
 * the dashboard is provisioning-only (`allowUiUpdates: false`), and every panel query in
 * the committed JSON references a metric this backend still actually emits, so a rename
 * or removal elsewhere in the codebase is caught here instead of silently going stale in
 * a dashboard nobody is watching closely enough to notice.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const DASHBOARDS_DIR = join(REPO_ROOT, 'monitoring', 'dashboards');
const PROVISIONING_FILE = join(
  REPO_ROOT,
  'monitoring',
  'grafana',
  'provisioning',
  'dashboards',
  'dashboards.yaml',
);
const SRC_DIR = __dirname.replace(/monitoring$/, '');

function dashboardFiles(): string[] {
  return readdirSync(DASHBOARDS_DIR).filter(f => f.endsWith('.json'));
}

/** Every metric name this backend registers via MetricsService, collected from source. */
function emittedMetricNames(): Set<string> {
  const names = new Set<string>();
  // Covers both call-site literals (`metrics.increment('foo_total', ...)`) and metric names
  // exported as a named constant elsewhere and passed by reference (`metrics.increment(FOO_METRIC, ...)`).
  const metricCallPattern = /metrics\??\.(?:increment|observeHistogram(?:Ms)?|setGauge|registerHistogram|registerGauge)\(\s*'([a-zA-Z0-9_]+)'/g;
  const metricConstPattern = /_METRIC\s*=\s*'([a-zA-Z0-9_]+)'/g;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        const source = readFileSync(full, 'utf8');
        for (const match of source.matchAll(metricCallPattern)) names.add(match[1]);
        for (const match of source.matchAll(metricConstPattern)) names.add(match[1]);
      }
    }
  }

  walk(SRC_DIR);
  return names;
}

/**
 * Metric names referenced in a PromQL expression. Every query in this dashboard wraps its
 * metric as `rate(metric_name[...])` or `rate(metric_name{...}[...])`, so matching what
 * `rate(` is applied to — rather than writing a general PromQL parser — is enough to pull
 * out the real metric names without also matching label names from a `by (...)` clause.
 */
function metricNamesInExpr(expr: string): string[] {
  const matches = expr.matchAll(/\brate\(\s*([a-zA-Z_][a-zA-Z0-9_]*)/g);
  return [...matches].map(m => m[1]);
}

describe('monitoring dashboard (#990)', () => {
  it('ships at least one provisioned dashboard', () => {
    expect(dashboardFiles().length).toBeGreaterThan(0);
  });

  it('is provisioning-only — UI edits must not be persisted', () => {
    const yaml = readFileSync(PROVISIONING_FILE, 'utf8');
    expect(yaml).toMatch(/allowUiUpdates:\s*false/);
  });

  for (const file of dashboardFiles()) {
    describe(file, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let dashboard: any;

      beforeAll(() => {
        dashboard = JSON.parse(readFileSync(join(DASHBOARDS_DIR, file), 'utf8'));
      });

      it('has a stable uid and at least one panel', () => {
        expect(typeof dashboard.uid).toBe('string');
        expect(dashboard.uid.length).toBeGreaterThan(0);
        expect(Array.isArray(dashboard.panels)).toBe(true);
        expect(dashboard.panels.length).toBeGreaterThan(0);
      });

      it('every panel query references a metric this backend actually emits', () => {
        const emitted = emittedMetricNames();
        const unknown: string[] = [];

        for (const panel of dashboard.panels) {
          for (const target of panel.targets ?? []) {
            if (typeof target.expr !== 'string') continue;
            for (const name of metricNamesInExpr(target.expr)) {
              if (!emitted.has(name)) unknown.push(`${panel.title}: ${name}`);
            }
          }
        }

        expect(unknown).toEqual([]);
      });

      it('every panel query targets the provisioned Prometheus datasource', () => {
        for (const panel of dashboard.panels) {
          for (const target of panel.targets ?? []) {
            expect(target.datasource).toMatchObject({ type: 'prometheus', uid: 'prometheus' });
          }
        }
      });
    });
  }
});
