import assert from 'node:assert/strict';
import test from 'node:test';

import { HealthSyncDb } from '../src/db.js';
import { PluginHelpers } from '../src/plugins/base.js';
import hevyProvider from '../src/providers/hevy.js';
import {
  baseConfig,
  dbPathFor,
  jsonResponse,
  makeTempDir,
  removeDir,
  withFetchMock,
} from './test-helpers.js';

function withDbAndConfig(t, hevyOverrides = {}) {
  const dir = makeTempDir();
  const db = new HealthSyncDb(dbPathFor(dir));
  db.init();
  const config = baseConfig({
    hevy: {
      enabled: true,
      api_key: 'hevy-key',
      overlap_seconds: 300,
      page_size: 10,
      ...hevyOverrides,
    },
  });
  const helpers = new PluginHelpers(config);
  t.after(() => {
    db.close();
    removeDir(dir);
  });
  return { db, config, helpers };
}

test('hevy initial backfill sets watermark from latest workout update', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);

  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/v1/workouts')) {
      return jsonResponse({
        workouts: [
          { id: 'w1', start_time: '2026-02-10T07:00:00Z', updated_at: '2026-02-10T08:00:00Z' },
          { id: 'w2', start_time: '2026-02-11T07:00:00Z', updated_at: '2026-02-11T08:00:00Z' },
        ],
        page_count: 1,
      });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await hevyProvider.sync(db, config, helpers);

  const st = db.getSyncState('hevy', 'workouts');
  assert.ok(st);
  assert.equal(st.watermark, '2026-02-11T08:00:00Z');
  assert.equal(db.getRecordCount('hevy', 'workouts'), 2);
});

test('hevy delta sync processes updated, deleted, and unknown events', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, { overlap_seconds: 300 });

  db.setSyncState('hevy', 'workouts', { watermark: '2026-02-12T00:00:00Z' });
  db.upsertRecord({
    provider: 'hevy',
    resource: 'workouts',
    recordId: 'w-deleted',
    payload: { id: 'w-deleted' },
    startTime: '2026-02-11T00:00:00Z',
  });

  const seenSince = [];
  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/v1/workouts/events')) {
      seenSince.push(url.searchParams.get('since'));
      return jsonResponse({
        events: [
          {
            type: 'updated',
            workout: {
              id: 'w-updated',
              start_time: '2026-02-12T06:00:00Z',
              end_time: '2026-02-12T07:00:00Z',
              updated_at: '2026-02-12T08:00:00Z',
            },
          },
          {
            type: 'deleted',
            id: 'w-deleted',
            deleted_at: '2026-02-13T09:00:00Z',
          },
          {
            type: 'mystery',
            foo: 'bar',
          },
        ],
        page_count: 1,
      });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await hevyProvider.sync(db, config, helpers);

  const st = db.getSyncState('hevy', 'workouts');
  assert.ok(st);
  assert.equal(st.watermark, '2026-02-13T09:00:00Z');
  const eventsState = db.getSyncState('hevy', 'workout_events');
  assert.ok(eventsState);
  assert.equal(eventsState.watermark, '2026-02-13T09:00:00Z');
  assert.equal(seenSince.length, 1);
  assert.equal(seenSince[0], '2026-02-11T23:55:00Z');

  const deleted = db.conn.prepare(`
    SELECT 1 AS v
    FROM records
    WHERE provider = 'hevy' AND resource = 'workouts' AND record_id = 'w-deleted'
  `).get();
  assert.equal(deleted, undefined);

  assert.equal(db.getRecordCount('hevy', 'workout_events'), 3);

  const runs = db.listRecentSyncRuns(4);
  const workoutRun = runs.find((r) => r.provider === 'hevy' && r.resource === 'workouts');
  const eventsRun = runs.find((r) => r.provider === 'hevy' && r.resource === 'workout_events');
  assert.ok(workoutRun);
  assert.ok(eventsRun);
  assert.equal(workoutRun.deletedCount, 1);
  assert.equal(eventsRun.insertedCount, 3);
});

test('hevy delta sync advances watermark from updated events without top-level timestamp', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, { overlap_seconds: 300 });
  db.setSyncState('hevy', 'workouts', { watermark: '2026-02-12T00:00:00Z' });

  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/v1/workouts/events')) {
      return jsonResponse({
        events: [
          {
            type: 'updated',
            workout: {
              id: 'w-updated-only',
              start_time: '2026-02-13T06:00:00Z',
              end_time: '2026-02-13T07:00:00Z',
              updated_at: '2026-02-13T08:00:00Z',
            },
          },
        ],
        page_count: 1,
      });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await hevyProvider.sync(db, config, helpers);

  const st = db.getSyncState('hevy', 'workouts');
  assert.ok(st);
  assert.equal(st.watermark, '2026-02-13T08:00:00Z');
  const eventsState = db.getSyncState('hevy', 'workout_events');
  assert.ok(eventsState);
  assert.equal(eventsState.watermark, '2026-02-13T08:00:00Z');
});
