# Dependency Audit Policy

Closes #476. This document is the CI dependency-vulnerability gate's policy and the
checked-in allow-list of advisories currently accepted, each with a reason and an expiry
date. Update this file in the same PR whenever the allow-list changes.

## CI gate

`.github/workflows/backend-ci.yml` runs two separate `npm audit` steps:

1. **`Dependency vulnerability scan (production)`** — `npm audit --omit=dev --audit-level=high`.
   **Blocks the PR.** Only advisories reachable from a package that actually ships in
   `dist/` (i.e. not a dev-only lint/build/test tool) can fail this step.
2. **`Dependency vulnerability scan (dev, non-blocking)`** — `npm audit --audit-level=high`
   (includes dev dependencies), with the step's failure downgraded to a `::warning::`
   annotation rather than a failing step. A new advisory in, say, ESLint's own dependency
   tree is visible on every PR without blocking merges over code that never ships.

Both steps run after lint/type-check/tests/build, so a new advisory never masks those
results — each step already reports its own pass/fail independently in the job's step list,
and the production step failing is the only one that blocks merge.

## Triage process for a new advisory

When `npm audit` reports a new finding:

1. Run `npm audit --omit=dev --json` (or without `--omit=dev` for a dev-only finding) and
   identify the vulnerable package, the advisory, and whether it's reachable from
   attacker-controlled input in this codebase (not just present in the tree).
2. Check `fixAvailable` in the JSON output:
   - A concrete version with `isSemVerMajor: false` (or a bare `true`) usually means
     `npm audit fix` (no `--force`) can resolve it within already-declared ranges — try that
     first.
   - Otherwise, check whether pinning the *transitive* vulnerable package directly via the
     root `overrides` field (see below) is safe: only when every consumer of that package in
     the tree is compatible with the overridden version. `npm ls <package>` shows every
     consumer and its own declared range.
   - If neither is safe, the fix requires a major bump of a direct dependency. Land that in
     its own PR, with a green test run, rather than bundling it here.
3. If a finding can't be fixed immediately, add it to the allow-list below with a reason and
   an expiry date (a reminder to re-triage, not a permanent exemption).

## Applied overrides

`package.json`'s `overrides` field currently pins:

- **`axios` → `^1.20.0`** — transitive via `@stellar/stellar-sdk@12.3.0` (which declares
  `axios: ^1.7.7`, so this is within its own accepted range). Fixes the axios prototype
  pollution / DoS advisories bundled under GHSA-xj6q-8x83-jv6g, GHSA-mmx7-hfxf-jppx,
  GHSA-pmv8-rq9r-6j72, GHSA-mwf2-3pr3-8698 and related HTTP-adapter advisories — all fixed in
  axios >=1.18.0.
- **`uuid` → `^11.1.1`** — transitive via `@nestjs/schedule@4.1.2`, which pins an exact
  vulnerable `uuid@11.0.3` (GHSA-w5hq-g745-h8pq, a missing buffer bounds check). `@nestjs/schedule`
  only uses `uuid` internally for job identifiers, not on any request path, so overriding it
  is low-risk and doesn't require waiting on a schedule upgrade.

## Accepted advisories (production dependency tree)

These remain unresolved in `npm audit --omit=dev` as of this writing. Each requires a
semver-major bump of a direct dependency and is deliberately **not** bundled into this PR —
see the Estimated Time / Tasks note on #476 ("plan and land the major upgrades in separate
PRs, each with a green test run"). Re-triage by the expiry date below.

| Package | Advisory | Root cause | Why deferred | Expiry |
| --- | --- | --- | --- | --- |
| `@nestjs/platform-express`, `multer` | Multiple DoS advisories (GHSA-xf7r-hgr6-v32p and related) | `@nestjs/platform-express@10.x` pins a vulnerable `multer`. Fix needs `@nestjs/platform-express@12.x` (major; also bumps the whole `@nestjs/*` line off v10). | `FileInterceptor` (avatar upload in `user-profile.controller.ts`) is the only consumer; needs its own PR with a full regression pass across every `@nestjs/*` v10 → v12 API change. | 2026-12-31 |
| `@stellar/stellar-sdk`, `toml` | Uncontrolled recursion / prototype pollution in `toml` (GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j) | `@stellar/stellar-sdk@12.x` pins a vulnerable `toml`. Fix needs `@stellar/stellar-sdk@17.x` (major). | Already tracked in #453: a trial upgrade changes typings this codebase depends on (`LedgerEntryData.contractData`, `GetEventsRequest.cursor`, `ScVal.switch`) on top of pre-existing type errors on 12.3.0. Needs its own coordinated PR with the event-ingestion/reconciliation code. | 2026-12-31 |
| `js-yaml`, `lodash` | Prototype pollution / ReDoS in `js-yaml`/`lodash` | Both are transitive via `@nestjs/swagger@7.x`. Fix needs `@nestjs/swagger@12.x` (major). | Neither `js-yaml` nor `lodash` is reachable from request data here — both are only used internally by Swagger's own document generation at startup, not per-request — but the fix still requires the major bump, tracked for its own PR alongside the other `@nestjs/*` upgrades above. | 2026-12-31 |

## Accepted advisories (dev-only dependency tree)

Reported by the non-blocking CI step; never shipped, so these don't gate merges. Several
show `fixAvailable: true` in `npm audit --json`, but a straight override is unsafe here: the
same package (`minimatch`, `brace-expansion`) is resolved at multiple incompatible major
versions across different dev-tool subtrees (e.g. `ts-node-dev`'s legacy `rimraf`/`glob@7`
chain expects the `minimatch@3`/`brace-expansion@1` API, while `@typescript-eslint/typescript-estree`
and `madge` pull in `minimatch@9`/`10` and `brace-expansion@2`/`5`) — forcing one version
tree-wide risks silently breaking whichever tool expects the older API, for a build-tool-only
finding with no production exposure.

| Package | Root cause | Why deferred | Expiry |
| --- | --- | --- | --- |
| `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `-/type-utils`, `-/typescript-estree`, `-/utils` | Pinned to `^6.0.0`; the fix needs `>=7.5.1`, a major bump requiring an ESLint config migration. | Lint-only; needs its own PR + a full lint pass against the new rule set. | 2026-12-31 |
| `minimatch`, `brace-expansion` | Multiple resolved major versions across dev-tool subtrees (see above). | A blanket override risks breaking `ts-node-dev`'s legacy `glob`/`rimraf` chain for a dev-tooling-only finding. | 2026-12-31 |
| `browserslist`, `baseline-browser-mapping` | Transitive via `ts-jest` → `@babel/core`'s `browserslist` data lookup. | Build-tool-only, not reachable from any request; will be re-checked when `ts-jest`/Babel are next bumped. | 2026-12-31 |
| `@nestjs/testing` | Transitive `@nestjs/testing@10.x` moderate advisory; fix needs `@nestjs/testing@12.x`. | Test-only; bump alongside the rest of the `@nestjs/*` v10 → v12 line above. | 2026-12-31 |

## Acceptance criteria checklist (from #476)

- [x] `npm audit --omit=dev --audit-level=high` exits 0 on this branch
- [x] Every remaining accepted advisory is listed above with a justification and an expiry
      date
- [x] Build and the full test suite pass; TypeScript type-checks cleanly (verified locally —
      see PR description; pre-existing lint errors and unrelated broken test suites on `main`
      are untouched by this PR)
- [x] The CI policy is documented here and applied by `backend-ci.yml`
