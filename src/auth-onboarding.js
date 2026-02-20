import {
  CURSOR_MARKER,
  Container,
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  TUI,
  Text,
  visibleWidth,
} from '@mariozechner/pi-tui';
import chalk, { Chalk } from 'chalk';
import { openInBrowser, requestJson } from './util.js';

const hasForceColor = typeof process.env.FORCE_COLOR === 'string'
  && process.env.FORCE_COLOR.trim() !== ''
  && process.env.FORCE_COLOR.trim() !== '0';
const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;
const color = (hex) => baseChalk.hex(hex);
const colors = {
  text: color('#E8E3D5'),
  muted: color('#7B7F87'),
  accent: color('#F6C453'),
  accentSoft: color('#F2A65A'),
  success: color('#7DD3A5'),
  warn: color('#F2A65A'),
  error: color('#F97066'),
  control: color('#8CC8FF'),
  heading: (value) => baseChalk.bold(color('#F6C453')(value)),
};

const SELECT_THEME = {
  selectedPrefix: (text) => colors.accent(text),
  selectedText: (text) => baseChalk.bold(colors.accent(text)),
  description: (text) => colors.muted(text),
  scrollInfo: (text) => colors.muted(text),
  noMatch: (text) => colors.muted(text),
};

const PROVIDER_NAMES = {
  oura: 'Oura',
  withings: 'Withings',
  hevy: 'Hevy',
  strava: 'Strava',
  whoop: 'WHOOP',
  eightsleep: 'Eight Sleep',
};

const ABORT_SENTINEL = Symbol('health-sync-abort');
const URL_PATTERN = /https?:\/\/[^\s)]+/g;
const WRAP_MIN_WIDTH = 24;
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';

export class UserAbortError extends Error {
  constructor(message = 'Setup aborted by user.') {
    super(message);
    this.name = 'UserAbortError';
    this.code = 'USER_ABORT';
  }
}

export function isUserAbortError(err) {
  return err instanceof UserAbortError
    || err?.code === 'USER_ABORT'
    || err?.name === 'UserAbortError';
}

function graphemes(value) {
  return Array.from(String(value || ''));
}

function secretMask(value) {
  return '*'.repeat(graphemes(value).length);
}

function normalizeMaskedInputData(data) {
  if (typeof data !== 'string' || !data.length) {
    return { text: '', isBracketedPaste: false };
  }

  const isBracketedPaste = data.includes(BRACKETED_PASTE_START)
    || data.includes(BRACKETED_PASTE_END);
  if (!isBracketedPaste) {
    return { text: data, isBracketedPaste: false };
  }

  const stripped = data
    .split(BRACKETED_PASTE_START).join('')
    .split(BRACKETED_PASTE_END).join('')
    .replace(/[\r\n]+/g, '');

  return {
    text: stripped,
    isBracketedPaste: true,
  };
}

function styleTextWithUrls(text, colorFn = null) {
  if (baseChalk.level <= 0) {
    return String(text);
  }

  const value = String(text);
  let out = '';
  let cursor = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      const segment = value.slice(cursor, index);
      out += colorFn ? colorFn(segment) : segment;
    }
    out += colors.control(match[0]);
    cursor = index + match[0].length;
  }

  if (cursor < value.length) {
    const tail = value.slice(cursor);
    out += colorFn ? colorFn(tail) : tail;
  }
  return out;
}

function extractUrls(lines = []) {
  const urls = [];
  const seen = new Set();
  for (const line of lines) {
    const value = String(line || '');
    for (const match of value.matchAll(URL_PATTERN)) {
      const url = String(match[0]);
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
}

function wrapText(value, width) {
  const text = String(value || '');
  if (width <= WRAP_MIN_WIDTH || visibleWidth(text) <= width) {
    return [text];
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [''];
  }

  const lines = [];
  let current = '';

  const pushCurrent = () => {
    if (current) {
      lines.push(current);
      current = '';
    }
  };

  for (const word of words) {
    if (!current) {
      if (visibleWidth(word) <= width) {
        current = word;
      } else {
        let pending = word;
        while (visibleWidth(pending) > width) {
          let part = '';
          for (const ch of graphemes(pending)) {
            if (visibleWidth(part + ch) > width) {
              break;
            }
            part += ch;
          }
          if (!part) {
            break;
          }
          lines.push(part);
          pending = pending.slice(part.length);
        }
        current = pending;
      }
      continue;
    }

    const next = `${current} ${word}`;
    if (visibleWidth(next) <= width) {
      current = next;
      continue;
    }

    pushCurrent();
    if (visibleWidth(word) <= width) {
      current = word;
    } else {
      let pending = word;
      while (visibleWidth(pending) > width) {
        let part = '';
        for (const ch of graphemes(pending)) {
          if (visibleWidth(part + ch) > width) {
            break;
          }
          part += ch;
        }
        if (!part) {
          break;
        }
        lines.push(part);
        pending = pending.slice(part.length);
      }
      current = pending;
    }
  }

  pushCurrent();
  return lines.length ? lines : [''];
}

function wrapGuideLine(line, width) {
  const value = String(line || '');
  if (!value.trim()) {
    return [''];
  }

  const bulletMatch = value.match(/^(-\s+)(.*)$/);
  if (bulletMatch) {
    const [, prefix, body] = bulletMatch;
    const wrapped = wrapText(body, Math.max(WRAP_MIN_WIDTH, width - visibleWidth(prefix)));
    return wrapped.map((part, index) => `${index === 0 ? prefix : ' '.repeat(prefix.length)}${part}`);
  }

  const numberMatch = value.match(/^(\d+\.\s+)(.*)$/);
  if (numberMatch) {
    const [, prefix, body] = numberMatch;
    const wrapped = wrapText(body, Math.max(WRAP_MIN_WIDTH, width - visibleWidth(prefix)));
    return wrapped.map((part, index) => `${index === 0 ? prefix : ' '.repeat(prefix.length)}${part}`);
  }

  return wrapText(value, width);
}

class MaskedInput {
  constructor() {
    this.value = '';
    this.cursor = 0;
    this.focused = false;
    this.onSubmit = null;
    this.onEscape = null;
    this.onAbort = null;
  }

  getValue() {
    return this.value;
  }

  setValue(value) {
    this.value = String(value || '');
    this.cursor = graphemes(this.value).length;
  }

  handleInput(data) {
    if (matchesKey(data, Key.ctrl('c'))) {
      if (typeof this.onAbort === 'function') {
        this.onAbort();
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      if (typeof this.onEscape === 'function') {
        this.onEscape();
      }
      return;
    }

    if (matchesKey(data, Key.enter) || data === '\n') {
      if (typeof this.onSubmit === 'function') {
        this.onSubmit(this.value);
      }
      return;
    }

    const chars = graphemes(this.value);

    if (matchesKey(data, Key.left)) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.cursor = Math.min(chars.length, this.cursor + 1);
      return;
    }
    if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl('a'))) {
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl('e'))) {
      this.cursor = chars.length;
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) {
        chars.splice(this.cursor - 1, 1);
        this.cursor -= 1;
        this.value = chars.join('');
      }
      return;
    }
    if (matchesKey(data, Key.delete)) {
      if (this.cursor < chars.length) {
        chars.splice(this.cursor, 1);
        this.value = chars.join('');
      }
      return;
    }

    const normalizedInput = normalizeMaskedInputData(data);
    const textInput = normalizedInput.text;
    if (!textInput.length) {
      return;
    }

    const hasControlChars = [...textInput].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    });
    if (hasControlChars || (!normalizedInput.isBracketedPaste && textInput.startsWith('\u001b'))) {
      return;
    }

    const inserted = graphemes(textInput);
    if (!inserted.length) {
      return;
    }
    chars.splice(this.cursor, 0, ...inserted);
    this.cursor += inserted.length;
    this.value = chars.join('');
  }

  invalidate() {
    // no-op
  }

  render(width) {
    const prompt = '> ';
    const availableWidth = width - prompt.length;
    if (availableWidth <= 0) {
      return [prompt];
    }

    const masked = secretMask(this.value);
    let visible = masked;
    let cursorDisplay = Math.min(this.cursor, graphemes(masked).length);

    if (visible.length > Math.max(1, availableWidth - 1)) {
      const window = Math.max(1, availableWidth - 1);
      let start = Math.max(0, this.cursor - Math.floor(window / 2));
      if (start + window > visible.length) {
        start = Math.max(0, visible.length - window);
      }
      visible = visible.slice(start, start + window);
      cursorDisplay = this.cursor - start;
    }

    const beforeCursor = visible.slice(0, cursorDisplay);
    const atCursor = visible[cursorDisplay] || ' ';
    const afterCursor = visible.slice(cursorDisplay + (visible[cursorDisplay] ? 1 : 0));
    const marker = this.focused ? CURSOR_MARKER : '';
    const cursorChar = `\x1b[7m${atCursor}\x1b[27m`;
    const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;
    const padding = ' '.repeat(Math.max(0, availableWidth - visibleWidth(textWithCursor)));

    return [prompt + textWithCursor + padding];
  }
}

function clearTerminalScreen() {
  if (!interactiveTerminalAvailable()) {
    return;
  }
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function writeScreenTransitionGap(lines = 2) {
  if (!interactiveTerminalAvailable()) {
    return;
  }
  process.stdout.write('\n'.repeat(Math.max(0, lines)));
}

function hasText(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function trimOrNull(value) {
  if (!hasText(value)) {
    return null;
  }
  return String(value).trim();
}

function providerName(providerId) {
  return PROVIDER_NAMES[providerId] || providerId;
}

function providerLabel(providerId) {
  const label = providerName(providerId);
  if (baseChalk.level <= 0) {
    return `${label} (${providerId})`;
  }
  return `${colors.accent(label)} ${colors.muted(`(${providerId})`)}`;
}

function providerStatusTags(provider) {
  const tags = [];
  if (provider?.enabled) {
    tags.push(baseChalk.level > 0 ? colors.success('[enabled]') : '[enabled]');
  }
  if (provider?.setupComplete) {
    tags.push(baseChalk.level > 0 ? colors.success('[setup]') : '[setup]');
  }
  if (!tags.length) {
    return '';
  }
  return ` ${tags.join(' ')}`;
}

function isBuiltInProvider(providerId) {
  return Object.hasOwn(PROVIDER_NAMES, providerId);
}

function interactiveTerminalAvailable() {
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY && process.stdin?.setRawMode);
}

function parseRedirectUri(redirectUri) {
  try {
    const parsed = new URL(String(redirectUri));
    return {
      host: parsed.hostname,
      uri: parsed.toString(),
    };
  } catch {
    return {
      host: 'localhost',
      uri: String(redirectUri || ''),
    };
  }
}

function withingsApiBase(cfg) {
  const raw = String(cfg?.api_base_url || 'https://wbsapi.withings.net').trim();
  if (!raw) {
    return 'https://wbsapi.withings.net';
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function whoopApiBase(cfg) {
  const raw = String(cfg?.api_base_url || 'https://api.prod.whoop.com/developer').trim();
  if (!raw) {
    return 'https://api.prod.whoop.com/developer';
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function eightsleepApiBase(cfg) {
  const raw = String(cfg?.client_api_url || 'https://client-api.8slp.net/v1').trim();
  if (!raw) {
    return 'https://client-api.8slp.net/v1';
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function hevyApiBase(cfg) {
  const raw = String(cfg?.base_url || 'https://api.hevyapp.com').trim();
  if (!raw) {
    return 'https://api.hevyapp.com';
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function stravaOAuthConfigured(cfg) {
  return hasText(cfg?.client_id)
    && hasText(cfg?.client_secret)
    && hasText(cfg?.redirect_uri);
}

function eightsleepPasswordConfigured(cfg) {
  return hasText(cfg?.email)
    && hasText(cfg?.password);
}

function providerConfigReady(providerId, cfg) {
  if (providerId === 'oura' || providerId === 'withings' || providerId === 'whoop') {
    return hasText(cfg?.client_id)
      && hasText(cfg?.client_secret)
      && hasText(cfg?.redirect_uri);
  }
  if (providerId === 'hevy') {
    return hasText(cfg?.api_key);
  }
  if (providerId === 'strava') {
    return hasText(cfg?.access_token) || stravaOAuthConfigured(cfg);
  }
  if (providerId === 'eightsleep') {
    return hasText(cfg?.access_token) || eightsleepPasswordConfigured(cfg);
  }
  return true;
}

function tokenForCheck(providerId, cfg, db) {
  const token = db.getOAuthToken(providerId);
  if (token?.accessToken) {
    return String(token.accessToken);
  }
  if (providerId === 'strava' && hasText(cfg?.access_token)) {
    return String(cfg.access_token).trim();
  }
  if (providerId === 'eightsleep' && hasText(cfg?.access_token)) {
    return String(cfg.access_token).trim();
  }
  return null;
}

async function providerTokenHealthCheck(providerId, cfg, token) {
  const headers = providerId === 'hevy'
    ? { 'api-key': token }
    : { Authorization: `Bearer ${token}` };

  if (providerId === 'oura') {
    await requestJson('https://api.ouraring.com/v2/usercollection/personal_info', { headers });
    return 'Token accepted by Oura personal info endpoint.';
  }

  if (providerId === 'withings') {
    const payload = await requestJson(`${withingsApiBase(cfg)}/v2/user`, {
      method: 'POST',
      headers,
      data: {
        action: 'getdevice',
      },
    });
    if (payload?.status !== 0) {
      throw new Error(`Withings returned status=${payload?.status ?? 'unknown'}`);
    }
    return 'Token accepted by Withings device endpoint.';
  }

  if (providerId === 'hevy') {
    await requestJson(`${hevyApiBase(cfg)}/v1/workouts`, {
      headers,
      params: {
        page: 1,
        pageSize: 1,
      },
    });
    return 'API key accepted by Hevy workouts endpoint.';
  }

  if (providerId === 'strava') {
    await requestJson('https://www.strava.com/api/v3/athlete', { headers });
    return 'Token accepted by Strava athlete endpoint.';
  }

  if (providerId === 'whoop') {
    await requestJson(`${whoopApiBase(cfg)}/v2/user/profile/basic`, { headers });
    return 'Token accepted by WHOOP profile endpoint.';
  }

  if (providerId === 'eightsleep') {
    await requestJson(`${eightsleepApiBase(cfg)}/users/me`, { headers });
    return 'Token accepted by Eight Sleep users/me endpoint.';
  }

  return 'No built-in health check available for this provider.';
}

export async function providerAuthStatus(providerId, cfg, db) {
  const configured = providerConfigReady(providerId, cfg);

  if (providerId === 'hevy') {
    if (!configured) {
      return {
        configured: false,
        working: false,
        detail: 'Required config values are still missing.',
      };
    }
    try {
      const detail = await providerTokenHealthCheck(providerId, cfg, String(cfg.api_key).trim());
      return {
        configured: true,
        working: true,
        detail,
      };
    } catch (err) {
      return {
        configured: true,
        working: false,
        detail: err?.message || String(err),
      };
    }
  }

  const token = tokenForCheck(providerId, cfg, db);

  if (!configured || !token) {
    return {
      configured,
      working: false,
      detail: configured
        ? 'No access token saved yet.'
        : 'Required config values are still missing.',
    };
  }

  try {
    const detail = await providerTokenHealthCheck(providerId, cfg, token);
    return {
      configured,
      working: true,
      detail,
    };
  } catch (err) {
    return {
      configured,
      working: false,
      detail: err?.message || String(err),
    };
  }
}

function setupGuide(providerId, cfg) {
  const redirect = parseRedirectUri(cfg?.redirect_uri || '');

  if (providerId === 'oura') {
    return {
      title: 'Oura onboarding',
      lines: [
        '1. Open https://cloud.ouraring.com/oauth/applications in your browser.',
        '2. Click "Create New Application" (or open your existing app).',
        '3. Set any app name you like, for example "Health Sync Personal".',
        `4. Add this exact redirect URI: ${redirect.uri || 'http://localhost:8080/callback'}`,
        '5. Save, then copy the Client ID and Client Secret.',
        '6. Paste those values on the next screens.',
        `7. Keep scopes as configured: ${cfg?.scopes || 'extapi:daily extapi:heartrate extapi:personal extapi:workout extapi:session extapi:tag extapi:spo2'}`,
      ],
      fields: [
        { key: 'client_id', label: 'Client ID', required: true },
        { key: 'client_secret', label: 'Client Secret', required: true, secret: true },
        { key: 'redirect_uri', label: 'Redirect URI', required: true },
      ],
      fieldHelp: {
        client_id: 'From Oura app settings -> OAuth credentials -> Client ID.',
        client_secret: 'From Oura app settings -> OAuth credentials -> Client Secret.',
        redirect_uri: `Must match the Oura app redirect exactly. Recommended: ${redirect.uri || 'http://localhost:8080/callback'}`,
      },
      requiresAuth: true,
    };
  }

  if (providerId === 'withings') {
    return {
      title: 'Withings onboarding',
      lines: [
        '1. Open https://developer.withings.com/dashboard/',
        '2. Create an app for the Public Health Data API (or open an existing one).',
        `3. Set callback/redirect URI to: ${redirect.uri || 'http://localhost:8485/callback'}`,
        '4. Save settings and copy Client ID + Client Secret.',
        `5. Keep scopes aligned with config: ${cfg?.scopes || 'user.metrics,user.activity'}`,
        '6. Paste values below, then we run OAuth in this terminal.',
      ],
      fields: [
        { key: 'client_id', label: 'Client ID', required: true },
        { key: 'client_secret', label: 'Client Secret', required: true, secret: true },
        { key: 'redirect_uri', label: 'Redirect URI', required: true },
      ],
      fieldHelp: {
        client_id: 'Withings dashboard -> your app -> Client ID.',
        client_secret: 'Withings dashboard -> your app -> Client Secret.',
        redirect_uri: `Use the same callback URL in both Withings and health-sync: ${redirect.uri || 'http://localhost:8485/callback'}`,
      },
      requiresAuth: true,
    };
  }

  if (providerId === 'hevy') {
    return {
      title: 'Hevy onboarding',
      lines: [
        'We will now connect Hevy to Health Sync so your workouts can sync.',
        'Open https://hevy.com/settings?developer in your browser.',
        '1. Sign in to your Hevy account.',
        '2. Create or copy your API key from the Developer section (Hevy Pro required).',
        '3. Return here and paste that key on the next screen.',
      ],
      fields: [
        { key: 'api_key', label: 'API Key', required: true, secret: true },
      ],
      fieldHelp: {
        api_key: 'Hevy Settings -> Developer -> API key (https://hevy.com/settings?developer).',
      },
      fieldPrompts: {
        api_key: [
          'Insert your Hevy API key.',
        ],
      },
      requiresAuth: false,
      finalLines: [
        '- We will save this API key in [hevy].api_key.',
        '- Hevy does not use an OAuth browser flow.',
        '- After this, Hevy is ready for sync.',
      ],
    };
  }

  if (providerId === 'strava') {
    return {
      title: 'Strava onboarding',
      lines: [
        '1. Open https://www.strava.com/settings/api',
        '2. Create a Strava API application (or open your existing app).',
        `3. Set Authorization Callback Domain to: ${redirect.host || 'localhost'}`,
        `4. We will use this redirect URI in health-sync: ${redirect.uri || 'http://localhost:8486/callback'}`,
        '5. Copy the Client ID and Client Secret.',
        '6. Next screen lets you choose OAuth app mode (recommended) or static token mode.',
      ],
      fields: [
        { key: 'auth_mode', label: 'Auth mode', required: true, kind: 'choice' },
      ],
      fieldHelp: {
        client_id: 'Strava API settings page -> Client ID.',
        client_secret: 'Strava API settings page -> Client Secret.',
        redirect_uri: `Must match your Strava app callback settings. Recommended: ${redirect.uri || 'http://localhost:8486/callback'}`,
        access_token: 'Use this only for static token mode. OAuth mode is simpler for long-term refresh.',
      },
      requiresAuth: true,
    };
  }

  if (providerId === 'whoop') {
    return {
      title: 'WHOOP onboarding',
      lines: [
        '1. Open https://developer-dashboard.whoop.com/',
        '2. Create/select your WHOOP developer application.',
        `3. Add this redirect URI exactly: ${redirect.uri || 'http://localhost:8487/callback'}`,
        '4. Copy Client ID + Client Secret from the app settings page.',
        '5. Make sure scopes include `offline` so refresh tokens are issued.',
        '6. Paste values below and continue.',
      ],
      fields: [
        { key: 'client_id', label: 'Client ID', required: true },
        { key: 'client_secret', label: 'Client Secret', required: true, secret: true },
        { key: 'redirect_uri', label: 'Redirect URI', required: true },
        { key: 'scopes', label: 'Scopes', required: true },
      ],
      fieldHelp: {
        client_id: 'WHOOP dashboard -> your app -> Client ID.',
        client_secret: 'WHOOP dashboard -> your app -> Client Secret.',
        redirect_uri: `Must match WHOOP app redirect URI. Recommended: ${redirect.uri || 'http://localhost:8487/callback'}`,
        scopes: 'Keep default scopes and ensure `offline` is present for token refresh.',
      },
      requiresAuth: true,
    };
  }

  if (providerId === 'eightsleep') {
    return {
      title: 'Eight Sleep onboarding',
      lines: [
        'We will now connect your Eight Sleep account to Health Sync.',
        'No developer app setup is required for this provider.',
        '1. On the next screen, enter your Eight Sleep username or email.',
        '2. Then enter your Eight Sleep password.',
        '3. We will exchange those credentials for an access token and store it securely.',
      ],
      fields: [
        { key: 'email', label: 'Username or Email', required: true },
        { key: 'password', label: 'Password', required: true, secret: true },
      ],
      fieldHelp: {
        email: 'Use the same login username/email you use in the Eight Sleep app.',
        password: 'Use your Eight Sleep account password. It will be shown as masked stars while you type.',
      },
      fieldPrompts: {
        email: [
          'Insert your Eight Sleep username or email.',
        ],
        password: [
          'Type your Eight Sleep password.',
        ],
      },
      requiresAuth: true,
    };
  }

  return {
    title: `${providerName(providerId)} onboarding`,
    lines: [
      '1. This provider is from a plugin and has no built-in setup recipe.',
      '2. Follow the plugin docs and fill required config values.',
      '3. Then continue and health-sync will run the plugin auth flow.',
    ],
    fields: [],
    fieldHelp: {},
    requiresAuth: true,
  };
}

async function runTuiPrompt(setupFn) {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let removeAbortListener = null;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (typeof removeAbortListener === 'function') {
        removeAbortListener();
        removeAbortListener = null;
      }
      try {
        tui.stop();
        writeScreenTransitionGap(2);
      } catch {
        // no-op
      }
      resolve(value);
    };

    try {
      clearTerminalScreen();
      removeAbortListener = tui.addInputListener((data) => {
        if (matchesKey(data, Key.ctrl('c'))) {
          finish(ABORT_SENTINEL);
          return { consume: true };
        }
        return undefined;
      });
      setupFn(tui, finish);
      tui.start();
    } catch (err) {
      if (!settled) {
        settled = true;
        if (typeof removeAbortListener === 'function') {
          removeAbortListener();
          removeAbortListener = null;
        }
        try {
          tui.stop();
        } catch {
          // no-op
        }
      }
      reject(err);
    }
  });
}

function createScreenText(title, lines = [], options = {}) {
  const {
    allowOpen = false,
    openHint = null,
  } = options;

  const wrapWidth = Math.max(WRAP_MIN_WIDTH, (process.stdout?.columns || 100) - 4);
  const wrappedLines = [];
  for (const line of lines) {
    wrappedLines.push(...wrapGuideLine(line, wrapWidth));
  }

  const titleLine = baseChalk.level > 0 ? colors.heading(title) : title;
  const divider = baseChalk.level > 0
    ? colors.muted('------------------------------------------------------------')
    : '------------------------------------------------------------';
  const styledLines = wrappedLines.map((line) => {
    const value = String(line);
    if (baseChalk.level <= 0) {
      return value;
    }
    if (value.startsWith('- ')) {
      return `${colors.accent('-')} ${styleTextWithUrls(value.slice(2), colors.text)}`;
    }
    if (/^\d+\.\s/.test(value)) {
      const [prefix, ...rest] = value.split(' ');
      return `${colors.accent(prefix)} ${styleTextWithUrls(rest.join(' '), colors.text)}`;
    }
    if (/^Step\s+\d+\s+of\s+\d+/.test(value)) {
      return styleTextWithUrls(value, colors.accentSoft);
    }
    return styleTextWithUrls(value, colors.text);
  });

  const controls = baseChalk.level > 0
    ? colors.control('Use Up/Down to move')
    : 'Use Up/Down to move';
  const controls2 = baseChalk.level > 0
    ? colors.control('Enter: continue   Esc: back   Ctrl+C: exit setup')
    : 'Enter: continue   Esc: back   Ctrl+C: exit setup';
  const controls3 = allowOpen
    ? (baseChalk.level > 0
      ? colors.control('Press O to open the setup URL in your browser')
      : 'Press O to open the setup URL in your browser')
    : '';
  const openStatus = openHint
    ? (baseChalk.level > 0 ? colors.muted(String(openHint)) : String(openHint))
    : '';

  const out = ['', '', titleLine, divider, ''];
  if (wrappedLines.length) {
    out.push(...styledLines, '');
  }
  out.push(controls, controls2);
  if (controls3) {
    out.push(controls3);
  }
  if (openStatus) {
    out.push(openStatus);
  }
  out.push('');
  return out.join('\n');
}

async function promptSelect({
  title,
  lines = [],
  items,
  openableUrls = null,
}) {
  if (!interactiveTerminalAvailable()) {
    return null;
  }

  const urls = openableUrls && openableUrls.length ? openableUrls : extractUrls(lines);
  const value = await runTuiPrompt((tui, finish) => {
    const root = new Container();
    let openHint = '';
    const setHeading = () => heading.setText(createScreenText(title, lines, {
      allowOpen: urls.length > 0,
      openHint,
    }));
    const heading = new Text('', 0, 0);
    setHeading();
    const list = new SelectList(items, Math.min(12, Math.max(3, items.length)), SELECT_THEME);

    list.onSelect = (item) => {
      if (typeof removeListener === 'function') {
        removeListener();
      }
      finish(item.value);
    };
    list.onCancel = () => {
      if (typeof removeListener === 'function') {
        removeListener();
      }
      finish(null);
    };

    root.addChild(heading);
    root.addChild(new Spacer(2));
    root.addChild(list);

    tui.addChild(root);
    tui.setFocus(list);

    const removeListener = tui.addInputListener((data) => {
      if ((data === 'o' || data === 'O') && urls.length) {
        const opened = openInBrowser(urls[0]);
        openHint = opened
          ? `Opened: ${urls[0]}`
          : `Could not open browser. Open manually: ${urls[0]}`;
        setHeading();
        tui.requestRender();
        return { consume: true };
      }
      return undefined;
    });
  });

  if (value === ABORT_SENTINEL) {
    throw new UserAbortError();
  }
  return value;
}

async function promptInput({
  title,
  lines = [],
  initialValue = '',
  allowEmpty = true,
  requiredLabel = null,
  secret = false,
  openableUrls = null,
}) {
  if (!interactiveTerminalAvailable()) {
    return null;
  }

  const urls = openableUrls && openableUrls.length ? openableUrls : extractUrls(lines);
  const value = await runTuiPrompt((tui, finish) => {
    const root = new Container();
    let openHint = '';
    const setHeading = (extraLines = null) => heading.setText(createScreenText(
      title,
      extraLines || lines,
      {
        allowOpen: urls.length > 0,
        openHint,
      },
    ));
    const heading = new Text('', 0, 0);
    setHeading();
    const input = secret ? new MaskedInput() : new Input();

    if (hasText(initialValue)) {
      input.setValue(String(initialValue));
      if (typeof input.cursor === 'number') {
        input.cursor = String(initialValue).length;
      }
    }

    input.onSubmit = (rawValue) => {
      const value = String(rawValue || '').trim();
      if (!allowEmpty && !value) {
        const errorLine = requiredLabel
          ? `Value required: ${requiredLabel}`
          : 'Value required.';
        setHeading([...lines, '', errorLine]);
        tui.requestRender();
        return;
      }
      if (typeof removeListener === 'function') {
        removeListener();
      }
      finish(value);
    };

    input.onEscape = () => {
      if (typeof removeListener === 'function') {
        removeListener();
      }
      finish(null);
    };
    if (secret) {
      input.onAbort = () => finish(ABORT_SENTINEL);
    }

    root.addChild(heading);
    root.addChild(new Spacer(2));
    root.addChild(input);

    tui.addChild(root);
    tui.setFocus(input);

    const removeListener = tui.addInputListener((data) => {
      if ((data === 'o' || data === 'O') && urls.length) {
        const opened = openInBrowser(urls[0]);
        openHint = opened
          ? `Opened: ${urls[0]}`
          : `Could not open browser. Open manually: ${urls[0]}`;
        setHeading();
        tui.requestRender();
        return { consume: true };
      }
      return undefined;
    });
  });

  if (value === ABORT_SENTINEL) {
    throw new UserAbortError();
  }
  return value;
}

async function promptYesNo(
  title,
  lines,
  yesLabel = 'Yes',
  noLabel = 'No',
  options = {},
) {
  const { openableUrls = null } = options;
  const choice = await promptSelect({
    title,
    lines,
    items: [
      { value: 'yes', label: yesLabel },
      { value: 'no', label: noLabel },
    ],
    openableUrls,
  });
  if (choice === null) {
    return null;
  }
  return choice === 'yes';
}

function stagePrefixLines(progress = null, stage = null) {
  const out = [];
  if (progress && Number.isFinite(progress.index) && Number.isFinite(progress.total) && progress.total > 0) {
    out.push(`Provider ${progress.index} of ${progress.total}: ${providerName(progress.providerId || '')}`);
  }
  if (stage && Number.isFinite(stage.index) && Number.isFinite(stage.total) && stage.total > 0) {
    out.push(`Stage ${stage.index} of ${stage.total}: ${stage.label || 'Setup'}`);
  }
  if (out.length) {
    out.push('');
  }
  return out;
}

function splitScopeValues(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function validateFieldValue(providerId, field, value) {
  if (!hasText(value)) {
    return null;
  }

  if (field.key === 'redirect_uri') {
    let parsed;
    try {
      parsed = new URL(String(value));
    } catch {
      return 'Redirect URI must be a valid URL (for example: http://localhost:8486/callback).';
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Redirect URI must use http:// or https://.';
    }
    if (!hasText(parsed.pathname)) {
      return 'Redirect URI must include a callback path.';
    }
    if (!parsed.pathname.includes('callback')) {
      return 'Redirect URI should include `/callback` to match provider app settings.';
    }
  }

  if (providerId === 'whoop' && field.key === 'scopes') {
    const scopes = splitScopeValues(value);
    if (!scopes.includes('offline')) {
      return 'WHOOP scopes must include `offline` to receive refresh tokens.';
    }
  }

  if (providerId === 'strava' && field.key === 'redirect_uri') {
    let parsed;
    try {
      parsed = new URL(String(value));
    } catch {
      return null;
    }
    if (!hasText(parsed.hostname)) {
      return 'Strava redirect URI must include a hostname.';
    }
  }

  return null;
}

function normalizePromptedValue(rawValue, previousValue, required) {
  const trimmed = trimOrNull(rawValue);
  if (trimmed === null) {
    if (hasText(previousValue)) {
      return trimOrNull(previousValue);
    }
    if (required) {
      return null;
    }
    return null;
  }
  return trimmed;
}

function fieldPromptLines(
  providerId,
  field,
  currentLabel,
  guide = null,
  step = null,
  total = null,
  progress = null,
) {
  const out = [];
  out.push(...stagePrefixLines(progress, null));
  if (step !== null && total !== null) {
    out.push(`Step ${step} of ${total}`);
    out.push('');
  }

  const customPrompts = Array.isArray(guide?.fieldPrompts?.[field.key])
    ? guide.fieldPrompts[field.key]
    : null;
  if (customPrompts?.length) {
    out.push(...customPrompts);
  } else {
    out.push(`Set ${field.label} for ${providerName(providerId)}.`);
  }
  out.push('');

  if (guide?.fieldHelp?.[field.key]) {
    out.push(`How to find it: ${guide.fieldHelp[field.key]}`);
    out.push('');
  }
  out.push(`Current saved value: ${currentLabel}`);
  out.push('');
  out.push('Press Enter to keep the current value if you do not want to change it.');
  return out;
}

async function promptTextField(providerId, cfg, field, options = {}) {
  const {
    guide = null,
    step = null,
    total = null,
    progress = null,
  } = options;
  const currentValue = cfg?.[field.key];
  const isSecret = Boolean(field.secret);
  const existingSecretMask = isSecret && hasText(currentValue)
    ? secretMask(String(currentValue))
    : null;
  const currentLabel = hasText(currentValue)
    ? (isSecret ? existingSecretMask : String(currentValue))
    : '(not set)';
  const lines = fieldPromptLines(providerId, field, currentLabel, guide, step, total, progress);

  const required = Boolean(field.required);
  let validationError = null;
  const openableUrls = extractUrls([
    ...lines,
    guide?.fieldHelp?.[field.key] || '',
  ]);

  while (true) {
    const initialValue = hasText(currentValue)
      ? (isSecret ? existingSecretMask : String(currentValue))
      : '';

    const rawValue = await promptInput({
      title: `${providerName(providerId)}: ${field.label}`,
      lines: validationError ? [...lines, '', validationError] : lines,
      initialValue,
      allowEmpty: true,
      requiredLabel: field.label,
      secret: isSecret,
      openableUrls,
    });

    if (rawValue === null) {
      return { ok: false, value: null };
    }

    const normalized = isSecret && hasText(currentValue) && rawValue === existingSecretMask
      ? trimOrNull(currentValue)
      : normalizePromptedValue(rawValue, currentValue, required);
    if (required && !hasText(normalized)) {
      validationError = `Value required: ${field.label}`;
      continue;
    }

    const fieldError = validateFieldValue(providerId, field, normalized);
    if (fieldError) {
      validationError = fieldError;
      continue;
    }

    validationError = null;

    return {
      ok: true,
      value: normalized,
    };
  }
}

async function promptStravaConfig(cfg, guide = null, progress = null) {
  const mode = await promptSelect({
    title: 'Strava setup mode',
    lines: [
      ...stagePrefixLines(progress, null),
      '- OAuth app mode will ask for client_id/client_secret/redirect_uri.',
      '- Static token mode stores [strava].access_token directly.',
    ],
    items: [
      { value: 'oauth', label: 'OAuth app (recommended)' },
      { value: 'token', label: 'Static access token' },
    ],
  });

  if (!mode) {
    return { ok: false, updates: {}, back: true };
  }

  if (mode === 'token') {
    const tokenField = await promptTextField('strava', cfg, {
      key: 'access_token',
      label: 'Access Token',
      required: true,
      secret: true,
    }, { guide, step: 1, total: 1, progress });

    if (!tokenField.ok) {
      return { ok: false, updates: {}, back: true };
    }

    return {
      ok: true,
      updates: {
        access_token: tokenField.value,
      },
    };
  }

  const updates = {
    access_token: null,
  };

  const fields = [
    { key: 'client_id', label: 'Client ID', required: true },
    { key: 'client_secret', label: 'Client Secret', required: true, secret: true },
    { key: 'redirect_uri', label: 'Redirect URI', required: true },
  ];

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const value = await promptTextField('strava', cfg, field, {
      guide,
      step: i + 1,
      total: fields.length,
      progress,
    });
    if (!value.ok) {
      return { ok: false, updates: {}, back: true };
    }
    updates[field.key] = value.value;
  }

  return { ok: true, updates };
}

async function promptEightSleepConfig(cfg, guide = null, progress = null) {
  const updates = {
    access_token: null,
  };

  const fields = [
    { key: 'email', label: 'Username or Email', required: true },
    { key: 'password', label: 'Password', required: true, secret: true },
  ];

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const value = await promptTextField('eightsleep', cfg, field, {
      guide,
      step: i + 1,
      total: fields.length,
      progress,
    });
    if (!value.ok) {
      return { ok: false, updates: {}, back: true };
    }
    updates[field.key] = value.value;
  }

  return { ok: true, updates };
}

async function promptProviderConfigValues(providerId, cfg, guide, options = {}) {
  const { progress = null } = options;
  if (!interactiveTerminalAvailable() || !guide.fields.length) {
    return { ok: true, updates: {} };
  }

  if (providerId === 'strava') {
    return promptStravaConfig(cfg, guide, progress);
  }

  if (providerId === 'eightsleep') {
    return promptEightSleepConfig(cfg, guide, progress);
  }

  const updates = {};
  let i = 0;
  while (i < guide.fields.length) {
    const field = guide.fields[i];
    const value = await promptTextField(providerId, cfg, field, {
      guide,
      step: i + 1,
      total: guide.fields.length,
      progress,
    });
    if (!value.ok) {
      if (i > 0) {
        i -= 1;
        continue;
      }
      return { ok: false, updates: {}, back: true };
    }
    updates[field.key] = value.value;
    i += 1;
  }

  return { ok: true, updates };
}

export async function promptAuthProviderChecklist(providerRows) {
  if (!interactiveTerminalAvailable()) {
    return [];
  }

  const selectableIds = new Set(
    providerRows
      .filter((provider) => Boolean(provider.supportsInteractiveSetup))
      .map((provider) => provider.id),
  );

  if (!selectableIds.size) {
    return [];
  }

  const selection = await runTuiPrompt((tui, finish) => {
    const selected = new Set();
    let warningLine = '';

    const heading = new Text('', 0, 0);
    const providerById = new Map(providerRows.map((provider) => [provider.id, provider]));
    const listItems = providerRows.map((provider) => ({
      value: provider.id,
      label: '',
    }));
    const list = new SelectList(listItems, Math.min(12, Math.max(3, listItems.length)), SELECT_THEME);

    const renderHeading = () => {
      const lines = [
        '- Select one or more providers for guided setup.',
        '- Space toggles selection for the highlighted provider.',
        '- Enter continues to the next screen.',
        '- Tags: [enabled] means active in config, [setup] means credentials/token already saved.',
      ];
      if (warningLine) {
        lines.push('', warningLine);
      }
      heading.setText(createScreenText('Health Sync setup: choose providers', lines));
    };

    const refreshList = () => {
      for (const item of listItems) {
        const selectable = selectableIds.has(item.value);
        const checked = selectable
          ? (selected.has(item.value) ? '[x]' : '[ ]')
          : '[-]';
        item.label = `${checked} ${providerLabel(item.value)}${providerStatusTags(providerById.get(item.value))}`;
      }
      list.invalidate();
      tui.requestRender();
    };

    renderHeading();
    refreshList();

    const root = new Container();
    root.addChild(heading);
    root.addChild(new Spacer(2));
    root.addChild(list);
    tui.addChild(root);
    tui.setFocus(list);

    const removeListener = tui.addInputListener((data) => {
      if (matchesKey(data, Key.space)) {
        const current = list.getSelectedItem();
        if (current && selectableIds.has(current.value)) {
          if (selected.has(current.value)) {
            selected.delete(current.value);
          } else {
            selected.add(current.value);
          }
          warningLine = '';
          renderHeading();
          refreshList();
        }
        return { consume: true };
      }

      if (matchesKey(data, Key.enter)) {
        if (!selected.size) {
          warningLine = baseChalk.level > 0
            ? colors.warn('Select at least one provider to continue.')
            : 'Select at least one provider to continue.';
          renderHeading();
          tui.requestRender();
          return { consume: true };
        }
        removeListener();
        finish(Array.from(selected));
        return { consume: true };
      }

      if (matchesKey(data, Key.escape)) {
        removeListener();
        finish([]);
        return { consume: true };
      }

      return undefined;
    });
  });

  if (selection === ABORT_SENTINEL) {
    throw new UserAbortError();
  }
  return selection;
}

function configValuePreview(key, value, guide = null) {
  if (!hasText(value)) {
    return '(not set)';
  }
  const explicitSecret = Array.isArray(guide?.fields)
    && guide.fields.some((field) => field.key === key && field.secret);
  const inferredSecret = /secret|password|token|api_key/i.test(String(key));
  if (explicitSecret || inferredSecret) {
    return secretMask(String(value));
  }
  return String(value);
}

function buildProviderSummaryLines(providerId, cfg, updates, guide, progress = null, stage = null) {
  const merged = {
    ...(cfg || {}),
    ...(updates || {}),
    enabled: true,
  };
  const keys = new Set(['enabled']);
  for (const key of Object.keys(updates || {})) {
    keys.add(key);
  }
  for (const field of guide?.fields || []) {
    keys.add(field.key);
  }

  const lines = [
    ...stagePrefixLines(progress, stage),
    'Review what will be saved to health-sync.toml:',
    '',
  ];
  for (const key of keys) {
    lines.push(`- [${providerId}].${key} = ${configValuePreview(key, merged[key], guide)}`);
  }
  lines.push('');
  lines.push('You can go back to edit values before continuing.');
  return lines;
}

function shouldRunPreflight(providerId) {
  return providerId === 'hevy' || providerId === 'eightsleep';
}

async function providerSetupPreflight(providerId, cfg) {
  if (providerId === 'hevy') {
    const apiKey = trimOrNull(cfg?.api_key);
    if (!apiKey) {
      throw new Error('Hevy API key is missing.');
    }
    return providerTokenHealthCheck('hevy', cfg, apiKey);
  }

  if (providerId === 'eightsleep') {
    if (hasText(cfg?.access_token)) {
      return providerTokenHealthCheck('eightsleep', cfg, String(cfg.access_token).trim());
    }
    const email = trimOrNull(cfg?.email);
    const password = trimOrNull(cfg?.password);
    if (!email || !password) {
      throw new Error('Eight Sleep username/email and password are missing.');
    }

    const tokenPayload = await requestJson(cfg?.auth_url || 'https://auth-api.8slp.net/v1/tokens', {
      method: 'POST',
      json: {
        client_id: cfg?.client_id,
        client_secret: cfg?.client_secret,
        grant_type: 'password',
        username: email,
        password,
      },
    });

    const accessToken = tokenPayload?.access_token;
    if (!hasText(accessToken)) {
      throw new Error('Eight Sleep did not return an access token for these credentials.');
    }
    await providerTokenHealthCheck('eightsleep', cfg, String(accessToken).trim());
    return 'Credentials accepted by Eight Sleep auth and users/me endpoints.';
  }

  return null;
}

export async function promptResumeOnboardingSession(state = {}) {
  if (!interactiveTerminalAvailable()) {
    return 'resume';
  }
  const selected = Array.isArray(state?.selectedProviders) ? state.selectedProviders : [];
  const completed = Number.isFinite(state?.nextIndex) ? state.nextIndex : 0;
  const lines = [
    `Found an unfinished onboarding session (${completed}/${selected.length} providers completed).`,
    '',
    `Providers in session: ${selected.join(', ') || '(none)'}`,
    '',
    'Choose how you want to continue.',
  ];
  const choice = await promptSelect({
    title: 'Resume onboarding',
    lines,
    items: [
      { value: 'resume', label: 'Resume setup (recommended)' },
      { value: 'restart', label: 'Start over' },
    ],
  });
  if (choice === null) {
    return 'resume';
  }
  return choice;
}

export async function promptAuthFailureRecovery(providerId, errorText, progress = null) {
  if (!interactiveTerminalAvailable()) {
    return 'skip';
  }
  const lines = [
    ...stagePrefixLines(progress, null),
    `Auth failed for ${providerName(providerId)}.`,
    '',
    `Error: ${String(errorText || 'Unknown error')}`,
    '',
    'Choose what to do next.',
  ];
  const choice = await promptSelect({
    title: `${providerName(providerId)}: auth recovery`,
    lines,
    items: [
      { value: 'retry', label: 'Retry auth now' },
      { value: 'edit', label: 'Edit setup values' },
      { value: 'guide', label: 'Re-open setup guide' },
      { value: 'skip', label: 'Skip this provider' },
    ],
  });
  if (choice === null) {
    return 'retry';
  }
  return choice;
}

export async function promptSmokeTestChoice(providerIds = []) {
  if (!interactiveTerminalAvailable() || !providerIds.length) {
    return false;
  }
  const lines = [
    `Run a quick smoke sync now for: ${providerIds.join(', ')}`,
    '',
    'This verifies setup end-to-end before you leave onboarding.',
  ];
  const choice = await promptYesNo(
    'Run smoke sync check?',
    lines,
    'Run smoke sync',
    'Skip smoke sync',
  );
  return choice === true;
}

function wizardStageLabel(stageId, guide) {
  if (stageId === 'redo') {
    return 'Re-run check';
  }
  if (stageId === 'guide') {
    return 'Setup guide';
  }
  if (stageId === 'config') {
    return 'Configure values';
  }
  if (stageId === 'summary') {
    return 'Review changes';
  }
  if (stageId === 'preflight') {
    return 'Test credentials';
  }
  if (stageId === 'confirm') {
    return guide?.requiresAuth === false ? 'Save setup' : 'Connect account';
  }
  return 'Setup';
}

export async function runProviderPreAuthWizard(providerId, cfg, db, options = {}) {
  const {
    showGuide = false,
    showConfigPrompts = false,
    askRedoIfWorking = true,
    progress = null,
    startAt = null,
  } = options;

  const status = await providerAuthStatus(providerId, cfg, db);
  const guide = setupGuide(providerId, cfg);
  const canShowGuide = showGuide && interactiveTerminalAvailable();
  const canPromptConfig = showConfigPrompts && guide.fields.length > 0;
  const needsPreflight = canPromptConfig && shouldRunPreflight(providerId);

  const stages = [];
  if (askRedoIfWorking && status.configured && status.working && interactiveTerminalAvailable()) {
    stages.push('redo');
  }
  if (canShowGuide) {
    stages.push('guide');
  }
  if (canPromptConfig) {
    stages.push('config');
    stages.push('summary');
  }
  if (needsPreflight) {
    stages.push('preflight');
  }
  if (canShowGuide) {
    stages.push('confirm');
  }

  let stageCursor = 0;
  if (startAt && stages.includes(startAt)) {
    stageCursor = stages.indexOf(startAt);
  }
  let updates = {};
  let preflightDetail = null;

  while (stageCursor < stages.length) {
    const stageId = stages[stageCursor];
    const stageMeta = {
      index: stageCursor + 1,
      total: stages.length,
      label: wizardStageLabel(stageId, guide),
    };
    const stagePrefix = stagePrefixLines(progress, stageMeta);

    if (stageId === 'redo') {
      const redo = await promptYesNo(
        `${providerName(providerId)} is already configured`,
        [
          ...stagePrefix,
          status.detail,
          '',
          'Do you want to run auth again for this provider?',
        ],
        'Re-run auth',
        'Skip this provider',
      );
      if (redo === null) {
        if (stageCursor > 0) {
          stageCursor -= 1;
        }
        continue;
      }
      if (!redo) {
        return {
          proceed: false,
          updates: {},
          status,
          reason: 'skipped',
        };
      }
      stageCursor += 1;
      continue;
    }

    if (stageId === 'guide') {
      const proceed = await promptYesNo(
        guide.title,
        [...stagePrefix, ...guide.lines],
        'Continue setup',
        'Skip this provider',
        {
          openableUrls: extractUrls(guide.lines),
        },
      );

      if (proceed === null) {
        if (stageCursor > 0) {
          stageCursor -= 1;
        }
        continue;
      }
      if (!proceed) {
        return {
          proceed: false,
          updates: {},
          status,
          reason: 'skipped',
        };
      }
      stageCursor += 1;
      continue;
    }

    if (stageId === 'config') {
      const promptResult = await promptProviderConfigValues(providerId, {
        ...(cfg || {}),
        ...(updates || {}),
      }, guide, {
        progress,
      });
      if (!promptResult.ok) {
        if (promptResult.back) {
          if (stageCursor > 0) {
            stageCursor -= 1;
          }
          continue;
        }
        return {
          proceed: false,
          updates: {},
          status,
          reason: 'cancelled',
        };
      }
      updates = {
        ...updates,
        ...(promptResult.updates || {}),
      };
      stageCursor += 1;
      continue;
    }

    if (stageId === 'summary') {
      const summaryChoice = await promptSelect({
        title: `${providerName(providerId)}: review changes`,
        lines: buildProviderSummaryLines(providerId, cfg, updates, guide, progress, stageMeta),
        items: [
          { value: 'continue', label: 'Save and continue' },
          { value: 'back', label: 'Back to edit values' },
          { value: 'skip', label: 'Skip this provider' },
        ],
      });
      if (summaryChoice === null || summaryChoice === 'back') {
        if (stageCursor > 0) {
          stageCursor -= 1;
        }
        continue;
      }
      if (summaryChoice === 'skip') {
        return {
          proceed: false,
          updates: {},
          status,
          reason: 'skipped',
        };
      }
      stageCursor += 1;
      continue;
    }

    if (stageId === 'preflight') {
      const preflightChoice = await promptSelect({
        title: `${providerName(providerId)}: test setup`,
        lines: [
          ...stagePrefix,
          'Run a quick connection test before saving/connecting.',
          'This helps catch bad credentials early.',
        ],
        items: [
          { value: 'run', label: 'Run test now (recommended)' },
          { value: 'skiptest', label: 'Skip test' },
          { value: 'back', label: 'Back to edit values' },
        ],
      });

      if (preflightChoice === null || preflightChoice === 'back') {
        if (stageCursor > 0) {
          stageCursor -= 1;
        }
        continue;
      }

      if (preflightChoice === 'skiptest') {
        preflightDetail = 'Skipped setup connectivity test.';
        stageCursor += 1;
        continue;
      }

      try {
        preflightDetail = await providerSetupPreflight(providerId, {
          ...(cfg || {}),
          ...(updates || {}),
        });
        stageCursor += 1;
        continue;
      } catch (err) {
        const action = await promptSelect({
          title: `${providerName(providerId)}: test failed`,
          lines: [
            ...stagePrefix,
            err?.message || String(err),
            '',
            'Choose how to recover.',
          ],
          items: [
            { value: 'retry', label: 'Retry test' },
            { value: 'back', label: 'Back to edit values' },
            { value: 'skip', label: 'Skip this provider' },
          ],
        });
        if (action === 'retry' || action === null) {
          continue;
        }
        if (action === 'back') {
          if (stageCursor > 0) {
            stageCursor -= 1;
          }
          continue;
        }
        return {
          proceed: false,
          updates: {},
          status,
          reason: 'skipped',
        };
      }
    }

    if (stageId === 'confirm') {
      const requiresAuth = guide.requiresAuth !== false;
      const finalLines = requiresAuth
        ? [
          '- Next, health-sync will start the auth flow for this provider.',
          '- Keep this terminal open while you finish consent in the browser.',
          '- By default, health-sync waits for the browser redirect callback automatically.',
          `- For manual callback/code paste mode, run \`health-sync auth ${providerId} --local\`.`,
        ]
        : (Array.isArray(guide.finalLines) && guide.finalLines.length
          ? guide.finalLines
          : [
            '- We will save these settings to health-sync.toml.',
            '- No browser auth step is required for this provider.',
          ]);
      if (preflightDetail) {
        finalLines.unshift(`- Setup test: ${preflightDetail}`);
      }

      const startAuth = await promptYesNo(
        requiresAuth ? `${providerName(providerId)}: ready to connect` : `${providerName(providerId)}: finish setup`,
        [
          ...stagePrefix,
          ...finalLines,
        ],
        requiresAuth ? 'Start auth now' : 'Save setup',
        'Skip for now',
      );

      if (startAuth === null) {
        if (stageCursor > 0) {
          stageCursor -= 1;
        }
        continue;
      }
      if (!startAuth) {
        return {
          proceed: false,
          updates: {},
          status,
          reason: 'skipped',
        };
      }
      stageCursor += 1;
      continue;
    }
  }

  return {
    proceed: true,
    updates,
    status,
    preflightDetail,
  };
}

export function authProviderDisplayName(providerId) {
  return providerName(providerId);
}

export function hasInteractiveAuthUi() {
  return interactiveTerminalAvailable();
}

export function shouldShowBuiltInGuide(providerId) {
  return isBuiltInProvider(providerId);
}
