import assert from 'node:assert/strict';
import test from 'node:test';

import { HealthSyncDb } from '../src/db.js';
import { PluginHelpers } from '../src/plugins/base.js';
import eightsleepProvider from '../src/providers/eightsleep.js';
import {
  baseConfig,
  dbPathFor,
  isoNowPlusSeconds,
  jsonResponse,
  makeTempDir,
  removeDir,
  withFetchMock,
} from './test-helpers.js';

function withDbAndConfig(t, eightsleepOverrides = {}) {
  const dir = makeTempDir();
  const db = new HealthSyncDb(dbPathFor(dir));
  db.init();
  const config = baseConfig({
    eightsleep: {
      enabled: true,
      email: 'user@example.com',
      password: 'pw',
      client_id: 'eight-client',
      client_secret: 'eight-secret',
      timezone: 'UTC',
      start_date: '2026-02-01',
      overlap_days: 2,
      ...eightsleepOverrides,
    },
  });
  const helpers = new PluginHelpers(config);
  t.after(() => {
    db.close();
    removeDir(dir);
  });
  return { db, config, helpers };
}

test('eightsleep auth uses cached unexpired token without network calls', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, { access_token: null });
  db.setOAuthToken('eightsleep', {
    accessToken: 'cached-token',
    refreshToken: null,
    tokenType: 'Bearer',
    scope: null,
    expiresAt: isoNowPlusSeconds(3600),
  });

  let calls = 0;
  withFetchMock(t, async () => {
    calls += 1;
    throw new Error('fetch should not be called');
  });

  await eightsleepProvider.auth(db, config, helpers);
  assert.equal(calls, 0);
});

test('eightsleep auth stores static access token from config', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, { access_token: 'cfg-static-token' });
  withFetchMock(t, async () => {
    throw new Error('fetch should not be called for static token auth');
  });

  await eightsleepProvider.auth(db, config, helpers);
  const tok = db.getOAuthToken('eightsleep');
  assert.ok(tok);
  assert.equal(tok.accessToken, 'cfg-static-token');
  assert.equal(tok.extra.method, 'static_access_token');
});

test('eightsleep auth requests and persists new token', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, { access_token: null });
  let tokenCalls = 0;
  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.toString().includes('/v1/tokens')) {
      tokenCalls += 1;
      return jsonResponse({
        access_token: 'auth-token',
        expires_in: 7200,
        tenant: 'demo',
      });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await eightsleepProvider.auth(db, config, helpers);
  assert.equal(tokenCalls, 1);

  const tok = db.getOAuthToken('eightsleep');
  assert.ok(tok);
  assert.equal(tok.accessToken, 'auth-token');
  assert.equal(tok.extra.tenant, 'demo');
  assert.ok(tok.expiresAt);
});

test('eightsleep sync writes users, devices, and trends with overlap anchor', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t, {
    access_token: 'fake-token',
    start_date: '2026-02-01',
    overlap_days: 2,
  });
  db.setSyncState('eightsleep', 'trends', { watermark: '2026-02-10T00:00:00Z' });

  const trendCalls = [];
  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/users/me')) {
      return jsonResponse({ user: { id: 'u1', devices: ['d1'] } });
    }
    if (url.pathname.endsWith('/devices/d1')) {
      return jsonResponse({ result: { leftUserId: 'u1', rightUserId: 'u2' } });
    }
    if (url.pathname.endsWith('/users/u1')) {
      return jsonResponse({ user: { id: 'u1', name: 'Left' } });
    }
    if (url.pathname.endsWith('/users/u2')) {
      return jsonResponse({ user: { id: 'u2', name: 'Right' } });
    }
    if (url.pathname.endsWith('/users/u1/trends') || url.pathname.endsWith('/users/u2/trends')) {
      trendCalls.push({
        url: url.toString(),
        params: Object.fromEntries(url.searchParams.entries()),
      });
      return jsonResponse({
        days: [
          {
            day: '2026-02-11',
            presenceStart: '2026-02-11T01:00:00Z',
            presenceEnd: '2026-02-11T07:00:00Z',
            updatedAt: '2026-02-11T08:00:00Z',
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await eightsleepProvider.sync(db, config, helpers);

  assert.equal(db.getRecordCount('eightsleep', 'users_me'), 1);
  assert.equal(db.getRecordCount('eightsleep', 'devices'), 1);
  assert.equal(db.getRecordCount('eightsleep', 'users'), 2);
  assert.equal(db.getRecordCount('eightsleep', 'trends'), 2);

  const stUsers = db.getSyncState('eightsleep', 'users');
  const stTrends = db.getSyncState('eightsleep', 'trends');
  assert.ok(stUsers?.watermark);
  assert.ok(stTrends?.watermark);

  assert.equal(trendCalls.length, 2);
  for (const call of trendCalls) {
    assert.equal(call.params.from, '2026-02-08');
    assert.equal(call.params.to, new Date().toISOString().slice(0, 10));
    assert.equal(call.params.tz, 'UTC');
  }
});
