import assert from 'node:assert/strict';
import test from 'node:test';

import { HealthSyncDb } from '../src/db.js';
import { PluginHelpers } from '../src/plugins/base.js';
import whoopProvider from '../src/providers/whoop.js';
import {
  baseConfig,
  dbPathFor,
  jsonResponse,
  makeTempDir,
  removeDir,
  withFetchMock,
} from './test-helpers.js';

function withDbAndConfig(t, whoopOverrides = {}) {
  const dir = makeTempDir();
  const db = new HealthSyncDb(dbPathFor(dir));
  db.init();
  const config = baseConfig({
    whoop: {
      enabled: true,
      client_id: 'whoop-client',
      client_secret: 'whoop-secret',
      start_date: '2026-02-01',
      overlap_days: 1,
      page_size: 25,
      ...whoopOverrides,
    },
  });
  const helpers = new PluginHelpers(config);
  t.after(() => {
    db.close();
    removeDir(dir);
  });
  return { db, config, helpers };
}

function bodyParams(options) {
  if (!options?.body) {
    return new URLSearchParams();
  }
  if (options.body instanceof URLSearchParams) {
    return options.body;
  }
  return new URLSearchParams(String(options.body));
}

test('whoop expired oauth token is refreshed and collection resources are synced', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);

  db.setOAuthToken('whoop', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenType: 'Bearer',
    scope: 'offline read:sleep',
    expiresAt: '2020-01-01T00:00:00Z',
    extra: { old: true },
  });

  const refreshCalls = [];
  const cycleStarts = [];

  withFetchMock(t, async (input, options = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/oauth/oauth2/token')) {
      refreshCalls.push(Object.fromEntries(bodyParams(options).entries()));
      return jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'bearer',
        scope: 'offline read:sleep read:workout read:cycles read:recovery read:profile read:body_measurement',
        expires_in: 3600,
      });
    }
    if (url.pathname.endsWith('/developer/v2/user/profile/basic')) {
      return jsonResponse({
        user_id: 7,
        email: 'test@example.com',
        first_name: 'Test',
        last_name: 'User',
      });
    }
    if (url.pathname.endsWith('/developer/v2/user/measurement/body')) {
      return jsonResponse({
        height_meter: 1.82,
        weight_kilogram: 80.1,
        max_heart_rate: 190,
      });
    }
    if (url.pathname.endsWith('/developer/v2/cycle')) {
      cycleStarts.push(url.searchParams.get('start'));
      return jsonResponse({
        records: [
          {
            id: 10,
            start: '2026-02-11T00:00:00Z',
            end: '2026-02-11T23:59:59Z',
            updated_at: '2026-02-11T23:59:59Z',
          },
        ],
      });
    }
    if (url.pathname.endsWith('/developer/v2/recovery')) {
      return jsonResponse({
        records: [
          {
            cycle_id: 10,
            sleep_id: '11111111-1111-1111-1111-111111111111',
            created_at: '2026-02-12T10:00:00Z',
            updated_at: '2026-02-12T10:20:00Z',
            score_state: 'SCORED',
          },
        ],
      });
    }
    if (url.pathname.endsWith('/developer/v2/activity/sleep')) {
      return jsonResponse({
        records: [
          {
            id: 'sleep-1',
            start: '2026-02-11T22:00:00Z',
            end: '2026-02-12T06:00:00Z',
            updated_at: '2026-02-12T06:20:00Z',
          },
        ],
      });
    }
    if (url.pathname.endsWith('/developer/v2/activity/workout')) {
      return jsonResponse({
        records: [
          {
            id: 'workout-1',
            start: '2026-02-12T17:00:00Z',
            end: '2026-02-12T18:00:00Z',
            updated_at: '2026-02-12T18:10:00Z',
            sport_name: 'running',
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await whoopProvider.sync(db, config, helpers);

  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].grant_type, 'refresh_token');
  assert.equal(refreshCalls[0].scope, 'offline');
  assert.equal(cycleStarts.length, 1);
  assert.ok(cycleStarts[0]?.startsWith('2026-01-31T'));

  const token = db.getOAuthToken('whoop');
  assert.ok(token);
  assert.equal(token.accessToken, 'new-access');
  assert.equal(token.refreshToken, 'new-refresh');
  assert.ok(token.expiresAt);

  assert.equal(db.getRecordCount('whoop', 'profile_basic'), 1);
  assert.equal(db.getRecordCount('whoop', 'body_measurement'), 1);
  assert.equal(db.getRecordCount('whoop', 'cycles'), 1);
  assert.equal(db.getRecordCount('whoop', 'recoveries'), 1);
  assert.equal(db.getRecordCount('whoop', 'sleep'), 1);
  assert.equal(db.getRecordCount('whoop', 'workouts'), 1);

  const cycleState = db.getSyncState('whoop', 'cycles');
  assert.ok(cycleState);
  assert.equal(cycleState.watermark, '2026-02-11T00:00:00Z');
});

test('whoop sync raises helpful error when oauth token is missing', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);
  withFetchMock(t, async () => {
    throw new Error('fetch should not run when token is missing');
  });

  await assert.rejects(
    () => whoopProvider.sync(db, config, helpers),
    /WHOOP token not found/,
  );
});

test('whoop expired token without refresh token requires reauth', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);
  db.setOAuthToken('whoop', {
    accessToken: 'legacy-token',
    refreshToken: null,
    tokenType: 'Bearer',
    scope: 'read:sleep',
    expiresAt: '2020-01-01T00:00:00Z',
    extra: { method: 'legacy' },
  });
  withFetchMock(t, async () => {
    throw new Error('fetch should not run when refresh token is missing');
  });

  await assert.rejects(
    () => whoopProvider.sync(db, config, helpers),
    /refresh_token is missing/,
  );
});
