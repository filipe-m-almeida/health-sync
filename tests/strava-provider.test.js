import assert from 'node:assert/strict';
import test from 'node:test';

import { HealthSyncDb } from '../src/db.js';
import { PluginHelpers } from '../src/plugins/base.js';
import stravaProvider from '../src/providers/strava.js';
import {
  baseConfig,
  dbPathFor,
  jsonResponse,
  makeTempDir,
  removeDir,
  withFetchMock,
} from './test-helpers.js';

function withDbAndConfig(t, stravaOverrides = {}) {
  const dir = makeTempDir();
  const db = new HealthSyncDb(dbPathFor(dir));
  db.init();
  const config = baseConfig({
    strava: {
      enabled: true,
      access_token: 'static-access-token',
      start_date: '2026-02-01',
      overlap_seconds: 604800,
      page_size: 100,
      ...stravaOverrides,
    },
  });
  const helpers = new PluginHelpers(config);
  t.after(() => {
    db.close();
    removeDir(dir);
  });
  return { db, config, helpers };
}

function installStravaFetch(t, activityResponder) {
  const seenAfter = [];
  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/api/v3/athlete')) {
      return jsonResponse({ id: 123 });
    }
    if (url.pathname.endsWith('/api/v3/athlete/activities')) {
      seenAfter.push(url.searchParams.get('after'));
      const data = await activityResponder(url);
      return jsonResponse(data);
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });
  return seenAfter;
}

test('first sync with no activities keeps start_date anchor', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, { start_date: '2026-02-01' });
  const seenAfter = installStravaFetch(t, async () => []);

  await stravaProvider.sync(db, config, helpers);

  const st = db.getSyncState('strava', 'activities');
  assert.ok(st);
  assert.equal(st.watermark, '2026-02-01T00:00:00Z');
  assert.equal(seenAfter.length, 1);
  assert.equal(seenAfter[0], '1769904000');
});

test('no new activities preserves existing watermark', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, {
    start_date: '2026-02-01',
    overlap_seconds: 3600,
  });
  db.setSyncState('strava', 'activities', { watermark: '2026-02-10T09:30:52Z' });

  const seenAfter = installStravaFetch(t, async () => []);
  await stravaProvider.sync(db, config, helpers);

  const st = db.getSyncState('strava', 'activities');
  assert.ok(st);
  assert.equal(st.watermark, '2026-02-10T09:30:52Z');
  assert.equal(seenAfter.length, 1);
  assert.equal(seenAfter[0], '1769904000');
});

test('new activities advance watermark to latest start_date', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, { start_date: '2026-02-01' });
  installStravaFetch(t, async () => [
    { id: 1, start_date: '2026-02-10T09:30:52Z' },
  ]);

  await stravaProvider.sync(db, config, helpers);

  const st = db.getSyncState('strava', 'activities');
  assert.ok(st);
  assert.equal(st.watermark, '2026-02-10T09:30:52Z');
});

test('strava refreshes activities older than current watermark', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, {
    start_date: '2026-02-01',
    overlap_seconds: 0,
  });
  db.setSyncState('strava', 'activities', { watermark: '2026-02-15T00:00:00Z' });
  db.upsertRecord({
    provider: 'strava',
    resource: 'activities',
    recordId: '42',
    startTime: '2026-02-02T10:00:00Z',
    sourceUpdatedAt: '2026-02-02T10:00:00Z',
    payload: { id: 42, start_date: '2026-02-02T10:00:00Z', name: 'Before edit' },
  });

  installStravaFetch(t, async () => [
    { id: 42, start_date: '2026-02-02T10:00:00Z', updated_at: '2026-02-20T00:00:00Z', name: 'After edit' },
  ]);

  await stravaProvider.sync(db, config, helpers);

  const row = db.conn.prepare(`
    SELECT payload_json, source_updated_at
    FROM records
    WHERE provider = 'strava' AND resource = 'activities' AND record_id = '42'
  `).get();
  assert.ok(row);
  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.name, 'After edit');
  assert.equal(row.source_updated_at, '2026-02-20T00:00:00Z');
});

test('strava sync removes locally stale activities not returned by API', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, { start_date: '2026-02-01' });
  db.upsertRecord({
    provider: 'strava',
    resource: 'activities',
    recordId: '999',
    startTime: '2026-02-03T10:00:00Z',
    sourceUpdatedAt: '2026-02-03T10:00:00Z',
    payload: { id: 999, start_date: '2026-02-03T10:00:00Z', name: 'Removed upstream' },
  });

  installStravaFetch(t, async () => [
    { id: 1000, start_date: '2026-02-04T10:00:00Z' },
  ]);

  await stravaProvider.sync(db, config, helpers);

  const gone = db.conn.prepare(`
    SELECT 1
    FROM records
    WHERE provider = 'strava' AND resource = 'activities' AND record_id = '999'
  `).get();
  assert.equal(gone, undefined);
  const present = db.conn.prepare(`
    SELECT 1
    FROM records
    WHERE provider = 'strava' AND resource = 'activities' AND record_id = '1000'
  `).get();
  assert.ok(present);

  const runs = db.listRecentSyncRuns(2);
  const activityRun = runs.find((r) => r.provider === 'strava' && r.resource === 'activities');
  assert.ok(activityRun);
  assert.equal(activityRun.deletedCount, 1);
});
