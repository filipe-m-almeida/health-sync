import crypto from 'node:crypto';
import {
  dtToIsoZ,
  oauthListenForCode,
  openInBrowser,
  requestJson,
  sha256Hex,
  toEpochSeconds,
  utcNowIso,
} from '../util.js';

const WHOOP_DEFAULT_AUTHORIZE = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_DEFAULT_TOKEN = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_DEFAULT_API_BASE = 'https://api.prod.whoop.com/developer';

const WHOOP_DEFAULT_SCOPES = [
  'offline',
  'read:recovery',
  'read:cycles',
  'read:workout',
  'read:sleep',
  'read:profile',
  'read:body_measurement',
];

const COLLECTION_ENDPOINTS = {
  cycles: '/v2/cycle',
  recoveries: '/v2/recovery',
  sleep: '/v2/activity/sleep',
  workouts: '/v2/activity/workout',
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

function whoopScopes(rawScopes) {
  const parts = String(rawScopes || '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const source = parts.length ? parts : WHOOP_DEFAULT_SCOPES;

  const seen = new Set();
  const out = [];

  for (const scope of source) {
    if (!seen.has(scope)) {
      seen.add(scope);
      out.push(scope);
    }
  }
  return out;
}

function whoopScopeString(rawScopes) {
  return whoopScopes(rawScopes).join(' ');
}

function parseIntSafe(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function clampPageSize(rawPageSize) {
  return Math.max(1, Math.min(25, parseIntSafe(rawPageSize ?? 25, 25)));
}

function overlapDays(rawOverlapDays) {
  return Math.max(0, parseIntSafe(rawOverlapDays ?? 7, 7));
}

function defaultStartDate(cfg) {
  return String(cfg.start_date || '2010-01-01');
}

function whoopApiBase(cfg) {
  const raw = String(cfg.api_base_url || WHOOP_DEFAULT_API_BASE).trim();
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function chooseRecords(payload) {
  if (Array.isArray(payload?.records)) {
    return payload.records;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  return [];
}

function chooseNextToken(payload) {
  if (typeof payload?.next_token === 'string' && payload.next_token.trim()) {
    return payload.next_token;
  }
  if (typeof payload?.nextToken === 'string' && payload.nextToken.trim()) {
    return payload.nextToken;
  }
  return null;
}

function collectionRecordId(resource, item) {
  if (item?.id !== null && item?.id !== undefined) {
    return String(item.id);
  }
  if (resource === 'recoveries' && item?.cycle_id !== null && item?.cycle_id !== undefined) {
    return String(item.cycle_id);
  }
  return sha256Hex(JSON.stringify(item));
}

function collectionStartTime(item) {
  return item?.start || item?.created_at || item?.updated_at || null;
}

function collectionEndTime(item) {
  return item?.end || null;
}

function collectionUpdatedAt(item) {
  return item?.updated_at || item?.created_at || collectionStartTime(item);
}

function startIsoForCollection(cfg) {
  const fallback = `${defaultStartDate(cfg)}T00:00:00Z`;
  const anchorDate = new Date(fallback);
  if (Number.isNaN(anchorDate.getTime())) {
    return fallback;
  }
  anchorDate.setUTCDate(anchorDate.getUTCDate() - overlapDays(cfg.overlap_days));
  return dtToIsoZ(anchorDate) || fallback;
}

function initialWatermarkEpoch(db, cfg, resource) {
  const state = db.getSyncState('whoop', resource);
  const fromState = toEpochSeconds(state?.watermark);
  if (fromState !== null) {
    return fromState;
  }
  const fromConfig = toEpochSeconds(defaultStartDate(cfg));
  if (fromConfig !== null) {
    return fromConfig;
  }
  return 0;
}

async function whoopAuth(db, config, helpers, options = {}) {
  const cfg = helpers.configFor('whoop');
  const clientId = helpers.requireStr('whoop', 'client_id', 'Missing [whoop].client_id');
  const clientSecret = helpers.requireStr('whoop', 'client_secret', 'Missing [whoop].client_secret');
  const redirectUri = helpers.requireStr('whoop', 'redirect_uri', 'Missing [whoop].redirect_uri');

  const redirect = parseRedirectConfig(redirectUri);
  const listenHost = options.listenHost || redirect.host || '127.0.0.1';
  const listenPort = Number.isFinite(options.listenPort) && Number(options.listenPort) > 0
    ? Number(options.listenPort)
    : redirect.port;

  const state = randomState();
  const scopes = whoopScopeString(cfg.scopes);
  const authUrl = new URL(cfg.authorize_url || WHOOP_DEFAULT_AUTHORIZE);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirect.uri);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);

  openInBrowser(authUrl.toString());
  console.log(`Open this URL to authorize WHOOP: ${authUrl.toString()}`);

  const callback = await oauthListenForCode({
    listenHost,
    listenPort,
    callbackPath: redirect.path,
    timeoutSeconds: 300,
    allowManualCodeEntry: Boolean(options.allowManualCodeEntry),
    onStatus: (line) => console.log(line),
  });

  if (callback.error) {
    throw new Error(`WHOOP OAuth error: ${callback.error}`);
  }
  if (!callback.code) {
    throw new Error('WHOOP OAuth did not return an authorization code');
  }
  if (callback.state && callback.state !== state) {
    throw new Error('WHOOP OAuth state mismatch');
  }

  const tokenPayload = await requestJson(cfg.token_url || WHOOP_DEFAULT_TOKEN, {
    method: 'POST',
    data: {
      grant_type: 'authorization_code',
      code: callback.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect.uri,
    },
  });

  if (!tokenPayload?.access_token) {
    throw new Error(`WHOOP token response is missing access_token: ${JSON.stringify(tokenPayload)}`);
  }

  const expiresIn = parseIntSafe(tokenPayload.expires_in ?? 0, 0);
  const expiresAt = expiresIn > 0 ? dtToIsoZ(new Date(Date.now() + expiresIn * 1000)) : null;

  db.setOAuthToken('whoop', {
    accessToken: String(tokenPayload.access_token),
    refreshToken: tokenPayload.refresh_token || null,
    tokenType: tokenPayload.token_type || 'Bearer',
    scope: tokenPayload.scope || scopes,
    expiresAt,
    extra: {
      method: 'oauth',
    },
  });

  if (!tokenPayload.refresh_token) {
    console.log(
      'WHOOP authorization succeeded, but no refresh token was returned. '
      + 'Ensure [whoop].scopes includes `offline` and re-run auth if needed.',
    );
    return;
  }

  console.log('WHOOP authorization succeeded.');
}

async function whoopRefreshIfNeeded(db, cfg) {
  const token = db.getOAuthToken('whoop');
  if (!token) {
    throw new Error('WHOOP token not found. Run `health-sync auth whoop`.');
  }
  if (!tokenExpiredSoon(token.expiresAt)) {
    return token.accessToken;
  }

  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error('WHOOP token expired and missing [whoop].client_id/client_secret for refresh.');
  }
  if (!token.refreshToken) {
    throw new Error(
      'WHOOP refresh_token is missing. Ensure [whoop].scopes includes `offline` '
      + 'and re-run `health-sync auth whoop`.',
    );
  }

  let refreshed;
  try {
    refreshed = await requestJson(cfg.token_url || WHOOP_DEFAULT_TOKEN, {
      method: 'POST',
      data: {
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        scope: 'offline',
      },
    });
  } catch (err) {
    const detail = err?.body?.error || err?.body?.error_description || err?.message || String(err);
    if (String(detail).includes('invalid_grant') || String(detail).includes('invalid_request')) {
      throw new Error(`WHOOP refresh failed (${detail}). Re-run \`health-sync auth whoop\`.`);
    }
    throw err;
  }

  if (!refreshed?.access_token) {
    throw new Error(`WHOOP refresh response is missing access_token: ${JSON.stringify(refreshed)}`);
  }

  const expiresIn = parseIntSafe(refreshed.expires_in ?? 0, 0);
  const expiresAt = expiresIn > 0 ? dtToIsoZ(new Date(Date.now() + expiresIn * 1000)) : null;

  db.setOAuthToken('whoop', {
    accessToken: String(refreshed.access_token),
    refreshToken: refreshed.refresh_token || token.refreshToken,
    tokenType: refreshed.token_type || token.tokenType || 'Bearer',
    scope: refreshed.scope || token.scope,
    expiresAt,
    extra: {
      method: 'oauth',
    },
  });

  return String(refreshed.access_token);
}

async function syncSingleResource(db, cfg, token, resource, endpoint) {
  await db.syncRun('whoop', resource, async () => {
    await db.transaction(async () => {
      const payload = await requestJson(`${whoopApiBase(cfg)}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const sourceUpdatedAt = payload?.updated_at || utcNowIso();
      const recordId = payload?.user_id !== undefined && payload?.user_id !== null
        ? String(payload.user_id)
        : 'me';

      db.upsertRecord({
        provider: 'whoop',
        resource,
        recordId,
        startTime: payload?.created_at || null,
        endTime: null,
        sourceUpdatedAt,
        payload,
      });

      db.setSyncState('whoop', resource, {
        watermark: utcNowIso(),
      });
    });
  });
}

async function syncCollectionResource(db, cfg, token, resource, endpoint) {
  await db.syncRun('whoop', resource, async () => {
    await db.transaction(async () => {
      const syncStartedAt = utcNowIso();
      const paramsBase = {
        limit: clampPageSize(cfg.page_size),
        start: startIsoForCollection(cfg),
        end: syncStartedAt,
      };

      let nextToken = null;
      let maxEpoch = initialWatermarkEpoch(db, cfg, resource);
      const seenRecordIds = new Set();

      do {
        const payload = await requestJson(`${whoopApiBase(cfg)}${endpoint}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          params: {
            ...paramsBase,
            ...(nextToken ? { nextToken } : {}),
          },
        });

        for (const item of chooseRecords(payload)) {
          const recordId = collectionRecordId(resource, item);
          seenRecordIds.add(recordId);
          const startTime = collectionStartTime(item);
          const sourceUpdatedAt = collectionUpdatedAt(item);

          db.upsertRecord({
            provider: 'whoop',
            resource,
            recordId,
            startTime,
            endTime: collectionEndTime(item),
            sourceUpdatedAt,
            payload: item,
          });

          const epoch = toEpochSeconds(sourceUpdatedAt || startTime);
          if (epoch !== null) {
            maxEpoch = Math.max(maxEpoch, epoch);
          }
        }

        nextToken = chooseNextToken(payload);
      } while (nextToken);

      const existingRows = db.conn.prepare(`
        SELECT record_id
        FROM records
        WHERE provider = 'whoop' AND resource = ?
      `).all(resource);
      for (const row of existingRows) {
        if (!seenRecordIds.has(row.record_id)) {
          db.deleteRecord('whoop', resource, row.record_id, { provider: 'whoop', resource });
        }
      }

      db.setSyncState('whoop', resource, {
        watermark: dtToIsoZ(new Date(maxEpoch * 1000)),
      });
    });
  });
}

async function whoopSync(db, config, helpers) {
  const cfg = helpers.configFor('whoop');
  const token = await whoopRefreshIfNeeded(db, cfg);

  await syncSingleResource(db, cfg, token, 'profile_basic', '/v2/user/profile/basic');
  await syncSingleResource(db, cfg, token, 'body_measurement', '/v2/user/measurement/body');

  for (const [resource, endpoint] of Object.entries(COLLECTION_ENDPOINTS)) {
    await syncCollectionResource(db, cfg, token, resource, endpoint);
  }
}

const whoopProvider = {
  id: 'whoop',
  source: 'builtin',
  description: 'WHOOP profile, body measurements, cycles, recoveries, sleep, and workouts',
  supportsAuth: true,
  auth: whoopAuth,
  sync: whoopSync,
};

export default whoopProvider;
