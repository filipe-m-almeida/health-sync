import {
  parseYYYYMMDD,
  requestJson,
  sha256Hex,
  utcNowIso,
} from '../util.js';

function dateToYYYYMMDD(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isoToDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

function tokenExtra(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (key === 'access_token' || key === 'expires_in') {
      continue;
    }
    out[key] = value;
  }
  return out;
}

async function eightsleepRefreshIfNeeded(db, cfg) {
  if (cfg.access_token) {
    db.setOAuthToken('eightsleep', {
      accessToken: String(cfg.access_token),
      refreshToken: null,
      tokenType: 'Bearer',
      scope: null,
      expiresAt: null,
      extra: { method: 'static_access_token' },
    });
    return String(cfg.access_token);
  }

  const existing = db.getOAuthToken('eightsleep');
  if (existing && !tokenExpiredSoon(existing.expiresAt)) {
    return existing.accessToken;
  }

  if (!cfg.email || !cfg.password) {
    throw new Error('Missing [eightsleep].email or [eightsleep].password, or provide [eightsleep].access_token.');
  }

  const tokenPayload = await requestJson(cfg.auth_url || 'https://auth-api.8slp.net/v1/tokens', {
    method: 'POST',
    json: {
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      grant_type: 'password',
      username: cfg.email,
      password: cfg.password,
    },
  });

  if (!tokenPayload?.access_token) {
    throw new Error(`Eight Sleep auth failed: ${JSON.stringify(tokenPayload)}`);
  }

  const expiresIn = Number.parseInt(String(tokenPayload.expires_in ?? 0), 10) || 0;
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;

  db.setOAuthToken('eightsleep', {
    accessToken: String(tokenPayload.access_token),
    refreshToken: null,
    tokenType: tokenPayload.token_type || 'Bearer',
    scope: tokenPayload.scope || null,
    expiresAt,
    extra: tokenExtra(tokenPayload),
  });

  return String(tokenPayload.access_token);
}

function trendsFromDate(db, cfg) {
  const overlapDays = Math.max(0, Number.parseInt(String(cfg.overlap_days ?? 2), 10) || 0);
  const state = db.getSyncState('eightsleep', 'trends');
  if (!state?.watermark) {
    return String(cfg.start_date || '2010-01-01');
  }

  const wmDate = isoToDate(state.watermark);
  if (!wmDate) {
    return String(cfg.start_date || '2010-01-01');
  }

  const fromDate = new Date(Date.UTC(
    wmDate.getUTCFullYear(),
    wmDate.getUTCMonth(),
    wmDate.getUTCDate(),
    0,
    0,
    0,
  ));
  fromDate.setUTCDate(fromDate.getUTCDate() - overlapDays);
  return dateToYYYYMMDD(fromDate);
}

function collectDeviceUserIds(payload) {
  const ids = [];
  const root = payload?.result && typeof payload.result === 'object' ? payload.result : payload;
  if (!root || typeof root !== 'object') {
    return ids;
  }

  for (const key of ['leftUserId', 'rightUserId']) {
    if (root[key] !== undefined && root[key] !== null) {
      ids.push(String(root[key]));
    }
  }

  const awaySides = root.awaySides;
  if (awaySides && typeof awaySides === 'object') {
    for (const value of Object.values(awaySides)) {
      if (value !== undefined && value !== null && String(value).trim()) {
        ids.push(String(value));
      }
    }
  }

  return ids;
}

function extractTrendEntries(payload) {
  if (Array.isArray(payload?.result)) {
    return payload.result;
  }
  if (Array.isArray(payload?.trends)) {
    return payload.trends;
  }
  if (Array.isArray(payload?.days)) {
    return payload.days;
  }
  return [];
}

function trendRecordId(userId, trend) {
  if (trend?.day) {
    return `${userId}:${String(trend.day)}`;
  }
  return `${userId}:${sha256Hex(JSON.stringify(trend))}`;
}

async function eightsleepAuth(db, config, helpers) {
  const cfg = helpers.configFor('eightsleep');
  await eightsleepRefreshIfNeeded(db, cfg);
  console.log('Eight Sleep authorization succeeded.');
}

async function eightsleepSync(db, config, helpers) {
  const cfg = helpers.configFor('eightsleep');
  const accessToken = await eightsleepRefreshIfNeeded(db, cfg);

  const apiBase = String(cfg.client_api_url || 'https://client-api.8slp.net/v1').replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  let mePayload;
  let meUserId = 'me';
  let meUser = null;

  await db.syncRun('eightsleep', 'users_me', async () => {
    await db.transaction(async () => {
      mePayload = await requestJson(`${apiBase}/users/me`, { headers });
      meUser = mePayload?.user && typeof mePayload.user === 'object' ? mePayload.user : null;
      meUserId = String(meUser?.id || mePayload?.id || 'me');
      const nowIso = utcNowIso();
      db.upsertRecord({
        provider: 'eightsleep',
        resource: 'users_me',
        recordId: meUserId,
        startTime: null,
        endTime: null,
        sourceUpdatedAt: nowIso,
        payload: mePayload,
      });
      db.setSyncState('eightsleep', 'users_me', {
        watermark: nowIso,
      });
    });
  });

  const userIds = new Set();
  if (meUserId !== 'me') {
    userIds.add(meUserId);
  }

  await db.syncRun('eightsleep', 'devices', async () => {
    await db.transaction(async () => {
      const devices = Array.isArray(meUser?.devices)
        ? meUser.devices
        : Array.isArray(mePayload?.devices)
          ? mePayload.devices
          : [];
      const nowIso = utcNowIso();

      for (const deviceEntry of devices) {
        const deviceId = typeof deviceEntry === 'object' && deviceEntry !== null
          ? deviceEntry.id || deviceEntry.deviceId
          : deviceEntry;
        if (!deviceId) {
          continue;
        }

        const payload = await requestJson(`${apiBase}/devices/${encodeURIComponent(String(deviceId))}`, {
          headers,
        });

        db.upsertRecord({
          provider: 'eightsleep',
          resource: 'devices',
          recordId: String(deviceId),
          startTime: null,
          endTime: null,
          sourceUpdatedAt: nowIso,
          payload,
        });

        for (const uid of collectDeviceUserIds(payload)) {
          userIds.add(uid);
        }
      }

      db.setSyncState('eightsleep', 'devices', {
        watermark: nowIso,
      });
    });
  });

  await db.syncRun('eightsleep', 'users', async () => {
    await db.transaction(async () => {
      const nowIso = utcNowIso();
      for (const userId of userIds) {
        const payload = await requestJson(`${apiBase}/users/${encodeURIComponent(String(userId))}`, {
          headers,
        });
        db.upsertRecord({
          provider: 'eightsleep',
          resource: 'users',
          recordId: String(userId),
          startTime: null,
          endTime: null,
          sourceUpdatedAt: nowIso,
          payload,
        });
      }

      db.setSyncState('eightsleep', 'users', {
        watermark: nowIso,
      });
    });
  });

  await db.syncRun('eightsleep', 'trends', async () => {
    await db.transaction(async () => {
      const timezone = String(cfg.timezone || 'UTC');
      const fromDate = trendsFromDate(db, cfg);
      const todayDate = dateToYYYYMMDD(new Date());
      const nowIso = utcNowIso();

      for (const userId of userIds) {
        const payload = await requestJson(`${apiBase}/users/${encodeURIComponent(String(userId))}/trends`, {
          headers,
          params: {
            tz: timezone,
            from: fromDate,
            to: todayDate,
            'include-main': 'false',
            'include-all-sessions': 'true',
            'model-version': 'v2',
          },
        });

        const entries = extractTrendEntries(payload);
        for (const trend of entries) {
          const startTime = trend?.day || trend?.presenceStart || null;
          const sourceUpdatedAt = trend?.updatedAt || trend?.presenceStart || startTime;
          db.upsertRecord({
            provider: 'eightsleep',
            resource: 'trends',
            recordId: trendRecordId(String(userId), trend),
            startTime,
            endTime: trend?.presenceEnd || null,
            sourceUpdatedAt,
            payload: trend,
          });
        }
      }

      db.setSyncState('eightsleep', 'trends', {
        watermark: nowIso,
      });
    });
  });
}

const eightsleepProvider = {
  id: 'eightsleep',
  source: 'builtin',
  description: 'Eight Sleep user/device and trend data sync',
  supportsAuth: true,
  auth: eightsleepAuth,
  sync: eightsleepSync,
};

export default eightsleepProvider;
