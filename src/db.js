import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  dtToIsoZ,
  isoToDate,
  stableJsonStringify,
  toEpochSeconds,
  utcNowIso,
} from './util.js';

function jsonLoadsOrNull(text, contextLabel) {
  if (text === null || text === undefined || text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`Ignoring invalid JSON in ${contextLabel}`);
    return null;
  }
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const epoch = toEpochSeconds(value);
  if (epoch !== null) {
    return dtToIsoZ(new Date(epoch * 1000));
  }
  return dtToIsoZ(value);
}

function normalizeWatermark(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return dtToIsoZ(new Date(Math.floor(value) * 1000));
  }

  if (value instanceof Date) {
    return dtToIsoZ(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const epoch = Number.parseInt(trimmed, 10);
    return dtToIsoZ(new Date(epoch * 1000));
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return dtToIsoZ(`${trimmed}T00:00:00Z`);
  }

  const parsed = isoToDate(trimmed);
  if (!parsed) {
    return null;
  }
  return dtToIsoZ(parsed);
}

export class HealthSyncDb {
  constructor(dbPath, options = {}) {
    this.path = path.resolve(dbPath);
    this.credsPath = path.resolve(
      options.credsPath || path.join(path.dirname(this.path), '.health-sync.creds'),
    );
    this.conn = new Database(this.path);
    this.conn.pragma('journal_mode = WAL');
    this.conn.pragma('foreign_keys = ON');
    this._runStatsStack = [];
    this._transactionDepth = 0;
    this._oauthMigrated = false;
    this._credsParseWarned = false;
    this._stmtCache = new Map();
  }

  close() {
    this._stmtCache.clear();
    this.conn.close();
  }

  init() {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS records (
        provider TEXT NOT NULL,
        resource TEXT NOT NULL,
        record_id TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        source_updated_at TEXT,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (provider, resource, record_id)
      );

      CREATE INDEX IF NOT EXISTS idx_records_provider_resource_start_time
        ON records(provider, resource, start_time);

      CREATE INDEX IF NOT EXISTS idx_records_provider_resource_source_updated_at
        ON records(provider, resource, source_updated_at);

      CREATE TABLE IF NOT EXISTS sync_state (
        provider TEXT NOT NULL,
        resource TEXT NOT NULL,
        watermark TEXT,
        cursor TEXT,
        extra_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, resource)
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_type TEXT,
        scope TEXT,
        expires_at TEXT,
        obtained_at TEXT NOT NULL,
        extra_json TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        resource TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        watermark_before TEXT,
        watermark_after TEXT,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        deleted_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        error_text TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sync_runs_provider_resource_started_at
        ON sync_runs(provider, resource, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_sync_runs_status_started_at
        ON sync_runs(status, started_at DESC);
    `);

    this._normalizeLegacyTimestamps();
    this._migrateOAuthTokensToCredsFile();
  }

  _stmt(key, sql) {
    let stmt = this._stmtCache.get(key);
    if (!stmt) {
      stmt = this.conn.prepare(sql);
      this._stmtCache.set(key, stmt);
    }
    return stmt;
  }

  _normalizeLegacyTimestamps() {
    const normalizeTableCols = [
      ['records', ['start_time', 'end_time', 'source_updated_at', 'fetched_at']],
      ['sync_state', ['watermark', 'updated_at']],
      ['oauth_tokens', ['expires_at', 'obtained_at']],
      ['sync_runs', ['started_at', 'finished_at', 'watermark_before', 'watermark_after']],
    ];

    for (const [table, cols] of normalizeTableCols) {
      const rows = this.conn.prepare(`SELECT rowid, ${cols.join(', ')} FROM ${table}`).all();
      for (const row of rows) {
        const updates = {};
        for (const col of cols) {
          const val = row[col];
          const normalized = col.includes('watermark') ? normalizeWatermark(val) : normalizeTimestamp(val);
          if (normalized !== val && normalized !== null) {
            updates[col] = normalized;
          }
        }
        if (!Object.keys(updates).length) {
          continue;
        }
        const sets = Object.keys(updates).map((col) => `${col} = @${col}`).join(', ');
        this.conn.prepare(`UPDATE ${table} SET ${sets} WHERE rowid = @rowid`).run({ rowid: row.rowid, ...updates });
      }
    }
  }

  _readCredsDoc() {
    if (!fs.existsSync(this.credsPath)) {
      return { version: 1, tokens: {} };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.credsPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { version: 1, tokens: {} };
      }

      const tokens = (parsed.tokens && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens))
        ? parsed.tokens
        : {};

      return {
        version: 1,
        updatedAt: normalizeTimestamp(parsed.updatedAt || parsed.updated_at) || null,
        tokens,
      };
    } catch {
      if (!this._credsParseWarned) {
        console.warn(`Ignoring invalid JSON in ${this.credsPath}`);
        this._credsParseWarned = true;
      }
      return { version: 1, tokens: {} };
    }
  }

  _writeCredsDoc(doc) {
    const normalized = {
      version: 1,
      updatedAt: utcNowIso(),
      tokens: doc?.tokens && typeof doc.tokens === 'object' && !Array.isArray(doc.tokens)
        ? doc.tokens
        : {},
    };

    fs.mkdirSync(path.dirname(this.credsPath), { recursive: true });
    const tempPath = `${this.credsPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, `${stableJsonStringify(normalized)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tempPath, this.credsPath);
    try {
      fs.chmodSync(this.credsPath, 0o600);
    } catch {
      // Ignore chmod failures on filesystems that do not support POSIX modes.
    }
  }

  _normalizeStoredToken(provider, rawToken, contextLabel = `.health-sync.creds.${provider}`) {
    if (!rawToken || typeof rawToken !== 'object' || Array.isArray(rawToken)) {
      return null;
    }

    const accessTokenValue = rawToken.accessToken ?? rawToken.access_token;
    if (accessTokenValue === null || accessTokenValue === undefined || String(accessTokenValue).trim() === '') {
      return null;
    }

    let extra = rawToken.extra ?? null;
    if (extra === null && typeof rawToken.extra_json === 'string') {
      extra = jsonLoadsOrNull(rawToken.extra_json, `${contextLabel}.extra_json`);
    }

    return {
      provider,
      accessToken: String(accessTokenValue),
      refreshToken: rawToken.refreshToken ?? rawToken.refresh_token ?? null,
      tokenType: rawToken.tokenType ?? rawToken.token_type ?? null,
      scope: rawToken.scope ?? null,
      expiresAt: normalizeTimestamp(rawToken.expiresAt ?? rawToken.expires_at),
      obtainedAt: normalizeTimestamp(rawToken.obtainedAt ?? rawToken.obtained_at),
      extra,
    };
  }

  _listLegacyOAuthTokens() {
    let rows = [];
    try {
      rows = this._stmt('oauth_tokens.list_legacy', 'SELECT * FROM oauth_tokens ORDER BY provider ASC').all();
    } catch {
      rows = [];
    }

    const out = {};
    for (const row of rows) {
      const normalized = this._normalizeStoredToken(
        row.provider,
        {
          access_token: row.access_token,
          refresh_token: row.refresh_token,
          token_type: row.token_type,
          scope: row.scope,
          expires_at: row.expires_at,
          obtained_at: row.obtained_at,
          extra_json: row.extra_json,
        },
        `oauth_tokens.${row.provider}`,
      );
      if (normalized) {
        out[row.provider] = normalized;
      }
    }

    return out;
  }

  _upsertCredsToken(provider, token) {
    const doc = this._readCredsDoc();
    const tokens = {
      ...(doc.tokens || {}),
      [provider]: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType,
        scope: token.scope,
        expiresAt: token.expiresAt,
        obtainedAt: token.obtainedAt,
        extra: token.extra,
      },
    };
    this._writeCredsDoc({ ...doc, tokens });
  }

  _migrateOAuthTokensToCredsFile() {
    if (this._oauthMigrated) {
      return;
    }
    this._oauthMigrated = true;

    const legacyTokens = this._listLegacyOAuthTokens();
    if (!Object.keys(legacyTokens).length) {
      return;
    }

    const doc = this._readCredsDoc();
    const tokens = { ...(doc.tokens || {}) };
    let changed = false;

    for (const [provider, token] of Object.entries(legacyTokens)) {
      const existing = this._normalizeStoredToken(provider, tokens[provider]);
      if (existing) {
        continue;
      }
      tokens[provider] = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType,
        scope: token.scope,
        expiresAt: token.expiresAt,
        obtainedAt: token.obtainedAt,
        extra: token.extra,
      };
      changed = true;
    }

    const nextDoc = changed ? { ...doc, tokens } : doc;
    if (changed) {
      this._writeCredsDoc(nextDoc);
    }

    const migratedProviders = Object.keys(legacyTokens)
      .filter((provider) => this._normalizeStoredToken(provider, nextDoc.tokens?.[provider]));
    for (const provider of migratedProviders) {
      this._stmt('oauth_tokens.delete_provider', 'DELETE FROM oauth_tokens WHERE provider = ?').run(provider);
    }
  }
  _incrementRunStats(stats, op) {
    if (!stats) {
      return;
    }
    if (op === 'inserted') {
      stats.insertedCount += 1;
    } else if (op === 'updated') {
      stats.updatedCount += 1;
    } else if (op === 'deleted') {
      stats.deletedCount += 1;
    } else if (op === 'unchanged') {
      stats.unchangedCount += 1;
    }
  }

  _trackOperation(op, target = null) {
    let entry = null;
    if (target && typeof target === 'object') {
      const provider = typeof target.provider === 'string' ? target.provider : null;
      const resource = typeof target.resource === 'string' ? target.resource : null;
      if (provider && resource) {
        for (let i = this._runStatsStack.length - 1; i >= 0; i -= 1) {
          const candidate = this._runStatsStack[i];
          if (candidate.provider === provider && candidate.resource === resource) {
            entry = candidate;
            break;
          }
        }
      }
    }

    if (!entry) {
      entry = this._runStatsStack[this._runStatsStack.length - 1];
    }
    if (!entry) {
      return;
    }

    this._incrementRunStats(entry.stats, op);
  }

  upsertRecord(
    {
      provider,
      resource,
      recordId,
      startTime = null,
      endTime = null,
      sourceUpdatedAt = null,
      payload,
    },
    trackTarget = null,
  ) {
    const payloadJson = stableJsonStringify(payload);
    const normalizedStart = normalizeTimestamp(startTime);
    const normalizedEnd = normalizeTimestamp(endTime);
    const normalizedUpdated = normalizeTimestamp(sourceUpdatedAt);
    const fetchedAt = utcNowIso();

    const existing = this._stmt(
      'records.select_for_upsert',
      `
        SELECT payload_json, start_time, end_time, source_updated_at
        FROM records
        WHERE provider = ? AND resource = ? AND record_id = ?
      `,
    ).get(provider, resource, recordId);

    let op = 'inserted';
    if (existing) {
      if (
        existing.payload_json === payloadJson
        && existing.start_time === normalizedStart
        && existing.end_time === normalizedEnd
        && existing.source_updated_at === normalizedUpdated
      ) {
        op = 'unchanged';
      } else {
        op = 'updated';
      }
    }

    this._stmt(
      'records.upsert',
      `
      INSERT INTO records (
        provider, resource, record_id, start_time, end_time,
        source_updated_at, payload_json, fetched_at
      ) VALUES (
        @provider, @resource, @record_id, @start_time, @end_time,
        @source_updated_at, @payload_json, @fetched_at
      )
      ON CONFLICT(provider, resource, record_id)
      DO UPDATE SET
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        source_updated_at = excluded.source_updated_at,
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at
      `,
    ).run({
      provider,
      resource,
      record_id: recordId,
      start_time: normalizedStart,
      end_time: normalizedEnd,
      source_updated_at: normalizedUpdated,
      payload_json: payloadJson,
      fetched_at: fetchedAt,
    });

    this._trackOperation(op, trackTarget);
    return op;
  }

  deleteRecord(provider, resource, recordId, trackTarget = null) {
    const result = this._stmt(
      'records.delete',
      'DELETE FROM records WHERE provider = ? AND resource = ? AND record_id = ?',
    ).run(provider, resource, recordId);
    if (result.changes > 0) {
      this._trackOperation('deleted', trackTarget);
      return true;
    }
    return false;
  }

  getSyncState(provider, resource) {
    const row = this._stmt(
      'sync_state.get',
      'SELECT * FROM sync_state WHERE provider = ? AND resource = ?',
    ).get(provider, resource);
    if (!row) {
      return null;
    }
    return {
      provider: row.provider,
      resource: row.resource,
      watermark: normalizeWatermark(row.watermark),
      cursor: row.cursor,
      extra: jsonLoadsOrNull(row.extra_json, `sync_state.${provider}.${resource}.extra_json`),
      updatedAt: normalizeTimestamp(row.updated_at) || row.updated_at,
    };
  }

  listSyncState() {
    const rows = this._stmt(
      'sync_state.list',
      'SELECT * FROM sync_state ORDER BY provider ASC, resource ASC',
    ).all();
    return rows.map((row) => ({
      provider: row.provider,
      resource: row.resource,
      watermark: normalizeWatermark(row.watermark),
      cursor: row.cursor,
      extra: jsonLoadsOrNull(row.extra_json, `sync_state.${row.provider}.${row.resource}.extra_json`),
      updatedAt: normalizeTimestamp(row.updated_at) || row.updated_at,
    }));
  }

  setSyncState(provider, resource, { watermark = null, cursor = null, extra = null } = {}) {
    const normalizedWatermark = normalizeWatermark(watermark);
    const updatedAt = utcNowIso();
    const extraJson = extra === null || extra === undefined ? null : stableJsonStringify(extra);

    this._stmt(
      'sync_state.upsert',
      `
      INSERT INTO sync_state (provider, resource, watermark, cursor, extra_json, updated_at)
      VALUES (@provider, @resource, @watermark, @cursor, @extra_json, @updated_at)
      ON CONFLICT(provider, resource)
      DO UPDATE SET
        watermark = excluded.watermark,
        cursor = excluded.cursor,
        extra_json = excluded.extra_json,
        updated_at = excluded.updated_at
      `,
    ).run({
      provider,
      resource,
      watermark: normalizedWatermark,
      cursor,
      extra_json: extraJson,
      updated_at: updatedAt,
    });
  }

  getOAuthToken(provider) {
    this._migrateOAuthTokensToCredsFile();

    const fromCreds = this._normalizeStoredToken(
      provider,
      this._readCredsDoc().tokens?.[provider],
    );
    if (fromCreds) {
      return fromCreds;
    }

    const row = this._stmt(
      'oauth_tokens.get_provider',
      'SELECT * FROM oauth_tokens WHERE provider = ?',
    ).get(provider);
    if (!row) {
      return null;
    }

    const legacy = this._normalizeStoredToken(
      provider,
      {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_type: row.token_type,
        scope: row.scope,
        expires_at: row.expires_at,
        obtained_at: row.obtained_at,
        extra_json: row.extra_json,
      },
      `oauth_tokens.${provider}`,
    );
    if (!legacy) {
      return null;
    }

    this._upsertCredsToken(provider, legacy);
    this._stmt('oauth_tokens.delete_provider', 'DELETE FROM oauth_tokens WHERE provider = ?').run(provider);
    return legacy;
  }

  setOAuthToken(provider, {
    accessToken,
    refreshToken = null,
    tokenType = null,
    scope = null,
    expiresAt = null,
    extra = null,
  }) {
    if (accessToken === null || accessToken === undefined || String(accessToken).trim() === '') {
      throw new Error('accessToken is required');
    }

    this._migrateOAuthTokensToCredsFile();

    const token = {
      provider,
      accessToken: String(accessToken),
      refreshToken: refreshToken === undefined ? null : refreshToken,
      tokenType: tokenType === undefined ? null : tokenType,
      scope: scope === undefined ? null : scope,
      expiresAt: normalizeTimestamp(expiresAt),
      obtainedAt: utcNowIso(),
      extra: extra === undefined ? null : extra,
    };

    this._upsertCredsToken(provider, token);
  }

  startSyncRun(provider, resource, watermarkBefore = null) {
    const startedAt = utcNowIso();
    const result = this._stmt(
      'sync_runs.start',
      `
      INSERT INTO sync_runs (
        provider, resource, status, started_at, watermark_before,
        inserted_count, updated_count, deleted_count, unchanged_count
      ) VALUES (
        @provider, @resource, 'running', @started_at, @watermark_before,
        0, 0, 0, 0
      )
      `,
    ).run({
      provider,
      resource,
      started_at: startedAt,
      watermark_before: normalizeWatermark(watermarkBefore),
    });
    return Number(result.lastInsertRowid);
  }

  finishSyncRun(runId, {
    status,
    watermarkAfter = null,
    insertedCount = 0,
    updatedCount = 0,
    deletedCount = 0,
    unchangedCount = 0,
    errorText = null,
  }) {
    this._stmt(
      'sync_runs.finish',
      `
      UPDATE sync_runs
      SET
        status = @status,
        finished_at = @finished_at,
        watermark_after = @watermark_after,
        inserted_count = @inserted_count,
        updated_count = @updated_count,
        deleted_count = @deleted_count,
        unchanged_count = @unchanged_count,
        error_text = @error_text
      WHERE id = @id
      `,
    ).run({
      id: runId,
      status,
      finished_at: utcNowIso(),
      watermark_after: normalizeWatermark(watermarkAfter),
      inserted_count: insertedCount,
      updated_count: updatedCount,
      deleted_count: deletedCount,
      unchanged_count: unchangedCount,
      error_text: errorText,
    });
  }

  async syncRun(provider, resource, fn) {
    const stateBefore = this.getSyncState(provider, resource);
    const watermarkBefore = stateBefore?.watermark ?? null;
    const runId = this.startSyncRun(provider, resource, watermarkBefore);
    const stats = {
      insertedCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      unchangedCount: 0,
    };

    const entry = { provider, resource, stats };
    this._runStatsStack.push(entry);
    let status = 'success';
    let errorText = null;
    try {
      await fn();
    } catch (err) {
      status = 'error';
      errorText = err?.stack || err?.message || String(err);
      throw err;
    } finally {
      this._runStatsStack.pop();
      const stateAfter = this.getSyncState(provider, resource);
      this.finishSyncRun(runId, {
        status,
        watermarkAfter: stateAfter?.watermark ?? null,
        insertedCount: entry.stats.insertedCount,
        updatedCount: entry.stats.updatedCount,
        deletedCount: entry.stats.deletedCount,
        unchangedCount: entry.stats.unchangedCount,
        errorText,
      });
    }
  }

  listRecentSyncRuns(limit = 20) {
    const rows = this._stmt(
      'sync_runs.list_recent',
      `
      SELECT *
      FROM sync_runs
      ORDER BY started_at DESC
      LIMIT ?
      `,
    ).all(limit);

    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      resource: row.resource,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      watermarkBefore: normalizeWatermark(row.watermark_before),
      watermarkAfter: normalizeWatermark(row.watermark_after),
      insertedCount: row.inserted_count,
      updatedCount: row.updated_count,
      deletedCount: row.deleted_count,
      unchangedCount: row.unchanged_count,
      errorText: row.error_text,
    }));
  }

  listRecordCounts() {
    return this._stmt(
      'records.list_counts',
      `
      SELECT provider, resource, COUNT(*) AS count
      FROM records
      GROUP BY provider, resource
      ORDER BY provider ASC, resource ASC
      `,
    ).all();
  }

  getRecordCount(provider, resource) {
    const row = this._stmt(
      'records.count_by_resource',
      'SELECT COUNT(*) AS count FROM records WHERE provider = ? AND resource = ?',
    ).get(provider, resource);
    return Number(row?.count ?? 0);
  }

  getMaxRecordStartTime(provider, resource) {
    const row = this._stmt(
      'records.max_start_time',
      'SELECT MAX(start_time) AS max_start_time FROM records WHERE provider = ? AND resource = ?',
    ).get(provider, resource);
    return row?.max_start_time ? normalizeTimestamp(row.max_start_time) : null;
  }

  getSyncWatermarkEpoch(provider, resource) {
    const state = this.getSyncState(provider, resource);
    if (!state?.watermark) {
      return null;
    }
    return toEpochSeconds(state.watermark);
  }

  setSyncWatermarkEpoch(provider, resource, epochSeconds, extra = null) {
    const normalized = dtToIsoZ(new Date(Number(epochSeconds) * 1000));
    this.setSyncState(provider, resource, { watermark: normalized, extra });
  }

  async transaction(fn) {
    const depth = this._transactionDepth;
    const savepointName = `sp_${depth + 1}`;
    if (depth === 0) {
      this.conn.exec('BEGIN');
    } else {
      this.conn.exec(`SAVEPOINT ${savepointName}`);
    }
    this._transactionDepth += 1;

    try {
      const result = await fn();
      this._transactionDepth -= 1;
      if (depth === 0) {
        this.conn.exec('COMMIT');
      } else {
        this.conn.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }
      return result;
    } catch (err) {
      this._transactionDepth -= 1;
      if (depth === 0) {
        this.conn.exec('ROLLBACK');
      } else {
        this.conn.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        this.conn.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }
      throw err;
    }
  }
}

export function openDb(dbPath, options = {}) {
  const db = new HealthSyncDb(dbPath, options);
  db.init();
  return db;
}
