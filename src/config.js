import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_CONFIG_PATH = path.resolve(MODULE_DIR, '../health-sync.example.toml');

const BUILTIN_DEFAULTS = {
  app: {
    db: './health.sqlite',
  },
  oura: {
    enabled: false,
    client_id: null,
    client_secret: null,
    authorize_url: 'https://moi.ouraring.com/oauth/v2/ext/oauth-authorize',
    token_url: 'https://moi.ouraring.com/oauth/v2/ext/oauth-token',
    redirect_uri: 'http://localhost:8080/callback',
    scopes: 'extapi:daily extapi:heartrate extapi:personal extapi:workout extapi:session extapi:tag extapi:spo2',
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
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function section(obj, name) {
  const raw = obj?.[name];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  return {};
}

function getStr(raw, key, fallback = null) {
  const value = raw?.[key];
  if (value === undefined || value === null || typeof value === 'boolean') {
    return fallback;
  }
  const out = String(value).trim();
  return out ? out : fallback;
}

function getInt(raw, key, fallback = null) {
  const value = raw?.[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBool(raw, key, fallback = false) {
  const value = raw?.[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function getListStr(raw, key, fallback = null) {
  const value = raw?.[key];
  if (value === undefined || value === null || typeof value === 'boolean') {
    return fallback;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
      .filter((v) => !!v);
    return items.length ? items : fallback;
  }
  const single = String(value).trim();
  if (!single) {
    return fallback;
  }
  const parts = single.split(',').map((p) => p.trim()).filter((p) => !!p);
  return parts.length ? parts : fallback;
}

export function defaultConfig() {
  return {
    app: clone(BUILTIN_DEFAULTS.app),
    oura: clone(BUILTIN_DEFAULTS.oura),
    withings: clone(BUILTIN_DEFAULTS.withings),
    hevy: clone(BUILTIN_DEFAULTS.hevy),
    strava: clone(BUILTIN_DEFAULTS.strava),
    whoop: clone(BUILTIN_DEFAULTS.whoop),
    eightsleep: clone(BUILTIN_DEFAULTS.eightsleep),
    plugins: {},
  };
}

function loadPlugins(raw) {
  const pluginsTable = section(raw, 'plugins');
  const out = {};
  for (const [pluginId, pluginRaw] of Object.entries(pluginsTable)) {
    if (!pluginRaw || typeof pluginRaw !== 'object' || Array.isArray(pluginRaw)) {
      continue;
    }
    const mapped = {};
    for (const [k, v] of Object.entries(pluginRaw)) {
      if (typeof v === 'string') {
        const trimmed = v.trim();
        mapped[k] = trimmed.length ? trimmed : null;
      } else {
        mapped[k] = v;
      }
    }
    out[pluginId] = mapped;
  }
  return out;
}

export function loadConfig(configPath) {
  const resolvedPath = path.resolve(configPath);
  let raw = {};
  if (fs.existsSync(resolvedPath)) {
    const text = fs.readFileSync(resolvedPath, 'utf8');
    raw = TOML.parse(text);
  }

  const cfg = defaultConfig();

  const app = section(raw, 'app');
  cfg.app.db = getStr(app, 'db', cfg.app.db);

  const oura = section(raw, 'oura');
  cfg.oura.enabled = getBool(oura, 'enabled', cfg.oura.enabled);
  cfg.oura.client_id = getStr(oura, 'client_id', cfg.oura.client_id);
  cfg.oura.client_secret = getStr(oura, 'client_secret', cfg.oura.client_secret);
  cfg.oura.authorize_url = getStr(oura, 'authorize_url', cfg.oura.authorize_url);
  cfg.oura.token_url = getStr(oura, 'token_url', cfg.oura.token_url);
  cfg.oura.redirect_uri = getStr(oura, 'redirect_uri', cfg.oura.redirect_uri);
  cfg.oura.scopes = getStr(oura, 'scopes', cfg.oura.scopes);
  cfg.oura.start_date = getStr(oura, 'start_date', cfg.oura.start_date);
  cfg.oura.overlap_days = getInt(oura, 'overlap_days', cfg.oura.overlap_days);

  const withings = section(raw, 'withings');
  cfg.withings.enabled = getBool(withings, 'enabled', cfg.withings.enabled);
  cfg.withings.client_id = getStr(withings, 'client_id', cfg.withings.client_id);
  cfg.withings.client_secret = getStr(withings, 'client_secret', cfg.withings.client_secret);
  cfg.withings.redirect_uri = getStr(withings, 'redirect_uri', cfg.withings.redirect_uri);
  cfg.withings.scopes = getStr(withings, 'scopes', cfg.withings.scopes);
  cfg.withings.overlap_seconds = getInt(withings, 'overlap_seconds', cfg.withings.overlap_seconds);
  cfg.withings.meastypes = getListStr(withings, 'meastypes', cfg.withings.meastypes);

  const hevy = section(raw, 'hevy');
  cfg.hevy.enabled = getBool(hevy, 'enabled', cfg.hevy.enabled);
  cfg.hevy.api_key = getStr(hevy, 'api_key', cfg.hevy.api_key);
  cfg.hevy.base_url = getStr(hevy, 'base_url', cfg.hevy.base_url);
  cfg.hevy.overlap_seconds = getInt(hevy, 'overlap_seconds', cfg.hevy.overlap_seconds);
  cfg.hevy.page_size = getInt(hevy, 'page_size', cfg.hevy.page_size);
  cfg.hevy.since = getStr(hevy, 'since', cfg.hevy.since);

  const strava = section(raw, 'strava');
  cfg.strava.enabled = getBool(strava, 'enabled', cfg.strava.enabled);
  cfg.strava.access_token = getStr(strava, 'access_token', cfg.strava.access_token);
  cfg.strava.client_id = getStr(strava, 'client_id', cfg.strava.client_id);
  cfg.strava.client_secret = getStr(strava, 'client_secret', cfg.strava.client_secret);
  cfg.strava.redirect_uri = getStr(strava, 'redirect_uri', cfg.strava.redirect_uri);
  cfg.strava.scopes = getStr(strava, 'scopes', cfg.strava.scopes);
  cfg.strava.approval_prompt = getStr(strava, 'approval_prompt', cfg.strava.approval_prompt);
  cfg.strava.start_date = getStr(strava, 'start_date', cfg.strava.start_date);
  cfg.strava.overlap_seconds = getInt(strava, 'overlap_seconds', cfg.strava.overlap_seconds);
  cfg.strava.page_size = getInt(strava, 'page_size', cfg.strava.page_size);

  const whoop = section(raw, 'whoop');
  cfg.whoop.enabled = getBool(whoop, 'enabled', cfg.whoop.enabled);
  cfg.whoop.client_id = getStr(whoop, 'client_id', cfg.whoop.client_id);
  cfg.whoop.client_secret = getStr(whoop, 'client_secret', cfg.whoop.client_secret);
  cfg.whoop.authorize_url = getStr(whoop, 'authorize_url', cfg.whoop.authorize_url);
  cfg.whoop.token_url = getStr(whoop, 'token_url', cfg.whoop.token_url);
  cfg.whoop.api_base_url = getStr(whoop, 'api_base_url', cfg.whoop.api_base_url);
  cfg.whoop.redirect_uri = getStr(whoop, 'redirect_uri', cfg.whoop.redirect_uri);
  cfg.whoop.scopes = getStr(whoop, 'scopes', cfg.whoop.scopes);
  cfg.whoop.start_date = getStr(whoop, 'start_date', cfg.whoop.start_date);
  cfg.whoop.overlap_days = getInt(whoop, 'overlap_days', cfg.whoop.overlap_days);
  cfg.whoop.page_size = getInt(whoop, 'page_size', cfg.whoop.page_size);

  const eightsleep = section(raw, 'eightsleep');
  cfg.eightsleep.enabled = getBool(eightsleep, 'enabled', cfg.eightsleep.enabled);
  cfg.eightsleep.access_token = getStr(eightsleep, 'access_token', cfg.eightsleep.access_token);
  cfg.eightsleep.email = getStr(eightsleep, 'email', cfg.eightsleep.email);
  cfg.eightsleep.password = getStr(eightsleep, 'password', cfg.eightsleep.password);
  cfg.eightsleep.client_id = getStr(eightsleep, 'client_id', cfg.eightsleep.client_id);
  cfg.eightsleep.client_secret = getStr(eightsleep, 'client_secret', cfg.eightsleep.client_secret);
  cfg.eightsleep.timezone = getStr(eightsleep, 'timezone', cfg.eightsleep.timezone);
  cfg.eightsleep.auth_url = getStr(eightsleep, 'auth_url', cfg.eightsleep.auth_url);
  cfg.eightsleep.client_api_url = getStr(eightsleep, 'client_api_url', cfg.eightsleep.client_api_url);
  cfg.eightsleep.start_date = getStr(eightsleep, 'start_date', cfg.eightsleep.start_date);
  cfg.eightsleep.overlap_days = getInt(eightsleep, 'overlap_days', cfg.eightsleep.overlap_days);

  cfg.plugins = loadPlugins(raw);

  return {
    path: resolvedPath,
    raw,
    data: cfg,
  };
}

export function requireStr(sectionData, key, message = null) {
  const value = sectionData?.[key];
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error(message || `Missing required config value: ${key}`);
  }
  return String(value).trim();
}

function upsertSectionValues(rawDoc, pathParts, values) {
  let cursor = rawDoc;
  for (const part of pathParts) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  for (const [key, value] of Object.entries(values)) {
    cursor[key] = value;
  }
}

function writeToml(filePath, rawDoc) {
  const rendered = TOML.stringify(rawDoc);
  fs.writeFileSync(filePath, rendered, 'utf8');
}

function readExampleConfigTemplate() {
  if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    return fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
  }
  return TOML.stringify(defaultConfig());
}

function renderScaffoldConfig(dbPath = null) {
  const template = readExampleConfigTemplate();
  if (!dbPath) {
    return template;
  }

  const dbLine = `db = ${JSON.stringify(String(dbPath))}`;
  if (template.includes('# db = "./health.sqlite"')) {
    return template.replace('# db = "./health.sqlite"', dbLine);
  }
  if (template.includes('[app]')) {
    return template.replace('[app]', `[app]\n${dbLine}`);
  }
  return `[app]\n${dbLine}\n\n${template}`;
}

export function initConfigFile(configPath, dbPath = null) {
  const resolved = path.resolve(configPath);

  if (!fs.existsSync(resolved)) {
    fs.writeFileSync(resolved, renderScaffoldConfig(dbPath), 'utf8');
    return;
  }

  if (!dbPath) {
    return;
  }

  const raw = TOML.parse(fs.readFileSync(resolved, 'utf8'));
  upsertSectionValues(raw, ['app'], { db: dbPath });
  writeToml(resolved, raw);
}

function scaffoldBuiltinDefaults(providerId) {
  const defaults = BUILTIN_DEFAULTS[providerId];
  if (!defaults) {
    return null;
  }
  return {
    ...clone(defaults),
    enabled: true,
  };
}

const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertValidProviderId(providerId) {
  const normalized = String(providerId || '').trim();
  if (!normalized || !PROVIDER_ID_RE.test(normalized)) {
    throw new Error(`Invalid provider id: ${providerId}`);
  }
  return normalized;
}

export function scaffoldProviderConfig(configPath, providerId) {
  const normalizedProviderId = assertValidProviderId(providerId);
  const resolved = path.resolve(configPath);
  const raw = fs.existsSync(resolved) ? TOML.parse(fs.readFileSync(resolved, 'utf8')) : {};

  const builtinDefaults = scaffoldBuiltinDefaults(normalizedProviderId);
  if (builtinDefaults) {
    const sectionRaw = section(raw, normalizedProviderId);
    const merged = { ...builtinDefaults, ...sectionRaw, enabled: true };
    upsertSectionValues(raw, [normalizedProviderId], merged);
  } else {
    const pluginsRaw = section(raw, 'plugins');
    const pluginRaw = section(pluginsRaw, normalizedProviderId);
    const merged = { ...pluginRaw, enabled: true };
    if (!pluginRaw.module) {
      merged.module = pluginRaw.module ?? null;
    }
    upsertSectionValues(raw, ['plugins', normalizedProviderId], merged);
  }

  writeToml(resolved, raw);
}

export const BUILTIN_PROVIDER_IDS = Object.freeze([
  'oura',
  'withings',
  'hevy',
  'strava',
  'whoop',
  'eightsleep',
]);
