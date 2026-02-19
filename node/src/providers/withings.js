import crypto from 'node:crypto';
import {
  dtToIsoZ,
  hmacSha256Hex,
  oauthListenForCode,
  openInBrowser,
  requestJson,
  sha256Hex,
  toEpochSeconds,
  utcNowIso,
} from '../util.js';

const WITHINGS_AUTHORIZE = 'https://account.withings.com/oauth2_user/authorize2';
const WITHINGS_TOKEN = 'https://wbsapi.withings.net/v2/oauth2';
const WITHINGS_SIGNATURE = 'https://wbsapi.withings.net/v2/signature';
const WITHINGS_MEASURE = 'https://wbsapi.withings.net/measure';
const WITHINGS_MEASURE_V2 = 'https://wbsapi.withings.net/v2/measure';
const WITHINGS_SLEEP_V2 = 'https://wbsapi.withings.net/v2/sleep';

const DEFAULT_MEASTYPES = [
  '1', '4', '5', '6', '8', '9', '10', '11', '12',
  '54', '71', '73', '76', '77', '88', '91', '123',
];

const ACTIVITY_FIELDS = [
  'steps', 'distance', 'elevation',
  'soft', 'moderate', 'intense', 'active',
  'calories', 'totalcalories',
  'hr_average', 'hr_min', 'hr_max',
  'hr_zone_0', 'hr_zone_1', 'hr_zone_2', 'hr_zone_3',
];

const WORKOUT_FIELDS = [
  'calories', 'effduration', 'intensity',
  'manual_distance', 'manual_calories',
  'hr_average', 'hr_min', 'hr_max',
  'hr_zone_0', 'hr_zone_1', 'hr_zone_2', 'hr_zone_3',
  'pause_duration', 'algo_pause_duration',
  'spo2_average', 'steps', 'distance', 'elevation',
  'pool_laps', 'strokes', 'pool_length',
];

const SLEEP_SUMMARY_FIELDS = [
  'sleep_score',
  'lightsleepduration', 'deepsleepduration', 'remsleepduration',
  'wakeupcount', 'wakeupduration', 'durationtosleep', 'durationtowakeup',
  'hr_average', 'hr_min', 'hr_max',
  'rr_average', 'rr_min', 'rr_max',
  'snoring', 'snoringepisodecount', 'breathing_disturbances_intensity',
];

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

function withingsScopes(rawScopes) {
  const seen = new Set();
  const out = [];
  const parts = String(rawScopes || 'user.metrics,user.activity')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const scope of parts) {
    const normalized = scope === 'user.sleep' ? 'user.activity' : scope;
    if (scope === 'user.sleep') {
      console.log('Replacing deprecated Withings scope user.sleep with user.activity');
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }

  if (!out.includes('user.metrics')) {
    out.unshift('user.metrics');
  }
  if (!out.includes('user.activity')) {
    out.push('user.activity');
  }
  return out;
}

function withingsHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

function withingsSignatureFor(action, clientId, clientSecret, timestamp = null, nonce = null) {
  const parts = [action, clientId];
  if (timestamp !== null && timestamp !== undefined) {
    parts.push(String(timestamp));
  }
  if (nonce !== null && nonce !== undefined) {
    parts.push(String(nonce));
  }
  return hmacSha256Hex(clientSecret, parts.join(','));
}

function toIsoFromEpoch(epoch) {
  if (epoch === null || epoch === undefined) {
    return null;
  }
  const n = Number(epoch);
  if (!Number.isFinite(n)) {
    return null;
  }
  return dtToIsoZ(new Date(Math.floor(n) * 1000));
}

async function withingsNonce(clientId, clientSecret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = withingsSignatureFor('getnonce', clientId, clientSecret, timestamp, null);

  const j = await requestJson(WITHINGS_SIGNATURE, {
    method: 'POST',
    data: {
      action: 'getnonce',
      client_id: clientId,
      timestamp,
      signature,
    },
  });

  if (j?.status !== 0) {
    throw new Error(`Withings getnonce failed: ${JSON.stringify(j)}`);
  }
  const nonce = j?.body?.nonce;
  if (!nonce) {
    throw new Error('Withings getnonce response is missing nonce');
  }
  return String(nonce);
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

async function withingsRefreshIfNeeded(db, cfg) {
  const token = db.getOAuthToken('withings');
  if (!token) {
    throw new Error('Withings token not found. Run `health-sync auth withings`.');
  }
  if (!token.refreshToken || !token.expiresAt) {
    return token.accessToken;
  }
  if (!tokenExpiredSoon(token.expiresAt)) {
    return token.accessToken;
  }

  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error('Withings credentials are missing. Run `health-sync auth withings` after setting client_id/client_secret.');
  }

  const nonce = await withingsNonce(cfg.client_id, cfg.client_secret);
  const signature = withingsSignatureFor('requesttoken', cfg.client_id, cfg.client_secret, null, nonce);

  const j = await requestJson(WITHINGS_TOKEN, {
    method: 'POST',
    data: {
      action: 'requesttoken',
      grant_type: 'refresh_token',
      client_id: cfg.client_id,
      refresh_token: token.refreshToken,
      nonce,
      signature,
    },
  });

  if (j?.status !== 0 || !j?.body?.access_token) {
    throw new Error(`Withings token refresh failed: ${JSON.stringify(j)}`);
  }

  const body = j.body;
  const expiresIn = Number.parseInt(String(body.expires_in ?? 0), 10) || 0;
  const expiresAt = expiresIn > 0 ? dtToIsoZ(new Date(Date.now() + expiresIn * 1000)) : null;

  db.setOAuthToken('withings', {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token || token.refreshToken,
    tokenType: body.token_type || token.tokenType || 'Bearer',
    scope: body.scope || token.scope,
    expiresAt,
    extra: {
      method: 'oauth',
    },
  });

  return String(body.access_token);
}

async function withingsAuth(db, config, helpers, options = {}) {
  const cfg = helpers.configFor('withings');
  const clientId = helpers.requireStr('withings', 'client_id', 'Missing [withings].client_id');
  const clientSecret = helpers.requireStr('withings', 'client_secret', 'Missing [withings].client_secret');
  const redirectUri = helpers.requireStr('withings', 'redirect_uri', 'Missing [withings].redirect_uri');

  const scopes = withingsScopes(cfg.scopes);
  const redirect = parseRedirectConfig(redirectUri);

  const listenHost = options.listenHost || redirect.host || '127.0.0.1';
  const listenPort = Number.isFinite(options.listenPort) && Number(options.listenPort) > 0
    ? Number(options.listenPort)
    : redirect.port;

  const state = randomState();

  const authUrl = new URL(WITHINGS_AUTHORIZE);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scope', scopes.join(','));
  authUrl.searchParams.set('redirect_uri', redirect.uri);
  authUrl.searchParams.set('state', state);

  openInBrowser(authUrl.toString());
  console.log(`Open this URL to authorize Withings: ${authUrl.toString()}`);

  const callback = await oauthListenForCode({
    listenHost,
    listenPort,
    callbackPath: redirect.path,
    timeoutSeconds: 300,
    onStatus: (line) => console.log(line),
  });

  if (callback.error) {
    throw new Error(`Withings OAuth error: ${callback.error}`);
  }
  if (!callback.code) {
    throw new Error('Withings OAuth did not return an authorization code');
  }
  if (callback.state && callback.state !== state) {
    throw new Error('Withings OAuth state mismatch');
  }

  const nonce = await withingsNonce(clientId, clientSecret);
  const signature = withingsSignatureFor('requesttoken', clientId, clientSecret, null, nonce);

  const j = await requestJson(WITHINGS_TOKEN, {
    method: 'POST',
    data: {
      action: 'requesttoken',
      grant_type: 'authorization_code',
      client_id: clientId,
      code: callback.code,
      redirect_uri: redirect.uri,
      nonce,
      signature,
    },
  });

  if (j?.status !== 0 || !j?.body?.access_token) {
    throw new Error(`Withings token exchange failed: ${JSON.stringify(j)}`);
  }

  const body = j.body;
  const expiresIn = Number.parseInt(String(body.expires_in ?? 0), 10) || 0;
  const expiresAt = expiresIn > 0 ? dtToIsoZ(new Date(Date.now() + expiresIn * 1000)) : null;

  db.setOAuthToken('withings', {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token || null,
    tokenType: body.token_type || 'Bearer',
    scope: body.scope || scopes.join(','),
    expiresAt,
    extra: {
      method: 'oauth',
    },
  });

  console.log('Withings authorization succeeded.');
}

function watermarkEpoch(db, resource, overlapSeconds) {
  const state = db.getSyncState('withings', resource);
  const raw = state?.watermark;
  const epoch = raw ? toEpochSeconds(raw) : 0;
  return Math.max(0, (epoch || 0) - Math.max(0, overlapSeconds));
}

function setWatermarkEpoch(db, resource, epoch) {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const wm = Math.max(0, Number.parseInt(String(epoch ?? nowEpoch), 10) || nowEpoch);
  db.setSyncState('withings', resource, {
    watermark: dtToIsoZ(new Date(wm * 1000)),
  });
}

function serializeHashable(value) {
  return JSON.stringify(value);
}

function toSeriesArray(body) {
  if (Array.isArray(body?.series)) {
    return body.series;
  }
  if (Array.isArray(body?.activities)) {
    return body.activities;
  }
  if (Array.isArray(body?.sleepes)) {
    return body.sleepes;
  }
  return [];
}

async function syncMeasures(db, token, cfg) {
  await db.syncRun('withings', 'measures', async () => {
    await db.transaction(async () => {
      const overlapSeconds = Number.parseInt(String(cfg.overlap_seconds ?? 300), 10) || 300;
      const lastupdate = watermarkEpoch(db, 'measures', overlapSeconds);
      const meastypes = Array.isArray(cfg.meastypes) && cfg.meastypes.length ? cfg.meastypes : DEFAULT_MEASTYPES;

      let offset = 0;
      let maxWm = Math.floor(Date.now() / 1000);

      while (true) {
        const data = {
          action: 'getmeas',
          meastype: meastypes.join(','),
          category: '1',
          lastupdate,
        };
        if (offset > 0) {
          data.offset = offset;
        }

        const j = await requestJson(WITHINGS_MEASURE, {
          method: 'POST',
          headers: withingsHeaders(token),
          data,
        });

        if (j?.status !== 0) {
          throw new Error(`Withings measures sync failed: ${JSON.stringify(j)}`);
        }

        const body = j.body || {};
        const groups = Array.isArray(body.measuregrps) ? body.measuregrps : [];
        for (const grp of groups) {
          const recordId = grp?.grpid
            ? String(grp.grpid)
            : sha256Hex(serializeHashable(grp));
          const startTime = toIsoFromEpoch(grp?.date);
          const sourceUpdatedAt = toIsoFromEpoch(grp?.modified);

          db.upsertRecord({
            provider: 'withings',
            resource: 'measures',
            recordId,
            startTime,
            endTime: null,
            sourceUpdatedAt,
            payload: grp,
          });
        }

        const updatetime = Number.parseInt(String(body?.updatetime ?? 0), 10);
        if (Number.isFinite(updatetime) && updatetime > 0) {
          maxWm = Math.max(maxWm, updatetime);
        }

        if (!body?.more || body?.offset === undefined || body?.offset === null) {
          break;
        }
        offset = Number.parseInt(String(body.offset), 10) || 0;
        if (offset <= 0) {
          break;
        }
      }

      setWatermarkEpoch(db, 'measures', maxWm);
    });
  });
}

async function syncActivity(db, token, cfg) {
  await db.syncRun('withings', 'activity', async () => {
    await db.transaction(async () => {
      const overlapSeconds = Number.parseInt(String(cfg.overlap_seconds ?? 300), 10) || 300;
      const lastupdate = watermarkEpoch(db, 'activity', overlapSeconds);

      let offset = 0;
      const maxWm = Math.floor(Date.now() / 1000);

      while (true) {
        const data = {
          action: 'getactivity',
          lastupdate,
          data_fields: ACTIVITY_FIELDS.join(','),
        };
        if (offset > 0) {
          data.offset = offset;
        }

        const j = await requestJson(WITHINGS_MEASURE_V2, {
          method: 'POST',
          headers: withingsHeaders(token),
          data,
        });

        if (j?.status !== 0) {
          throw new Error(`Withings activity sync failed: ${JSON.stringify(j)}`);
        }

        const body = j.body || {};
        const activities = toSeriesArray(body);
        for (const act of activities) {
          const recordId = act?.date || act?.id || sha256Hex(serializeHashable(act));
          db.upsertRecord({
            provider: 'withings',
            resource: 'activity',
            recordId: String(recordId),
            startTime: act?.date || null,
            endTime: null,
            sourceUpdatedAt: null,
            payload: act,
          });
        }

        if (!body?.more || body?.offset === undefined || body?.offset === null) {
          break;
        }
        offset = Number.parseInt(String(body.offset), 10) || 0;
        if (offset <= 0) {
          break;
        }
      }

      setWatermarkEpoch(db, 'activity', maxWm);
    });
  });
}

async function syncWorkouts(db, token, cfg) {
  await db.syncRun('withings', 'workouts', async () => {
    await db.transaction(async () => {
      const overlapSeconds = Number.parseInt(String(cfg.overlap_seconds ?? 300), 10) || 300;
      const lastupdate = watermarkEpoch(db, 'workouts', overlapSeconds);

      let offset = 0;
      let maxWm = Math.floor(Date.now() / 1000);

      while (true) {
        const data = {
          action: 'getworkouts',
          lastupdate,
          data_fields: WORKOUT_FIELDS.join(','),
        };
        if (offset > 0) {
          data.offset = offset;
        }

        const j = await requestJson(WITHINGS_MEASURE_V2, {
          method: 'POST',
          headers: withingsHeaders(token),
          data,
        });

        if (j?.status !== 0) {
          throw new Error(`Withings workouts sync failed: ${JSON.stringify(j)}`);
        }

        const body = j.body || {};
        const workouts = toSeriesArray(body);
        for (const workout of workouts) {
          const recordId = workout?.id || workout?.startdate || sha256Hex(serializeHashable(workout));
          const modified = Number.parseInt(String(workout?.modified ?? 0), 10);
          if (Number.isFinite(modified) && modified > 0) {
            maxWm = Math.max(maxWm, modified);
          }

          db.upsertRecord({
            provider: 'withings',
            resource: 'workouts',
            recordId: String(recordId),
            startTime: toIsoFromEpoch(workout?.startdate),
            endTime: toIsoFromEpoch(workout?.enddate),
            sourceUpdatedAt: toIsoFromEpoch(workout?.modified),
            payload: workout,
          });
        }

        if (!body?.more || body?.offset === undefined || body?.offset === null) {
          break;
        }
        offset = Number.parseInt(String(body.offset), 10) || 0;
        if (offset <= 0) {
          break;
        }
      }

      setWatermarkEpoch(db, 'workouts', maxWm);
    });
  });
}

async function syncSleepSummary(db, token, cfg) {
  await db.syncRun('withings', 'sleep_summary', async () => {
    await db.transaction(async () => {
      const overlapSeconds = Number.parseInt(String(cfg.overlap_seconds ?? 300), 10) || 300;
      const lastupdate = watermarkEpoch(db, 'sleep_summary', overlapSeconds);

      let offset = 0;
      let maxWm = Math.floor(Date.now() / 1000);

      while (true) {
        const data = {
          action: 'getsummary',
          lastupdate,
          data_fields: SLEEP_SUMMARY_FIELDS.join(','),
        };
        if (offset > 0) {
          data.offset = offset;
        }

        const j = await requestJson(WITHINGS_SLEEP_V2, {
          method: 'POST',
          headers: withingsHeaders(token),
          data,
        });

        if (j?.status !== 0) {
          throw new Error(`Withings sleep summary sync failed: ${JSON.stringify(j)}`);
        }

        const body = j.body || {};
        const entries = toSeriesArray(body);
        for (const summary of entries) {
          const recordId = summary?.id || summary?.startdate || sha256Hex(serializeHashable(summary));
          const modified = Number.parseInt(String(summary?.modified ?? 0), 10);
          if (Number.isFinite(modified) && modified > 0) {
            maxWm = Math.max(maxWm, modified);
          }

          db.upsertRecord({
            provider: 'withings',
            resource: 'sleep_summary',
            recordId: String(recordId),
            startTime: toIsoFromEpoch(summary?.startdate),
            endTime: toIsoFromEpoch(summary?.enddate),
            sourceUpdatedAt: toIsoFromEpoch(summary?.modified),
            payload: summary,
          });
        }

        if (!body?.more || body?.offset === undefined || body?.offset === null) {
          break;
        }
        offset = Number.parseInt(String(body.offset), 10) || 0;
        if (offset <= 0) {
          break;
        }
      }

      setWatermarkEpoch(db, 'sleep_summary', maxWm);
    });
  });
}

async function withingsSync(db, config, helpers) {
  const cfg = helpers.configFor('withings');
  const accessToken = await withingsRefreshIfNeeded(db, cfg);
  await syncMeasures(db, accessToken, cfg);
  await syncActivity(db, accessToken, cfg);
  await syncWorkouts(db, accessToken, cfg);
  await syncSleepSummary(db, accessToken, cfg);
}

const withingsProvider = {
  id: 'withings',
  source: 'builtin',
  description: 'Withings measurements, activity, workouts, and sleep summaries',
  supportsAuth: true,
  auth: withingsAuth,
  sync: withingsSync,
};

export default withingsProvider;
