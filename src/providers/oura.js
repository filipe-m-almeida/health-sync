import crypto from 'node:crypto';
import {
  basicAuthHeader,
  dtToIsoZ,
  oauthListenForCode,
  openInBrowser,
  requestJson,
  sha256Hex,
  utcNowIso,
} from '../util.js';

const OURA_BASE = 'https://api.ouraring.com';
const OURA_DEFAULT_AUTHORIZE = 'https://moi.ouraring.com/oauth/v2/ext/oauth-authorize';
const OURA_DEFAULT_TOKEN = 'https://moi.ouraring.com/oauth/v2/ext/oauth-token';

const DATE_WINDOW_RESOURCES = {
  daily_activity: '/v2/usercollection/daily_activity',
  daily_sleep: '/v2/usercollection/daily_sleep',
  daily_readiness: '/v2/usercollection/daily_readiness',
  sleep: '/v2/usercollection/sleep',
  workout: '/v2/usercollection/workout',
};

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

function parseRedirectConfig(redirectUri) {
  const parsed = new URL(redirectUri);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname || '/callback',
    uri: parsed.toString(),
  };
}

function ymdUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function tokenExpiredSoon(expiresAtIso, skewSeconds = 60) {
  if (!expiresAtIso) {
    return true;
  }
  const expiryMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiryMs)) {
    return true;
  }
  return expiryMs <= (Date.now() + skewSeconds * 1000);
}

function tokenExtra(raw, endpoint, issuer = null, discoveryUrl = null) {
  const extra = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (['access_token', 'refresh_token', 'token_type', 'scope', 'expires_in'].includes(key)) {
      continue;
    }
    extra[key] = value;
  }
  extra.token_endpoint = endpoint;
  if (issuer) {
    extra.issuer = issuer;
  }
  if (discoveryUrl) {
    extra.oidc_discovery_url = discoveryUrl;
  }
  return extra;
}

function mergeTokenExtra(existingExtra, freshExtra) {
  return {
    ...(existingExtra || {}),
    ...(freshExtra || {}),
  };
}

function oidcDiscoveryUrls(issuer) {
  if (!issuer || typeof issuer !== 'string') {
    return [];
  }
  const normalized = issuer.replace(/\/$/, '');
  const urls = [`${normalized}/.well-known/openid-configuration`];
  if (normalized.endsWith('/oauth-anonymous')) {
    const parent = normalized.slice(0, -'/oauth-anonymous'.length);
    urls.push(`${parent}/.well-known/openid-configuration`);
  }
  return [...new Set(urls)];
}

async function ouraDiscoverEndpoints(issuer) {
  for (const discoveryUrl of oidcDiscoveryUrls(issuer)) {
    try {
      const doc = await requestJson(discoveryUrl);
      if (doc?.token_endpoint) {
        return {
          tokenEndpoint: String(doc.token_endpoint),
          discoveryUrl,
          issuer,
        };
      }
    } catch {
      // Continue to fallback URLs.
    }
  }
  return null;
}

async function ouraResolveTokenEndpoint(cfg, tokenExtraJson = null, issuerHint = null) {
  if (tokenExtraJson?.token_endpoint) {
    return {
      tokenEndpoint: String(tokenExtraJson.token_endpoint),
      issuer: tokenExtraJson.issuer || issuerHint || null,
      discoveryUrl: tokenExtraJson.oidc_discovery_url || null,
    };
  }

  const issuer = issuerHint || tokenExtraJson?.issuer || null;
  if (issuer) {
    const discovered = await ouraDiscoverEndpoints(String(issuer));
    if (discovered) {
      return discovered;
    }
  }

  return {
    tokenEndpoint: String(cfg.token_url || OURA_DEFAULT_TOKEN),
    issuer,
    discoveryUrl: null,
  };
}

function oauthHeaders(clientId, clientSecret) {
  return {
    Authorization: basicAuthHeader(clientId, clientSecret),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function chooseArray(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (Array.isArray(payload?.result)) {
    return payload.result;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  return [];
}

function dateWindowRecordId(item) {
  return String(item?.id || item?.day || item?.timestamp || sha256Hex(JSON.stringify(item)));
}

function dateWindowStart(item) {
  return item?.day || item?.start_datetime || item?.timestamp || item?.start_time || null;
}

function dateWindowEnd(item) {
  return item?.end_datetime || item?.end_time || null;
}

function dateWindowUpdated(item) {
  return item?.updated_at || item?.modified_at || item?.timestamp || null;
}

function heartrateRecordId(item) {
  return String(item?.id || item?.timestamp || item?.time || item?.datetime || sha256Hex(JSON.stringify(item)));
}

function heartrateTimestamp(item) {
  return item?.timestamp || item?.time || item?.datetime || null;
}

async function ouraFetchAll(pathname, accessToken, params) {
  const out = [];
  let nextToken = null;

  do {
    const requestParams = { ...params };
    if (nextToken) {
      requestParams.next_token = nextToken;
    }

    const payload = await requestJson(`${OURA_BASE}${pathname}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params: requestParams,
    });

    out.push(...chooseArray(payload));
    nextToken = payload?.next_token || null;
  } while (nextToken);

  return out;
}

async function ouraRefreshIfNeeded(db, cfg) {
  const token = db.getOAuthToken('oura');
  if (!token) {
    throw new Error('Oura token not found. Run `health-sync auth oura`.');
  }
  if (!tokenExpiredSoon(token.expiresAt)) {
    return token.accessToken;
  }

  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error('Oura token expired and missing [oura].client_id/client_secret for refresh.');
  }
  if (!token.refreshToken) {
    throw new Error('Oura refresh_token is missing. Re-run `health-sync auth oura`.');
  }

  const resolved = await ouraResolveTokenEndpoint(cfg, token.extra || null, null);

  let refreshed;
  try {
    refreshed = await requestJson(resolved.tokenEndpoint, {
      method: 'POST',
      headers: oauthHeaders(cfg.client_id, cfg.client_secret),
      data: {
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      },
    });
  } catch (err) {
    const detail = err?.body?.error || err?.body?.error_description || err?.message || String(err);
    if (detail.includes('invalid_grant') || detail.includes('invalid_request')) {
      throw new Error(`Oura refresh failed (${detail}). Re-run \`health-sync auth oura\`.`);
    }
    throw err;
  }

  if (!refreshed?.access_token) {
    throw new Error(`Oura refresh response is missing access_token: ${JSON.stringify(refreshed)}`);
  }

  const expiresIn = Number.parseInt(String(refreshed.expires_in ?? 0), 10) || 0;
  const expiresAt = expiresIn > 0 ? dtToIsoZ(new Date(Date.now() + expiresIn * 1000)) : null;

  const newExtra = tokenExtra(refreshed, resolved.tokenEndpoint, resolved.issuer, resolved.discoveryUrl);
  db.setOAuthToken('oura', {
    accessToken: String(refreshed.access_token),
    refreshToken: refreshed.refresh_token || token.refreshToken,
    tokenType: refreshed.token_type || token.tokenType || 'Bearer',
    scope: refreshed.scope || token.scope,
    expiresAt,
    extra: mergeTokenExtra(token.extra, newExtra),
  });

  return String(refreshed.access_token);
}

async function ouraAuth(db, config, helpers, options = {}) {
  const cfg = helpers.configFor('oura');
  const clientId = helpers.requireStr('oura', 'client_id', 'Missing [oura].client_id');
  const clientSecret = helpers.requireStr('oura', 'client_secret', 'Missing [oura].client_secret');
  const redirectUri = helpers.requireStr('oura', 'redirect_uri', 'Missing [oura].redirect_uri');

  const redirect = parseRedirectConfig(redirectUri);
  const listenHost = options.listenHost || redirect.host || '127.0.0.1';
  const listenPort = Number.isFinite(options.listenPort) && Number(options.listenPort) > 0
    ? Number(options.listenPort)
    : redirect.port;

  const state = randomState();

  const authUrl = new URL(cfg.authorize_url || OURA_DEFAULT_AUTHORIZE);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirect.uri);
  authUrl.searchParams.set('scope', String(cfg.scopes || ''));
  authUrl.searchParams.set('state', state);

  openInBrowser(authUrl.toString());
  console.log(`Open this URL to authorize Oura: ${authUrl.toString()}`);

  const callback = await oauthListenForCode({
    listenHost,
    listenPort,
    callbackPath: redirect.path,
    timeoutSeconds: 300,
    allowManualCodeEntry: Boolean(options.allowManualCodeEntry),
    onStatus: (line) => console.log(line),
  });

  if (callback.error) {
    throw new Error(`Oura OAuth error: ${callback.error}`);
  }
  if (!callback.code) {
    throw new Error('Oura OAuth did not return an authorization code');
  }
  if (callback.state && callback.state !== state) {
    throw new Error('Oura OAuth state mismatch');
  }

  const resolved = await ouraResolveTokenEndpoint(cfg, null, callback.issuer || null);

  const tokenPayload = await requestJson(resolved.tokenEndpoint, {
    method: 'POST',
    headers: oauthHeaders(clientId, clientSecret),
    data: {
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: redirect.uri,
    },
  });

  if (!tokenPayload?.access_token) {
    throw new Error(`Oura token response is missing access_token: ${JSON.stringify(tokenPayload)}`);
  }

  const expiresIn = Number.parseInt(String(tokenPayload.expires_in ?? 0), 10) || 0;
  const expiresAt = expiresIn > 0 ? dtToIsoZ(new Date(Date.now() + expiresIn * 1000)) : null;

  db.setOAuthToken('oura', {
    accessToken: String(tokenPayload.access_token),
    refreshToken: tokenPayload.refresh_token || null,
    tokenType: tokenPayload.token_type || 'Bearer',
    scope: tokenPayload.scope || cfg.scopes,
    expiresAt,
    extra: tokenExtra(tokenPayload, resolved.tokenEndpoint, resolved.issuer, resolved.discoveryUrl),
  });

  console.log('Oura authorization succeeded.');
}

function startDateForResource(db, cfg, resource) {
  const overlapDays = Math.max(0, Number.parseInt(String(cfg.overlap_days ?? 7), 10) || 7);
  const state = db.getSyncState('oura', resource);
  if (!state?.watermark) {
    return String(cfg.start_date || '2010-01-01');
  }

  const wmDate = new Date(state.watermark);
  if (Number.isNaN(wmDate.getTime())) {
    return String(cfg.start_date || '2010-01-01');
  }

  const dateOnly = new Date(Date.UTC(
    wmDate.getUTCFullYear(),
    wmDate.getUTCMonth(),
    wmDate.getUTCDate(),
    0,
    0,
    0,
  ));
  dateOnly.setUTCDate(dateOnly.getUTCDate() - overlapDays);
  return ymdUtc(dateOnly);
}

async function syncPersonalInfo(db, token) {
  await db.syncRun('oura', 'personal_info', async () => {
    await db.transaction(async () => {
      const payload = await requestJson(`${OURA_BASE}/v2/usercollection/personal_info`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      db.upsertRecord({
        provider: 'oura',
        resource: 'personal_info',
        recordId: 'me',
        startTime: null,
        endTime: null,
        sourceUpdatedAt: null,
        payload,
      });

      db.setSyncState('oura', 'personal_info', {
        watermark: utcNowIso(),
      });
    });
  });
}

async function syncDateWindowResource(db, token, cfg, resource, endpoint) {
  await db.syncRun('oura', resource, async () => {
    await db.transaction(async () => {
      const startDate = startDateForResource(db, cfg, resource);
      let endDate = ymdUtc(new Date());
      if (resource === 'sleep') {
        endDate = ymdUtc(addDays(new Date(), 1));
      }

      const entries = await ouraFetchAll(endpoint, token, {
        start_date: startDate,
        end_date: endDate,
      });

      for (const item of entries) {
        db.upsertRecord({
          provider: 'oura',
          resource,
          recordId: dateWindowRecordId(item),
          startTime: dateWindowStart(item),
          endTime: dateWindowEnd(item),
          sourceUpdatedAt: dateWindowUpdated(item),
          payload: item,
        });
      }

      db.setSyncState('oura', resource, {
        watermark: utcNowIso(),
      });
    });
  });
}

async function syncHeartrate(db, token, cfg) {
  await db.syncRun('oura', 'heartrate', async () => {
    await db.transaction(async () => {
      const now = new Date();
      const chunkDays = 30;

      const maxStart = db.getMaxRecordStartTime('oura', 'heartrate');
      let cursor = maxStart ? new Date(maxStart) : new Date(`${cfg.start_date || '2010-01-01'}T00:00:00Z`);
      if (Number.isNaN(cursor.getTime())) {
        cursor = new Date('2010-01-01T00:00:00Z');
      }
      cursor = addDays(cursor, -1);

      while (cursor < now) {
        const chunkEnd = new Date(cursor.getTime());
        chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays);
        if (chunkEnd > now) {
          chunkEnd.setTime(now.getTime());
        }

        const entries = await ouraFetchAll('/v2/usercollection/heartrate', token, {
          start_datetime: dtToIsoZ(cursor),
          end_datetime: dtToIsoZ(chunkEnd),
        });

        for (const item of entries) {
          const ts = heartrateTimestamp(item);
          db.upsertRecord({
            provider: 'oura',
            resource: 'heartrate',
            recordId: heartrateRecordId(item),
            startTime: ts,
            endTime: null,
            sourceUpdatedAt: ts,
            payload: item,
          });
        }

        cursor = addDays(chunkEnd, 0);
        cursor.setUTCSeconds(cursor.getUTCSeconds() + 1);
      }

      db.setSyncState('oura', 'heartrate', {
        watermark: utcNowIso(),
      });
    });
  });
}

async function ouraSync(db, config, helpers) {
  const cfg = helpers.configFor('oura');
  const token = await ouraRefreshIfNeeded(db, cfg);

  await syncPersonalInfo(db, token);
  for (const [resource, endpoint] of Object.entries(DATE_WINDOW_RESOURCES)) {
    await syncDateWindowResource(db, token, cfg, resource, endpoint);
  }
  await syncHeartrate(db, token, cfg);
}

const ouraProvider = {
  id: 'oura',
  source: 'builtin',
  description: 'Oura daily data, sleep/workout collections, heartrate, and personal info',
  supportsAuth: true,
  auth: ouraAuth,
  sync: ouraSync,
};

export default ouraProvider;
