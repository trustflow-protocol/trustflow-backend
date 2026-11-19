# Monitoring

Dashboard definitions for the backend's Grafana instance, provisioned from this directory
rather than edited ad hoc in the UI.

## Why this exists (#990)

Previously there was no dashboard JSON in the repo at all, and no process stopping someone
from editing the live Grafana dashboard directly in the UI. Those edits never made it back
into Git, so anyone standing up a new environment from the repo got a dashboard that looked
nothing like the one actually in use — and there was no way to even detect that drift had
happened, short of eyeballing both side by side.

This directory fixes that two ways:

1. **The dashboard is provisioning-only.** `grafana/provisioning/dashboards/dashboards.yaml`
   sets `allowUiUpdates: false`. A dashboard edited in the Grafana UI can still be changed
   *in that browser session*, but it is never persisted — a page reload, a Grafana restart,
   or the next 30-second provisioning sync reverts it to exactly what's in
   `dashboards/trustflow-overview.json`. The committed file is the only way a change becomes
   permanent, which is what makes it the actual source of truth instead of just a snapshot
   someone has to remember to re-export.
2. **A drift check exists as a backstop.** `scripts/check-dashboard-drift.js` diffs a live
   Grafana instance against the committed JSON and exits non-zero on a mismatch. It's for
   catching the case `allowUiUpdates: false` doesn't cover — an instance provisioned before
   this change, from a stale checkout, or with provisioning accidentally disabled.

## Layout

- `dashboards/` — the dashboard(s) themselves. `trustflow-overview.json` covers HTTP traffic
  and error rate, database query errors, rate limiter rejections, webhook/outbox delivery
  outcomes, IPFS unpin failures, Redis persistence-fallback counters, and the gig expiry
  sweep — all sourced from metrics already exported at `/metrics`
  (see `backend/src/monitoring/metrics.service.ts` for the full set).
- `grafana/provisioning/` — Grafana's dashboard-provider and datasource config.
- `prometheus/prometheus.yml` — a minimal scrape config for local use.
- `docker-compose.monitoring.yml` — optional local Grafana + Prometheus stack for working on
  the dashboard. Not used in CI, and separate from the root `docker-compose.yml` (which is
  scoped to backend runtime dependencies only).
- `scripts/check-dashboard-drift.js` — the drift-check script described above.

## Changing the dashboard

Edit `dashboards/trustflow-overview.json` directly and commit it — do not rely on exporting
JSON from a UI edit, since UI edits aren't persisted. To preview a change locally:

```bash
npm --prefix backend run dev
docker compose -f monitoring/docker-compose.monitoring.yml up -d
open http://localhost:3000   # admin / admin
```

## Running the drift check

Not part of CI (it needs network access to a live Grafana instance CI doesn't have) — run it
on a schedule instead, e.g. a nightly cron job or a scheduled GitHub Actions workflow:

```bash
GRAFANA_URL=https://grafana.internal GRAFANA_API_KEY=glsa_xxx \
  node monitoring/scripts/check-dashboard-drift.js
```
