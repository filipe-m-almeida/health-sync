import {
  Container,
  Input,
  ProcessTerminal,
  SelectList,
  Spacer,
  TUI,
  Text,
} from '@mariozechner/pi-tui';
import { requestJson } from './util.js';

const SELECT_THEME = {
  selectedPrefix: (text) => text,
  selectedText: (text) => text,
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
};

const PROVIDER_NAMES = {
  oura: 'Oura',
  withings: 'Withings',
  strava: 'Strava',
  whoop: 'WHOOP',
  eightsleep: 'Eight Sleep',
};

function hasText(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function trimOrNull(value) {
  if (!hasText(value)) {
    return null;
  }
  return String(value).trim();
}

function defaultListDescription(provider) {
  if (provider.description) {
    return String(provider.description);
  }
  return provider.supportsAuth
    ? 'Supports authentication'
    : 'No auth flow available';
}

function providerName(providerId) {
  return PROVIDER_NAMES[providerId] || providerId;
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
  const headers = {
    Authorization: `Bearer ${token}`,
  };

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
        '- Console: https://cloud.ouraring.com/oauth/applications',
        '- OAuth docs: https://cloud.ouraring.com/docs/authentication',
        '- Create/select an application in the Oura developer console.',
        `- Set redirect URI to: ${redirect.uri || 'http://localhost:8080/callback'}`,
        '- Copy Client ID and Client Secret from the app settings.',
        `- Keep scopes aligned with health-sync config: ${cfg?.scopes || 'extapi:daily extapi:heartrate extapi:personal extapi:workout extapi:session extapi:tag extapi:spo2'}`,
        '- Continue and health-sync will run OAuth2 Authorization Code flow.',
      ],
      fields: [
        { key: 'client_id', label: 'Client ID', required: true },
        { key: 'client_secret', label: 'Client Secret', required: true, secret: true },
        { key: 'redirect_uri', label: 'Redirect URI', required: true },
      ],
    };
  }

  if (providerId === 'withings') {
    return {
      title: 'Withings onboarding',
      lines: [
        '- Integration guide: https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/developer-account/create-your-accesses-no-medical-cloud/',
        '- Dashboard: https://developer.withings.com/dashboard/',
        '- Create/select an application for the Public Health Data API.',
        `- Set callback/redirect URI to: ${redirect.uri || 'http://127.0.0.1:8485/callback'}`,
        '- Copy Client ID and Client Secret from the app settings.',
        `- Keep scopes aligned with health-sync config: ${cfg?.scopes || 'user.metrics,user.activity'}`,
        '- Continue and health-sync will run OAuth2 Authorization Code flow.',
      ],
      fields: [
        { key: 'client_id', label: 'Client ID', required: true },
        { key: 'client_secret', label: 'Client Secret', required: true, secret: true },
        { key: 'redirect_uri', label: 'Redirect URI', required: true },
      ],
    };
  }

  if (providerId === 'strava') {
    return {
      title: 'Strava onboarding',
      lines: [
        '- App settings: https://www.strava.com/settings/api',
        '- OAuth docs: https://developers.strava.com/docs/authentication',
        '- Create/select a Strava API app.',
        `- Set Authorization Callback Domain to: ${redirect.host || '127.0.0.1'}`,
        `- Use redirect URI in health-sync: ${redirect.uri || 'http://127.0.0.1:8486/callback'}`,
        '- Copy Client ID and Client Secret from the app settings.',
        '- Continue and health-sync will run OAuth2 Authorization Code flow, or use static token mode.',
      ],
      fields: [
        { key: 'auth_mode', label: 'Auth mode', required: true, kind: 'choice' },
      ],
    };
  }

  if (providerId === 'whoop') {
    return {
      title: 'WHOOP onboarding',
      lines: [
        '- Developer dashboard: https://developer-dashboard.whoop.com/',
        '- Getting started docs: https://developer.whoop.com/docs/developing/getting-started',
        '- OAuth docs: https://developer.whoop.com/docs/developing/oauth',
        '- Create/select a WHOOP app in the dashboard.',
        `- Set redirect URI to: ${redirect.uri || 'http://127.0.0.1:8487/callback'}`,
        '- Copy Client ID and Client Secret from app settings.',
        '- Ensure scopes include `offline` so refresh tokens are returned.',
        '- Continue and health-sync will run OAuth2 Authorization Code flow.',
      ],
      fields: [
        { key: 'client_id', label: 'Client ID', required: true },
        { key: 'client_secret', label: 'Client Secret', required: true, secret: true },
        { key: 'redirect_uri', label: 'Redirect URI', required: true },
        { key: 'scopes', label: 'Scopes', required: true },
      ],
    };
  }

  if (providerId === 'eightsleep') {
    return {
      title: 'Eight Sleep onboarding',
      lines: [
        '- No OAuth app registration is required for this provider.',
        '- Use either account credentials (email/password) or an access token.',
        `- Auth URL used by health-sync: ${cfg?.auth_url || 'https://auth-api.8slp.net/v1/tokens'}`,
        `- API base used by health-sync: ${eightsleepApiBase(cfg)}`,
        '- Continue and health-sync will exchange credentials and save tokens to .health-sync.creds.',
      ],
      fields: [
        { key: 'auth_mode', label: 'Auth mode', required: true, kind: 'choice' },
      ],
    };
  }

  return {
    title: `${providerName(providerId)} onboarding`,
    lines: [
      '- This provider is discovered via plugin and does not have built-in setup docs.',
      '- Configure required settings in health-sync.toml for this plugin.',
      '- Then continue and health-sync will run the plugin auth flow.',
    ],
    fields: [],
  };
}

async function runTuiPrompt(setupFn) {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  return await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        tui.stop();
      } catch {
        // no-op
      }
      resolve(value);
    };

    try {
      setupFn(tui, finish);
      tui.start();
    } catch (err) {
      if (!settled) {
        settled = true;
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
  const out = [title, ''];
  if (lines.length) {
    out.push(...lines, '');
  }
  out.push('Use Up/Down to move, Enter to select, Esc to cancel.');
  return out.join('\n');
}

async function promptSelect({ title, lines = [], items }) {
  if (!interactiveTerminalAvailable()) {
    return null;
  }

  return await runTuiPrompt((tui, finish) => {
    const root = new Container();
    const heading = new Text(createScreenText(title, lines), 0, 0);
    const list = new SelectList(items, Math.min(12, Math.max(3, items.length)), SELECT_THEME);

    list.onSelect = (item) => finish(item.value);
    list.onCancel = () => finish(null);

    root.addChild(heading);
    root.addChild(new Spacer(1));
    root.addChild(list);

    tui.addChild(root);
    tui.setFocus(list);
  });
}

async function promptInput({
  title,
  lines = [],
  initialValue = '',
  allowEmpty = true,
  requiredLabel = null,
}) {
  if (!interactiveTerminalAvailable()) {
    return null;
  }

  return await runTuiPrompt((tui, finish) => {
    const root = new Container();
    const heading = new Text(createScreenText(title, lines), 0, 0);
    const input = new Input();

    if (hasText(initialValue)) {
      input.setValue(String(initialValue));
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

    root.addChild(heading);
    root.addChild(new Spacer(1));
    root.addChild(input);

    tui.addChild(root);
    tui.setFocus(input);
  });
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

async function promptTextField(providerId, cfg, field) {
  const currentValue = cfg?.[field.key];
  const isSecret = Boolean(field.secret);

  if (isSecret && hasText(currentValue)) {
    const keep = await promptYesNo(
      `${providerName(providerId)}: ${field.label}`,
      [
        'A value is already set in health-sync.toml.',
        'Keep the existing value?',
      ],
      'Keep existing',
      'Enter new value',
    );
    if (keep) {
      return {
        ok: true,
        value: trimOrNull(currentValue),
      };
    }
  }

  const currentLabel = hasText(currentValue)
    ? (isSecret ? '(already set)' : String(currentValue))
    : '(not set)';

  const lines = [
    `Field: [${providerId}].${field.key}`,
    `Current value: ${currentLabel}`,
    'Press Enter to keep the current value when available.',
  ];

  const required = Boolean(field.required);

  while (true) {
    const initialValue = !isSecret && hasText(currentValue)
      ? String(currentValue)
      : '';

    const rawValue = await promptInput({
      title: `${providerName(providerId)}: ${field.label}`,
      lines,
      initialValue,
      allowEmpty: true,
      requiredLabel: field.label,
    });

    if (rawValue === null) {
      return { ok: false, value: null };
    }

    const normalized = normalizePromptedValue(rawValue, currentValue, required);
    if (required && !hasText(normalized)) {
      continue;
    }

    return {
      ok: true,
      value: normalized,
    };
  }
}

async function promptStravaConfig(cfg) {
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
    });

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

  for (const field of [
    { key: 'client_id', label: 'Client ID', required: true },
    { key: 'client_secret', label: 'Client Secret', required: true, secret: true },
    { key: 'redirect_uri', label: 'Redirect URI', required: true },
  ]) {
    const value = await promptTextField('strava', cfg, field);
    if (!value.ok) {
      return { ok: false, updates: {} };
    }
    updates[field.key] = value.value;
  }

  return { ok: true, updates };
}

async function promptEightSleepConfig(cfg) {
  const mode = await promptSelect({
    title: 'Eight Sleep setup mode',
    lines: [
      '- Email/password mode uses your Eight Sleep account login.',
      '- Access token mode stores [eightsleep].access_token directly.',
    ],
    items: [
      { value: 'password', label: 'Email + password (recommended)' },
      { value: 'token', label: 'Static access token' },
    ],
  });

  if (!mode) {
    return { ok: false, updates: {} };
  }

  if (mode === 'token') {
    const tokenField = await promptTextField('eightsleep', cfg, {
      key: 'access_token',
      label: 'Access Token',
      required: true,
      secret: true,
    });
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

  for (const field of [
    { key: 'email', label: 'Account Email', required: true },
    { key: 'password', label: 'Account Password', required: true, secret: true },
  ]) {
    const value = await promptTextField('eightsleep', cfg, field);
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
    return promptStravaConfig(cfg);
  }

  if (providerId === 'eightsleep') {
    return promptEightSleepConfig(cfg);
  }

  const updates = {};
  for (const field of guide.fields) {
    const value = await promptTextField(providerId, cfg, field);
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
      .filter((provider) => provider.supportsAuth)
      .map((provider) => provider.id),
  );

  if (!selectableIds.size) {
    return [];
  }

  const selected = new Set();

  while (true) {
    const items = [
      ...providerRows.map((provider) => {
        const selectable = selectableIds.has(provider.id);
        const checked = selectable
          ? (selected.has(provider.id) ? '[x]' : '[ ]')
          : '[-]';
        return {
          value: provider.id,
          label: `${checked} ${providerName(provider.id)} (${provider.id})`,
          description: selectable
            ? defaultListDescription(provider)
            : `${defaultListDescription(provider)} (auth not supported)`,
        };
      }),
      {
        value: '__continue__',
        label: `Continue (${selected.size} selected)`,
        description: selected.size ? 'Run guided setup for selected providers' : 'Select at least one provider first',
      },
    ];

    const choice = await promptSelect({
      title: 'Health Sync setup: choose providers',
      lines: [
        '- Select one or more providers for guided setup.',
        '- You can toggle providers multiple times before continuing.',
      ],
      items,
    });

    if (!choice) {
      return [];
    }

    if (choice === '__continue__') {
      if (selected.size) {
        return Array.from(selected);
      }
      continue;
    }

    if (!selectableIds.has(choice)) {
      continue;
    }

    if (selected.has(choice)) {
      selected.delete(choice);
    } else {
      selected.add(choice);
    }
  }
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
