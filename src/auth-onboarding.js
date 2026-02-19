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
import { requestJson } from './util.js';

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

    const hasControlChars = [...data].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    });
    if (hasControlChars || data.startsWith('\u001b')) {
      return;
    }

    const inserted = graphemes(data);
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
      host: '127.0.0.1',
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
        `3. Set callback/redirect URI to: ${redirect.uri || 'http://127.0.0.1:8485/callback'}`,
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
        redirect_uri: `Use the same callback URL in both Withings and health-sync: ${redirect.uri || 'http://127.0.0.1:8485/callback'}`,
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
        `3. Set Authorization Callback Domain to: ${redirect.host || '127.0.0.1'}`,
        `4. We will use this redirect URI in health-sync: ${redirect.uri || 'http://127.0.0.1:8486/callback'}`,
        '5. Copy the Client ID and Client Secret.',
        '6. Next screen lets you choose OAuth app mode (recommended) or static token mode.',
      ],
      fields: [
        { key: 'auth_mode', label: 'Auth mode', required: true, kind: 'choice' },
      ],
      fieldHelp: {
        client_id: 'Strava API settings page -> Client ID.',
        client_secret: 'Strava API settings page -> Client Secret.',
        redirect_uri: `Must match your Strava app callback settings. Recommended: ${redirect.uri || 'http://127.0.0.1:8486/callback'}`,
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
        `3. Add this redirect URI exactly: ${redirect.uri || 'http://127.0.0.1:8487/callback'}`,
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
        redirect_uri: `Must match WHOOP app redirect URI. Recommended: ${redirect.uri || 'http://127.0.0.1:8487/callback'}`,
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
        password: 'Use your Eight Sleep account password. It will be shown as *** while you type.',
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

function createScreenText(title, lines = []) {
  const titleLine = baseChalk.level > 0 ? colors.heading(title) : title;
  const divider = baseChalk.level > 0
    ? colors.muted('------------------------------------------------------------')
    : '------------------------------------------------------------';
  const styledLines = lines.map((line) => {
    const value = String(line);
    if (baseChalk.level <= 0) {
      return value;
    }
    if (value.startsWith('- ')) {
      return `${colors.accent('-')} ${colors.text(value.slice(2))}`;
    }
    if (/^\d+\.\s/.test(value)) {
      const [prefix, ...rest] = value.split(' ');
      return `${colors.accent(prefix)} ${colors.text(rest.join(' '))}`;
    }
    if (/^Step\s+\d+\s+of\s+\d+/.test(value)) {
      return colors.accentSoft(value);
    }
    return colors.text(value);
  });

  const controls = baseChalk.level > 0
    ? colors.control('Use Up/Down to move')
    : 'Use Up/Down to move';
  const controls2 = baseChalk.level > 0
    ? colors.control('Enter: continue   Esc: back   Ctrl+C: exit setup')
    : 'Enter: continue   Esc: back   Ctrl+C: exit setup';

  const out = ['', '', titleLine, divider, ''];
  if (lines.length) {
    out.push(...styledLines, '');
  }
  out.push(controls, controls2, '');
  return out.join('\n');
}

async function promptSelect({ title, lines = [], items }) {
  if (!interactiveTerminalAvailable()) {
    return null;
  }

  const value = await runTuiPrompt((tui, finish) => {
    const root = new Container();
    const heading = new Text(createScreenText(title, lines), 0, 0);
    const list = new SelectList(items, Math.min(12, Math.max(3, items.length)), SELECT_THEME);

    list.onSelect = (item) => finish(item.value);
    list.onCancel = () => finish(null);

    root.addChild(heading);
    root.addChild(new Spacer(2));
    root.addChild(list);

    tui.addChild(root);
    tui.setFocus(list);
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
}) {
  if (!interactiveTerminalAvailable()) {
    return null;
  }

  const value = await runTuiPrompt((tui, finish) => {
    const root = new Container();
    const heading = new Text(createScreenText(title, lines), 0, 0);
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
        heading.setText(createScreenText(title, [...lines, '', errorLine]));
        tui.requestRender();
        return;
      }
      finish(value);
    };

    input.onEscape = () => finish(null);
    if (secret) {
      input.onAbort = () => finish(ABORT_SENTINEL);
    }

    root.addChild(heading);
    root.addChild(new Spacer(2));
    root.addChild(input);

    tui.addChild(root);
    tui.setFocus(input);
  });

  if (value === ABORT_SENTINEL) {
    throw new UserAbortError();
  }
  return value;
}

async function promptYesNo(title, lines, yesLabel = 'Yes', noLabel = 'No') {
  const choice = await promptSelect({
    title,
    lines,
    items: [
      { value: 'yes', label: yesLabel },
      { value: 'no', label: noLabel },
    ],
  });
  if (choice === null) {
    return false;
  }
  return choice === 'yes';
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

function fieldPromptLines(providerId, field, currentLabel, guide = null, step = null, total = null) {
  const out = [];
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
  const { guide = null, step = null, total = null } = options;
  const currentValue = cfg?.[field.key];
  const isSecret = Boolean(field.secret);
  const existingSecretMask = isSecret && hasText(currentValue)
    ? secretMask(String(currentValue))
    : null;
  const currentLabel = hasText(currentValue)
    ? (isSecret ? existingSecretMask : String(currentValue))
    : '(not set)';
  const lines = fieldPromptLines(providerId, field, currentLabel, guide, step, total);

  const required = Boolean(field.required);

  while (true) {
    const initialValue = hasText(currentValue)
      ? (isSecret ? existingSecretMask : String(currentValue))
      : '';

    const rawValue = await promptInput({
      title: `${providerName(providerId)}: ${field.label}`,
      lines,
      initialValue,
      allowEmpty: true,
      requiredLabel: field.label,
      secret: isSecret,
    });

    if (rawValue === null) {
      return { ok: false, value: null };
    }

    const normalized = isSecret && hasText(currentValue) && rawValue === existingSecretMask
      ? trimOrNull(currentValue)
      : normalizePromptedValue(rawValue, currentValue, required);
    if (required && !hasText(normalized)) {
      continue;
    }

    return {
      ok: true,
      value: normalized,
    };
  }
}

async function promptStravaConfig(cfg, guide = null) {
  const mode = await promptSelect({
    title: 'Strava setup mode',
    lines: [
      '- OAuth app mode will ask for client_id/client_secret/redirect_uri.',
      '- Static token mode stores [strava].access_token directly.',
    ],
    items: [
      { value: 'oauth', label: 'OAuth app (recommended)' },
      { value: 'token', label: 'Static access token' },
    ],
  });

  if (!mode) {
    return { ok: false, updates: {} };
  }

  if (mode === 'token') {
    const tokenField = await promptTextField('strava', cfg, {
      key: 'access_token',
      label: 'Access Token',
      required: true,
      secret: true,
    }, { guide, step: 1, total: 1 });

    if (!tokenField.ok) {
      return { ok: false, updates: {} };
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
    });
    if (!value.ok) {
      return { ok: false, updates: {} };
    }
    updates[field.key] = value.value;
  }

  return { ok: true, updates };
}

async function promptEightSleepConfig(cfg, guide = null) {
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
    });
    if (!value.ok) {
      return { ok: false, updates: {} };
    }
    updates[field.key] = value.value;
  }

  return { ok: true, updates };
}

async function promptProviderConfigValues(providerId, cfg, guide) {
  if (!interactiveTerminalAvailable() || !guide.fields.length) {
    return { ok: true, updates: {} };
  }

  if (providerId === 'strava') {
    return promptStravaConfig(cfg, guide);
  }

  if (providerId === 'eightsleep') {
    return promptEightSleepConfig(cfg, guide);
  }

  const updates = {};
  for (let i = 0; i < guide.fields.length; i += 1) {
    const field = guide.fields[i];
    const value = await promptTextField(providerId, cfg, field, {
      guide,
      step: i + 1,
      total: guide.fields.length,
    });
    if (!value.ok) {
      return { ok: false, updates: {} };
    }
    updates[field.key] = value.value;
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

export async function runProviderPreAuthWizard(providerId, cfg, db, options = {}) {
  const {
    showGuide = false,
    showConfigPrompts = false,
    askRedoIfWorking = true,
  } = options;

  const status = await providerAuthStatus(providerId, cfg, db);

  if (askRedoIfWorking && status.configured && status.working && interactiveTerminalAvailable()) {
    const redo = await promptYesNo(
      `${providerName(providerId)} is already configured`,
      [
        status.detail,
        '',
        'Do you want to run auth again for this provider?',
      ],
      'Re-run auth',
      'Skip this provider',
    );

    if (!redo) {
      return {
        proceed: false,
        updates: {},
        status,
      };
    }
  }

  const guide = setupGuide(providerId, cfg);

  if (showGuide && interactiveTerminalAvailable()) {
    const proceed = await promptYesNo(
      guide.title,
      guide.lines,
      'Continue setup',
      'Skip this provider',
    );

    if (!proceed) {
      return {
        proceed: false,
        updates: {},
        status,
      };
    }
  }

  let updates = {};

  if (showConfigPrompts) {
    const promptResult = await promptProviderConfigValues(providerId, cfg, guide);
    if (!promptResult.ok) {
      return {
        proceed: false,
        updates: {},
        status,
      };
    }
    updates = promptResult.updates;
  }

  if (showGuide && interactiveTerminalAvailable()) {
    const requiresAuth = guide.requiresAuth !== false;
    const startAuth = await promptYesNo(
      requiresAuth ? `${providerName(providerId)}: ready to connect` : `${providerName(providerId)}: finish setup`,
      requiresAuth
        ? [
          '- Next, health-sync will start the auth flow for this provider.',
          '- Keep this terminal open while you finish consent in the browser.',
          '- If redirected callback fails, paste the callback URL/code back into this terminal.',
        ]
        : (Array.isArray(guide.finalLines) && guide.finalLines.length
          ? guide.finalLines
          : [
            '- We will save these settings to health-sync.toml.',
            '- No browser auth step is required for this provider.',
          ]),
      requiresAuth ? 'Start auth now' : 'Save setup',
      'Skip for now',
    );

    if (!startAuth) {
      return {
        proceed: false,
        updates: {},
        status,
      };
    }
  }

  return {
    proceed: true,
    updates,
    status,
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
