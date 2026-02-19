import assert from 'node:assert/strict';
import test from 'node:test';

import { HealthSyncDb } from '../src/db.js';
import { PluginHelpers } from '../src/plugins/base.js';
import ouraProvider from '../src/providers/oura.js';
import {
  baseConfig,
  dbPathFor,
  isoNowPlusSeconds,
  jsonResponse,
  makeTempDir,
  removeDir,
  withFetchMock,
} from './test-helpers.js';

function withDbAndConfig(t, ouraOverrides = {}) {
  const dir = makeTempDir();
  const db = new HealthSyncDb(dbPathFor(dir));
  db.init();
  const config = baseConfig({
    oura: {
      enabled: true,
      client_id: 'oura-client',
      client_secret: 'oura-secret',
      start_date: '2026-02-01',
      overlap_days: 1,
      ...ouraOverrides,
    },
  });
  const helpers = new PluginHelpers(config);
  t.after(() => {
    db.close();
    removeDir(dir);
  });
  return { db, config, helpers };
}

test('oura sleep endpoint uses next-day end_date window', async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const { db, config, helpers } = withDbAndConfig(t, { start_date: today });

  db.setOAuthToken('oura', {
    accessToken: 'cached-token',
    refreshToken: null,
    tokenType: 'Bearer',
    scope: 'extapi:daily',
    expiresAt: isoNowPlusSeconds(3600),
  });

  const calls = [];
  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ pathname: url.pathname, params: Object.fromEntries(url.searchParams.entries()) });
    if (url.pathname.endsWith('/v2/usercollection/personal_info')) {
      return jsonResponse({});
    }
    return jsonResponse({ data: [] });
  });

  await ouraProvider.sync(db, config, helpers);

  const dailySleep = calls.filter((c) => c.pathname.endsWith('/v2/usercollection/daily_sleep'));
  const sleep = calls.filter((c) => c.pathname.endsWith('/v2/usercollection/sleep'));
  assert.equal(dailySleep.length, 1);
  assert.equal(sleep.length, 1);

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(dailySleep[0].params.end_date, today);
  assert.equal(sleep[0].params.end_date, tomorrow);
});

test('oura sync raises helpful error when oauth token is missing', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);
  withFetchMock(t, async () => {
    throw new Error('fetch should not be called when token is missing');
  });

  await assert.rejects(
    () => ouraProvider.sync(db, config, helpers),
    /Oura token not found/,
  );
});

test('oura legacy token without refresh_token requires reauth', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);
  db.setOAuthToken('oura', {
    accessToken: 'legacy-token',
    refreshToken: null,
    tokenType: 'Bearer',
    scope: null,
    expiresAt: null,
    extra: { method: 'legacy' },
  });
  withFetchMock(t, async () => {
    throw new Error('fetch should not be called for missing refresh token');
  });

  await assert.rejects(
    () => ouraProvider.sync(db, config, helpers),
    /refresh_token is missing/,
  );
});

test('oura expired oauth token is refreshed and persisted', async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const { db, config, helpers } = withDbAndConfig(t, { start_date: today });

  db.setOAuthToken('oura', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenType: 'Bearer',
    scope: 'old-scope',
    expiresAt: '2020-01-01T00:00:00Z',
    extra: { old: true },
  });

  const tokenRequests = [];
  withFetchMock(t, async (input, options = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/oauth/v2/ext/oauth-token')) {
      const form = new URLSearchParams(String(options.body || ''));
      tokenRequests.push(Object.fromEntries(form.entries()));
      return jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
        scope: 'new-scope',
        expires_in: 3600,
        provider_user_id: '123',
      });
    }
    if (url.pathname.endsWith('/v2/usercollection/personal_info')) {
      return jsonResponse({});
    }
    return jsonResponse({ data: [] });
  });

  await ouraProvider.sync(db, config, helpers);

  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].grant_type, 'refresh_token');

  const token = db.getOAuthToken('oura');
  assert.ok(token);
  assert.equal(token.accessToken, 'new-access');
  assert.equal(token.refreshToken, 'new-refresh');
  assert.equal(token.scope, 'new-scope');
  assert.ok(token.expiresAt);
  assert.equal(token.extra.provider_user_id, '123');
});
