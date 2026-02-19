import assert from 'node:assert/strict';
import test from 'node:test';

import { HealthSyncDb } from '../src/db.js';
import { PluginHelpers } from '../src/plugins/base.js';
import withingsProvider from '../src/providers/withings.js';
import {
  baseConfig,
  dbPathFor,
  jsonResponse,
  makeTempDir,
  removeDir,
  withFetchMock,
} from './test-helpers.js';

function withDbAndConfig(t, withingsOverrides = {}) {
  const dir = makeTempDir();
  const db = new HealthSyncDb(dbPathFor(dir));
  db.init();
  const config = baseConfig({
    withings: {
      enabled: true,
      client_id: 'withings-client',
      client_secret: 'withings-secret',
      overlap_seconds: 300,
      ...withingsOverrides,
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

test('withings expired oauth token is refreshed and persisted', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);
  db.setOAuthToken('withings', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenType: 'Bearer',
    scope: 'user.metrics',
    expiresAt: '2020-01-01T00:00:00Z',
    extra: { old: true },
  });

  const refreshCalls = [];
  withFetchMock(t, async (input, options = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const params = bodyParams(options);
    if (url.pathname.endsWith('/v2/signature')) {
      return jsonResponse({ status: 0, body: { nonce: 'nonce-1' } });
    }
    if (url.pathname.endsWith('/v2/oauth2')) {
      refreshCalls.push(Object.fromEntries(params.entries()));
      return jsonResponse({
        status: 0,
        body: {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          scope: 'user.metrics,user.activity',
          expires_in: 3600,
          userid: 12345,
        },
      });
    }
    if (url.pathname.endsWith('/v2/measure')) {
      const action = params.get('action');
      if (action === 'getactivity') {
        return jsonResponse({ status: 0, body: { activities: [], more: 0 } });
      }
      if (action === 'getworkouts') {
        return jsonResponse({ status: 0, body: { series: [], more: 0 } });
      }
    }
    if (url.pathname.endsWith('/measure')) {
      return jsonResponse({
        status: 0,
        body: { measuregrps: [], more: 0, updatetime: 1770715852 },
      });
    }
    if (url.pathname.endsWith('/v2/sleep')) {
      return jsonResponse({ status: 0, body: { series: [], more: 0 } });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await withingsProvider.sync(db, config, helpers);

  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].grant_type, 'refresh_token');
  assert.equal(refreshCalls[0].nonce, 'nonce-1');

  const token = db.getOAuthToken('withings');
  assert.ok(token);
  assert.equal(token.accessToken, 'new-access');
  assert.equal(token.refreshToken, 'new-refresh');
  assert.equal(token.scope, 'user.metrics,user.activity');
  assert.ok(token.expiresAt);
});

test('withings sync raises helpful error when oauth token is missing', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);
  withFetchMock(t, async () => {
    throw new Error('fetch should not run when token is missing');
  });

  await assert.rejects(
    () => withingsProvider.sync(db, config, helpers),
    /Withings token not found/,
  );
});

test('withings failed refresh response raises error', async (t) => {
  const { db, config, helpers } = withDbAndConfig(t);
  db.setOAuthToken('withings', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenType: 'Bearer',
    scope: 'user.metrics',
    expiresAt: '2020-01-01T00:00:00Z',
  });

  withFetchMock(t, async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.endsWith('/v2/signature')) {
      return jsonResponse({ status: 0, body: { nonce: 'nonce-1' } });
    }
    if (url.pathname.endsWith('/v2/oauth2')) {
      return jsonResponse({ status: 401, error: 'invalid_grant' });
    }
    throw new Error(`Unexpected URL: ${url.toString()}`);
  });

  await assert.rejects(
    () => withingsProvider.sync(db, config, helpers),
    /Withings token refresh failed/,
  );
});
