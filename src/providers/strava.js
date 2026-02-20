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

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

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

async function refreshTokenIfNeeded(db, cfgSection) {
  if (cfgSection.access_token) {
    db.setOAuthToken('strava', {
      accessToken: String(cfgSection.access_token),
      refreshToken: null,
      tokenType: 'Bearer',
      scope: cfgSection.scopes,
      expiresAt: null,
      extra: { method: 'static_access_token' },
    });
    return String(cfgSection.access_token);
  }

  const token = db.getOAuthToken('strava');
  if (!token) {
    throw new Error('Strava token not found. Run `health-sync auth strava` or set [strava].access_token.');
  }
  if (!token.refreshToken || !token.expiresAt) {
    return token.accessToken;
  }
  if (!tokenExpiredSoon(token.expiresAt)) {
    return token.accessToken;
  }

  if (!cfgSection.client_id || !cfgSection.client_secret) {
    throw new Error('Strava token expired and missing [strava].client_id/client_secret for refresh.');
  }

  const refreshed = await requestJson(STRAVA_TOKEN_URL, {
    method: 'POST',
    data: {
      client_id: cfgSection.client_id,
      client_secret: cfgSection.client_secret,
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
    },
  });

  const expiresAt = refreshed.expires_at
    ? dtToIsoZ(new Date(Number(refreshed.expires_at) * 1000))
    : null;

  db.setOAuthToken('strava', {
    accessToken: String(refreshed.access_token),
    refreshToken: refreshed.refresh_token || token.refreshToken,
    tokenType: refreshed.token_type || 'Bearer',
    scope: refreshed.scope || token.scope,
    expiresAt,
    extra: {
      athlete: refreshed.athlete || null,
      method: 'oauth',
    },
  });

  return String(refreshed.access_token);
}

async function stravaAuth(db, config, helpers, options = {}) {
  const cfg = helpers.configFor('strava');
  if (cfg.access_token) {
    db.setOAuthToken('strava', {
      accessToken: String(cfg.access_token),
      refreshToken: null,
      tokenType: 'Bearer',
      scope: cfg.scopes,
      expiresAt: null,
      extra: { method: 'static_access_token' },
    });
    console.log('Saved static Strava access token from config.');
    return;
  }

  const clientId = helpers.requireStr('strava', 'client_id', 'Missing [strava].client_id');
  const clientSecret = helpers.requireStr('strava', 'client_secret', 'Missing [strava].client_secret');
  const redirectUri = helpers.requireStr('strava', 'redirect_uri', 'Missing [strava].redirect_uri');
  const scopes = String(cfg.scopes || 'read,activity:read_all');
  const approvalPrompt = String(cfg.approval_prompt || 'auto');

  const redirect = parseRedirectConfig(redirectUri);
  const listenHost = options.listenHost || redirect.host || '127.0.0.1';
  const listenPort = Number.isFinite(options.listenPort) && Number(options.listenPort) > 0
    ? Number(options.listenPort)
    : redirect.port;

  const state = randomState();
  const authUrl = new URL(STRAVA_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirect.uri);
  authUrl.searchParams.set('approval_prompt', approvalPrompt);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);

  openInBrowser(authUrl.toString());
  console.log(`Open this URL to authorize Strava: ${authUrl.toString()}`);

  const callback = await oauthListenForCode({
    listenHost,
    listenPort,
    callbackPath: redirect.path,
    timeoutSeconds: 300,
    allowManualCodeEntry: Boolean(options.allowManualCodeEntry),
    onStatus: (line) => console.log(line),
  });

  if (callback.error) {
    throw new Error(`Strava OAuth error: ${callback.error}`);
  }
  if (!callback.code) {
    throw new Error('Strava OAuth did not return an authorization code');
  }
  if (callback.state && callback.state !== state) {
    throw new Error('Strava OAuth state mismatch');
  }

  const token = await requestJson(STRAVA_TOKEN_URL, {
    method: 'POST',
    data: {
      client_id: clientId,
      client_secret: clientSecret,
      code: callback.code,
      grant_type: 'authorization_code',
    },
  });

  const expiresAt = token.expires_at
    ? dtToIsoZ(new Date(Number(token.expires_at) * 1000))
    : null;

  db.setOAuthToken('strava', {
    accessToken: String(token.access_token),
    refreshToken: token.refresh_token || null,
    tokenType: token.token_type || 'Bearer',
    scope: token.scope || scopes,
    expiresAt,
    extra: {
      athlete: token.athlete || null,
      method: 'oauth',
    },
  });

  console.log('Strava authorization succeeded.');
}

async function syncAthlete(db, token) {
  await db.syncRun('strava', 'athlete', async () => {
    await db.transaction(async () => {
      const payload = await requestJson(`${STRAVA_API_BASE}/athlete`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const recordId = payload?.id ? String(payload.id) : 'me';
      db.upsertRecord({
        provider: 'strava',
        resource: 'athlete',
        recordId,
        sourceUpdatedAt: utcNowIso(),
        payload,
      });

      db.setSyncState('strava', 'athlete', { watermark: utcNowIso() });
    });
  });
}

async function syncActivities(db, token, cfg) {
  await db.syncRun('strava', 'activities', async () => {
    await db.transaction(async () => {
      const pageSize = Math.max(1, Math.min(200, Number.parseInt(String(cfg.page_size ?? 100), 10) || 100));
      const overlapSeconds = Math.max(0, Number.parseInt(String(cfg.overlap_seconds ?? 604800), 10) || 0);

      const state = db.getSyncState('strava', 'activities');
      const existingWatermarkEpoch = state?.watermark ? toEpochSeconds(state.watermark) : null;
      const startDateEpoch = toEpochSeconds(cfg.start_date || '2010-01-01') || 0;

      const afterEpoch = existingWatermarkEpoch === null
        ? startDateEpoch
        : Math.max(0, existingWatermarkEpoch - overlapSeconds);

      let page = 1;
      let maxStartEpoch = existingWatermarkEpoch === null ? afterEpoch : existingWatermarkEpoch;

      while (true) {
        const batch = await requestJson(`${STRAVA_API_BASE}/athlete/activities`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          params: {
            after: afterEpoch,
            page,
            per_page: pageSize,
          },
        });

        const activities = Array.isArray(batch) ? batch : [];
        for (const item of activities) {
          const recordId = item?.id ? String(item.id) : sha256Hex(JSON.stringify(item));
          const startTime = item?.start_date || null;
          const startEpoch = toEpochSeconds(startTime);
          if (startEpoch !== null) {
            maxStartEpoch = Math.max(maxStartEpoch ?? startEpoch, startEpoch);
          }
          db.upsertRecord({
            provider: 'strava',
            resource: 'activities',
            recordId,
            startTime,
            endTime: null,
            sourceUpdatedAt: item?.updated_at || startTime,
            payload: item,
          });
        }

        if (activities.length < pageSize) {
          break;
        }
        page += 1;
      }

      if (maxStartEpoch !== null) {
        db.setSyncState('strava', 'activities', {
          watermark: dtToIsoZ(new Date(maxStartEpoch * 1000)),
        });
      }
    });
  });
}

async function stravaSync(db, config, helpers) {
  const cfg = helpers.configFor('strava');
  const token = await refreshTokenIfNeeded(db, cfg);
  await syncAthlete(db, token);
  await syncActivities(db, token, cfg);
}

const stravaProvider = {
  id: 'strava',
  source: 'builtin',
  description: 'Strava athlete profile and activities',
  supportsAuth: true,
  auth: stravaAuth,
  sync: stravaSync,
};

export default stravaProvider;
