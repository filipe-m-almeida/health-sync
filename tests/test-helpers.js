import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix = 'health-sync-node-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

export function dbPathFor(dirPath, name = 'health.sqlite') {
  return path.join(dirPath, name);
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

export function isoNowPlusSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function baseConfig(overrides = {}) {
  const cfg = {
    app: { db: './health.sqlite' },
    oura: {
      enabled: false,
      client_id: null,
      client_secret: null,
      authorize_url: 'https://moi.ouraring.com/oauth/v2/ext/oauth-authorize',
      token_url: 'https://moi.ouraring.com/oauth/v2/ext/oauth-token',
      redirect_uri: 'http://localhost:8080/callback',
      scopes: 'extapi:daily',
      start_date: '2010-01-01',
      overlap_days: 7,
    },
    withings: {
      enabled: false,
      client_id: null,
      client_secret: null,
      redirect_uri: 'http://127.0.0.1:8485/callback',
      scopes: 'user.metrics,user.activity',
      overlap_seconds: 300,
      meastypes: null,
    },
    hevy: {
      enabled: false,
      api_key: null,
      base_url: 'https://api.hevyapp.com',
      overlap_seconds: 300,
      page_size: 10,
      since: '1970-01-01T00:00:00Z',
    },
    strava: {
      enabled: false,
      access_token: null,
      client_id: null,
      client_secret: null,
      redirect_uri: 'http://127.0.0.1:8486/callback',
      scopes: 'read,activity:read_all',
      approval_prompt: 'auto',
      start_date: '2010-01-01',
      overlap_seconds: 604800,
      page_size: 100,
    },
    whoop: {
      enabled: false,
      client_id: null,
      client_secret: null,
      authorize_url: 'https://api.prod.whoop.com/oauth/oauth2/auth',
      token_url: 'https://api.prod.whoop.com/oauth/oauth2/token',
      api_base_url: 'https://api.prod.whoop.com/developer',
      redirect_uri: 'http://127.0.0.1:8487/callback',
      scopes: 'offline read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement',
      start_date: '2010-01-01',
      overlap_days: 7,
      page_size: 25,
    },
    eightsleep: {
      enabled: false,
      access_token: null,
      email: null,
      password: null,
      client_id: '0894c7f33bb94800a03f1f4df13a4f38',
      client_secret: 'f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76',
      timezone: 'UTC',
      auth_url: 'https://auth-api.8slp.net/v1/tokens',
      client_api_url: 'https://client-api.8slp.net/v1',
      start_date: '2010-01-01',
      overlap_days: 2,
    },
    plugins: {},
  };

  return {
    ...cfg,
    ...overrides,
    app: { ...cfg.app, ...(overrides.app || {}) },
    oura: { ...cfg.oura, ...(overrides.oura || {}) },
    withings: { ...cfg.withings, ...(overrides.withings || {}) },
    hevy: { ...cfg.hevy, ...(overrides.hevy || {}) },
    strava: { ...cfg.strava, ...(overrides.strava || {}) },
    whoop: { ...cfg.whoop, ...(overrides.whoop || {}) },
    eightsleep: { ...cfg.eightsleep, ...(overrides.eightsleep || {}) },
    plugins: { ...(cfg.plugins || {}), ...(overrides.plugins || {}) },
  };
}

export function withFetchMock(t, impl) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

export function readSearchParam(input, key) {
  const url = input instanceof URL ? input : new URL(String(input));
  return url.searchParams.get(key);
}
