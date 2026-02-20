import assert from 'node:assert/strict';
import test from 'node:test';

import { HealthSyncDb } from '../src/db.js';
import { PluginHelpers } from '../src/plugins/base.js';
import stravaProvider from '../src/providers/strava.js';
import withingsProvider from '../src/providers/withings.js';
import {
  baseConfig,
  dbPathFor,
  jsonResponse,
  makeTempDir,
  removeDir,
  withFetchMock,
} from './test-helpers.js';

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

test('withings watermark parser handles normalized ISO watermarks', async (t) => {
  const db = withDb(t);
  db.setSyncState('withings', 'activity', { watermark: '1770715852' });
  db.setOAuthToken('withings', {
    accessToken: 'tok',
    refreshToken: null,
    tokenType: 'Bearer',
    scope: 'user.metrics,user.activity',
    expiresAt: null,
  });

  const config = baseConfig({
    withings: {
      enabled: true,
      overlap_seconds: 0,
      client_id: 'withings-client',
      client_secret: 'withings-secret',
    },
  });
  const helpers = new PluginHelpers(config);

  const activityLastUpdate = [];
  withFetchMock(t, async (input, options = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const form = options.body instanceof URLSearchParams
      ? options.body
      : new URLSearchParams(String(options.body || ''));

    if (url.pathname.endsWith('/v2/measure')) {
      const action = form.get('action');
      if (action === 'getactivity') {
        activityLastUpdate.push(form.get('lastupdate'));
        return jsonResponse({ status: 0, body: { activities: [], more: 0 } });
      }
      if (action === 'getworkouts') {
        return jsonResponse({ status: 0, body: { series: [], more: 0 } });
      }
    }
    if (url.pathname.endsWith('/measure')) {
      return jsonResponse({ status: 0, body: { measuregrps: [], more: 0, updatetime: 1770715852 } });
    }
    if (url.pathname.endsWith('/v2/sleep')) {
      return jsonResponse({ status: 0, body: { series: [], more: 0 } });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await withingsProvider.sync(db, config, helpers);
  assert.equal(activityLastUpdate.length, 1);
  assert.equal(activityLastUpdate[0], '1770715852');
});

test('strava watermark parser handles date watermarks', async (t) => {
  const db = withDb(t);
  db.setSyncState('strava', 'activities', { watermark: '2026-02-10' });

  const config = baseConfig({
    strava: {
      enabled: true,
      access_token: 'tok',
      start_date: '2026-02-01',
      overlap_seconds: 0,
      page_size: 100,
    },
  });
  const helpers = new PluginHelpers(config);

  const activityAfter = [];
  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/api/v3/athlete')) {
      return jsonResponse({ id: 123 });
    }
    if (url.pathname.endsWith('/api/v3/athlete/activities')) {
      activityAfter.push(url.searchParams.get('after'));
      return jsonResponse([]);
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await stravaProvider.sync(db, config, helpers);
  assert.equal(activityAfter.length, 1);
  assert.equal(activityAfter[0], '1769904000');
});
