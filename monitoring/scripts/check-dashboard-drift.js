#!/usr/bin/env node
/**
 * Fails (non-zero exit) when the dashboard committed to monitoring/dashboards/ has drifted
 * from what's actually live in Grafana — the problem #990 describes: dashboard edits made
 * directly in the Grafana UI never made it back into the repo, so a new environment built
 * from the committed JSON silently looked different from what was actually in use.
 *
 * With dashboards.yaml's `allowUiUpdates: false`, a live instance provisioned from this repo
 * can no longer drift on its own — but this script still exists as a second, independent
 * check: for a Grafana instance pre-dating that provisioning config, for confirming
 * provisioning actually took effect, and for CI/cron to alert if either assumption is ever
 * violated (e.g. someone provisions with a stale checkout).
 *
 * Usage:
 *   GRAFANA_URL=https://grafana.internal GRAFANA_API_KEY=glsa_xxx \
 *     node monitoring/scripts/check-dashboard-drift.js
 *
 * Intended to run on a schedule (cron/CI), not on every commit — it talks to a live
 * Grafana instance, which a normal CI run has no access to.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DASHBOARDS_DIR = path.join(__dirname, '..', 'dashboards');

/** Fields that legitimately differ between the committed file and the live copy. */
const VOLATILE_KEYS = new Set(['id', 'version']);

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stripVolatile(val);
    }
    return out;
  }
  return value;
}

function request(url, apiKey) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;
    const req = client.request(
      target,
      { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`${url} -> HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`${url} did not return valid JSON: ${err.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function checkOne(file, grafanaUrl, apiKey) {
  const uid = JSON.parse(fs.readFileSync(path.join(DASHBOARDS_DIR, file), 'utf8')).uid;
  if (!uid) throw new Error(`${file} has no "uid" — cannot look it up in Grafana`);

  const committed = stripVolatile(JSON.parse(fs.readFileSync(path.join(DASHBOARDS_DIR, file), 'utf8')));
  const live = await request(`${grafanaUrl.replace(/\/+$/, '')}/api/dashboards/uid/${uid}`, apiKey);
  const liveDashboard = stripVolatile(live.dashboard);

  const committedJson = JSON.stringify(committed, Object.keys(committed).sort());
  const liveJson = JSON.stringify(liveDashboard, Object.keys(liveDashboard).sort());

  if (committedJson !== liveJson) {
    return { file, uid, drifted: true };
  }
  return { file, uid, drifted: false };
}

async function main() {
  const grafanaUrl = process.env.GRAFANA_URL;
  if (!grafanaUrl) {
    console.error('GRAFANA_URL is required (e.g. https://grafana.internal)');
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.GRAFANA_API_KEY;

  const files = fs.readdirSync(DASHBOARDS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.error(`No dashboard JSON files found in ${DASHBOARDS_DIR}`);
    process.exitCode = 2;
    return;
  }

  let anyDrifted = false;
  for (const file of files) {
    try {
      const result = await checkOne(file, grafanaUrl, apiKey);
      if (result.drifted) {
        anyDrifted = true;
        console.error(
          `DRIFT: ${result.file} (uid=${result.uid}) differs from the live Grafana dashboard. ` +
            'Either someone edited it in the UI (check allowUiUpdates), or the committed file ' +
            'needs to be updated from a deliberate change made some other way.',
        );
      } else {
        console.log(`OK: ${result.file} (uid=${result.uid}) matches the live dashboard`);
      }
    } catch (err) {
      anyDrifted = true;
      console.error(`ERROR checking ${file}: ${err.message}`);
    }
  }

  process.exitCode = anyDrifted ? 1 : 0;
}

main();
