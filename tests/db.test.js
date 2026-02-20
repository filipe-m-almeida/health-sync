import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { HealthSyncDb } from '../src/db.js';
import { dbPathFor, makeTempDir, removeDir } from './test-helpers.js';

function withDb(t) {
  const dir = makeTempDir();
  const db = new HealthSyncDb(dbPathFor(dir));
  db.init();
  t.after(() => {
    db.close();
    removeDir(dir);
  });
  return db;
}

test('getSyncState warns on invalid extra_json', (t) => {
  const db = withDb(t);
  db.conn.prepare(`
    INSERT INTO sync_state(provider, resource, watermark, cursor, extra_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('oura', 'daily_sleep', '2026-02-12', null, '{broken-json', '2026-02-12T00:00:00Z');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const state = db.getSyncState('oura', 'daily_sleep');
    assert.ok(state);
    assert.equal(state.extra, null);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((w) => w.includes('Ignoring invalid JSON in sync_state.oura.daily_sleep.extra_json')));
});

test('getOAuthToken warns on invalid extra_json', (t) => {
  const db = withDb(t);
  db.conn.prepare(`
    INSERT INTO oauth_tokens(provider, access_token, refresh_token, token_type, scope, expires_at, obtained_at, extra_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('oura', 'abc', null, 'Bearer', null, null, '2026-02-12T00:00:00Z', '{bad-json');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const token = db.getOAuthToken('oura');
    assert.ok(token);
    assert.equal(token.extra, null);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((w) => w.includes('Ignoring invalid JSON in oauth_tokens.oura.extra_json')));
});

test('setOAuthToken persists credentials in .health-sync.creds', (t) => {
  const db = withDb(t);

  db.setOAuthToken('oura', {
    accessToken: 'token-a',
    refreshToken: 'refresh-a',
    tokenType: 'Bearer',
    scope: 'extapi:daily',
    expiresAt: '2027-01-01T00:00:00Z',
    extra: { method: 'oauth' },
  });

  assert.equal(fs.existsSync(db.credsPath), true);
  const creds = JSON.parse(fs.readFileSync(db.credsPath, 'utf8'));
  assert.equal(creds.tokens.oura.accessToken, 'token-a');
  assert.equal(creds.tokens.oura.refreshToken, 'refresh-a');

  const row = db.conn.prepare('SELECT COUNT(*) AS count FROM oauth_tokens WHERE provider = ?').get('oura');
  assert.equal(Number(row?.count ?? 0), 0);
});

test('init migrates legacy oauth_tokens table rows into .health-sync.creds', (t) => {
  const dir = makeTempDir();
  const dbPath = dbPathFor(dir);

  const legacy = new HealthSyncDb(dbPath);
  legacy.init();
  legacy.conn.prepare(`
    INSERT INTO oauth_tokens(provider, access_token, refresh_token, token_type, scope, expires_at, obtained_at, extra_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('withings', 'legacy-access', 'legacy-refresh', 'Bearer', 'user.metrics', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{"source":"db"}');
  legacy.close();

  const db = new HealthSyncDb(dbPath);
  db.init();
  t.after(() => {
    db.close();
    removeDir(dir);
  });

  assert.equal(fs.existsSync(db.credsPath), true);
  const token = db.getOAuthToken('withings');
  assert.ok(token);
  assert.equal(token.accessToken, 'legacy-access');
  assert.equal(token.refreshToken, 'legacy-refresh');

  const creds = JSON.parse(fs.readFileSync(db.credsPath, 'utf8'));
  assert.equal(creds.tokens.withings.accessToken, 'legacy-access');

  const row = db.conn.prepare('SELECT COUNT(*) AS count FROM oauth_tokens WHERE provider = ?').get('withings');
  assert.equal(Number(row?.count ?? 0), 0);
});

test('nested transaction after prior write works', async (t) => {
  const db = withDb(t);
  db.setOAuthToken('withings', {
    accessToken: 'token',
    refreshToken: 'refresh',
    tokenType: 'Bearer',
    scope: 'x',
    expiresAt: '2026-02-12T00:00:00Z',
  });

  await db.transaction(async () => {
    db.setSyncState('withings', 'activity', { watermark: '1770715852' });
  });

  const st = db.getSyncState('withings', 'activity');
  assert.ok(st);
  assert.match(st.watermark, /Z$/);
});

test('watermark normalization supports epoch and date values', (t) => {
  const db = withDb(t);

  db.setSyncState('withings', 'activity', { watermark: '1770715852' });
  const stEpoch = db.getSyncState('withings', 'activity');
  assert.ok(stEpoch);
  assert.match(stEpoch.watermark, /^\d{4}-\d{2}-\d{2}T/);

  db.setSyncState('oura', 'daily_sleep', { watermark: '2026-02-11' });
  const stDate = db.getSyncState('oura', 'daily_sleep');
  assert.ok(stDate);
  assert.equal(stDate.watermark, '2026-02-11T00:00:00Z');
});

test('syncRun records counts and success status', async (t) => {
  const db = withDb(t);

  await db.syncRun('oura', 'daily_sleep', async () => {
    await db.transaction(async () => {
      db.upsertRecord({
        provider: 'oura',
        resource: 'daily_sleep',
        recordId: '2026-02-11',
        payload: { id: '2026-02-11', score: 80 },
        startTime: '2026-02-11',
      });
      db.upsertRecord({
        provider: 'oura',
        resource: 'daily_sleep',
        recordId: '2026-02-11',
        payload: { id: '2026-02-11', score: 80 },
        startTime: '2026-02-11',
      });
      db.deleteRecord('oura', 'daily_sleep', '2026-02-11');
      db.setSyncState('oura', 'daily_sleep', { watermark: '2026-02-12' });
    });
  });

  const runs = db.listRecentSyncRuns(1);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.status, 'success');
  assert.equal(run.insertedCount, 1);
  assert.equal(run.updatedCount, 0);
  assert.equal(run.unchangedCount, 1);
  assert.equal(run.deletedCount, 1);
  assert.equal(run.watermarkAfter, '2026-02-12T00:00:00Z');
});

test('syncRun records error status and error text', async (t) => {
  const db = withDb(t);

  await assert.rejects(
    () => db.syncRun('oura', 'daily_activity', async () => {
      await db.transaction(async () => {
        db.upsertRecord({
          provider: 'oura',
          resource: 'daily_activity',
          recordId: '2026-02-12',
          payload: { id: '2026-02-12', steps: 10000 },
          startTime: '2026-02-12',
        });
        throw new Error('boom');
      });
    }),
    /boom/,
  );

  const runs = db.listRecentSyncRuns(1);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.status, 'error');
  assert.match(String(run.errorText), /boom/);
});

test('init aborts stale running sync runs and reconcile can abort remaining running runs', (t) => {
  const dir = makeTempDir();
  const dbPath = dbPathFor(dir);
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const first = new HealthSyncDb(dbPath);
  first.init();
  first.conn.prepare(`
    INSERT INTO sync_runs(
      provider, resource, status, started_at, finished_at,
      watermark_before, watermark_after,
      inserted_count, updated_count, deleted_count, unchanged_count, error_text
    ) VALUES (?, ?, 'running', ?, NULL, NULL, NULL, 0, 0, 0, 0, NULL)
  `).run('oura', 'workout', '2000-01-01T00:00:00Z');
  first.conn.prepare(`
    INSERT INTO sync_runs(
      provider, resource, status, started_at, finished_at,
      watermark_before, watermark_after,
      inserted_count, updated_count, deleted_count, unchanged_count, error_text
    ) VALUES (?, ?, 'running', ?, NULL, NULL, NULL, 0, 0, 0, 0, NULL)
  `).run('oura', 'sleep', nowIso);
  first.close();

  const db = new HealthSyncDb(dbPath);
  db.init();
  t.after(() => {
    db.close();
    removeDir(dir);
  });

  const staleRow = db.conn.prepare(`
    SELECT status, finished_at, error_text
    FROM sync_runs
    WHERE provider = 'oura' AND resource = 'workout'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  assert.equal(staleRow.status, 'aborted');
  assert.ok(staleRow.finished_at);
  assert.match(String(staleRow.error_text), /Marked aborted by recovery/);

  const recentRowBefore = db.conn.prepare(`
    SELECT status
    FROM sync_runs
    WHERE provider = 'oura' AND resource = 'sleep'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  assert.equal(recentRowBefore.status, 'running');

  const reconciled = db.reconcileStaleSyncRuns(0);
  assert.equal(reconciled, 1);

  const recentRowAfter = db.conn.prepare(`
    SELECT status
    FROM sync_runs
    WHERE provider = 'oura' AND resource = 'sleep'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  assert.equal(recentRowAfter.status, 'aborted');
});

test('syncRun serializes concurrent runs for the same provider/resource', async (t) => {
  const db = withDb(t);

  const order = [];
  let releaseFirst = null;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = db.syncRun('oura', 'daily_sleep', async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
    db.setSyncState('oura', 'daily_sleep', { watermark: '2026-02-12T00:00:00Z' });
  });

  const second = db.syncRun('oura', 'daily_sleep', async () => {
    order.push('second:start');
    order.push('second:end');
    db.setSyncState('oura', 'daily_sleep', { watermark: '2026-02-13T00:00:00Z' });
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ['first:start']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);

  const runs = db.listRecentSyncRuns(2);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, 'success');
  assert.equal(runs[1].status, 'success');
});
