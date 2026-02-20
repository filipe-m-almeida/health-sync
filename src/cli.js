import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initConfigFile,
  loadConfig,
  updateProviderConfigValues,
} from './config.js';
import { openDb } from './db.js';
import { PluginHelpers, providerEnabled } from './plugins/base.js';
import { loadProviders } from './plugins/loader.js';
import { setRequestJsonVerbose } from './util.js';
import {
  BOOTSTRAP_TOKEN_PREFIX,
  bootstrapStoreDir,
  buildRemotePayloadFromFiles,
  createBootstrapSession,
  defaultRemoteArchivePath,
  encryptRemotePayload,
  importRemoteArchive,
  parseBootstrapToken,
  parseDurationToSeconds,
  writeRemoteArchiveFile,
} from './remote-bootstrap.js';
import {
  authProviderDisplayName,
  hasInteractiveAuthUi,
  isUserAbortError,
  promptAuthFailureRecovery,
  promptAuthProviderChecklist,
  promptResumeOnboardingSession,
  promptSmokeTestChoice,
  runProviderPreAuthWizard,
  shouldShowBuiltInGuide,
} from './auth-onboarding.js';

const DEFAULT_CONFIG_PATH = 'health-sync.toml';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.resolve(MODULE_DIR, '../package.json');

let cachedVersion = null;

function cliVersion() {
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    cachedVersion = raw?.version ? String(raw.version) : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }

  return cachedVersion;
}

function parseGlobalOptions(argv) {
  let configPath = DEFAULT_CONFIG_PATH;
  let dbPath = null;
  let showVersion = false;
  const remaining = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      i += 1;
      if (i >= argv.length) {
        throw new Error('--config requires a value');
      }
      configPath = argv[i];
      continue;
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      continue;
    }
    if (arg === '--db') {
      i += 1;
      if (i >= argv.length) {
        throw new Error('--db requires a value');
      }
      dbPath = argv[i];
      continue;
    }
    if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      showVersion = true;
      continue;
    }
    remaining.push(arg);
  }

  return { configPath, dbPath, showVersion, remaining };
}

function parseAuthArgs(args) {
  const out = {
    provider: null,
    listenHost: '127.0.0.1',
    listenPort: 0,
    local: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--listen-host') {
      i += 1;
      if (i >= args.length) {
        throw new Error('--listen-host requires a value');
      }
      out.listenHost = args[i];
      continue;
    }
    if (arg.startsWith('--listen-host=')) {
      out.listenHost = arg.slice('--listen-host='.length);
      continue;
    }
    if (arg === '--listen-port') {
      i += 1;
      if (i >= args.length) {
        throw new Error('--listen-port requires a value');
      }
      out.listenPort = Number.parseInt(args[i], 10) || 0;
      continue;
    }
    if (arg.startsWith('--listen-port=')) {
      out.listenPort = Number.parseInt(arg.slice('--listen-port='.length), 10) || 0;
      continue;
    }
    if (arg === '--local') {
      out.local = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown auth option: ${arg}`);
    }
    if (!out.provider) {
      if (arg === '-h' || arg === '--help') {
        throw new Error('auth requires PROVIDER argument (e.g. health-sync auth oura)');
      }
      if (arg.startsWith('-')) {
        throw new Error(`Invalid provider id: ${arg}`);
      }
      out.provider = arg;
      continue;
    }
    throw new Error(`Unexpected auth argument: ${arg}`);
  }

  if (!out.provider) {
    throw new Error('auth requires PROVIDER argument');
  }

  return out;
}

function parseSyncArgs(args) {
  const out = {
    providers: [],
    verbose: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-v' || arg === '--verbose') {
      out.verbose = true;
      continue;
    }
    if (arg === '--providers') {
      let consumed = false;
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        consumed = true;
        const raw = args[i + 1];
        for (const piece of String(raw).split(',').map((v) => v.trim()).filter(Boolean)) {
          out.providers.push(piece);
        }
        i += 1;
      }
      if (!consumed) {
        throw new Error('--providers requires one or more provider ids');
      }
      continue;
    }
    if (arg.startsWith('--providers=')) {
      const raw = arg.slice('--providers='.length);
      for (const piece of raw.split(',').map((v) => v.trim()).filter(Boolean)) {
        out.providers.push(piece);
      }
      continue;
    }
    throw new Error(`Unknown sync option: ${arg}`);
  }

  return out;
}

function parseProvidersArgs(args) {
  const out = { verbose: false };
  for (const arg of args) {
    if (arg === '--verbose') {
      out.verbose = true;
      continue;
    }
    throw new Error(`Unknown providers option: ${arg}`);
  }
  return out;
}

function parseInitRemoteBootstrapArgs(args) {
  const out = {
    mode: 'remote-bootstrap',
    expiresInSeconds: parseDurationToSeconds(null),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--expires-in') {
      i += 1;
      if (i >= args.length) {
        throw new Error('--expires-in requires a value');
      }
      out.expiresInSeconds = parseDurationToSeconds(args[i]);
      continue;
    }
    if (arg.startsWith('--expires-in=')) {
      out.expiresInSeconds = parseDurationToSeconds(arg.slice('--expires-in='.length));
      continue;
    }
    throw new Error(`Unknown init remote bootstrap option: ${arg}`);
  }

  return out;
}

function parseInitRemoteRunArgs(args) {
  const out = {
    mode: 'remote-run',
    bootstrapToken: null,
    outputPath: null,
    purgeLocal: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--output') {
      i += 1;
      if (i >= args.length) {
        throw new Error('--output requires a value');
      }
      out.outputPath = args[i];
      continue;
    }
    if (arg.startsWith('--output=')) {
      out.outputPath = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--keep-local') {
      out.purgeLocal = false;
      continue;
    }
    if (arg === '--purge-local') {
      out.purgeLocal = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown init remote run option: ${arg}`);
    }
    if (!out.bootstrapToken) {
      out.bootstrapToken = arg;
      continue;
    }
    throw new Error(`Unexpected init remote run argument: ${arg}`);
  }

  if (!out.bootstrapToken) {
    throw new Error(`init remote run requires BOOTSTRAP_TOKEN (prefix: ${BOOTSTRAP_TOKEN_PREFIX})`);
  }
  return out;
}

function parseInitRemoteFinishArgs(args) {
  const out = {
    mode: 'remote-finish',
    sessionRef: null,
    archivePath: null,
    targetConfigPath: null,
    targetCredsPath: null,
    assumeYes: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--target-config') {
      i += 1;
      if (i >= args.length) {
        throw new Error('--target-config requires a value');
      }
      out.targetConfigPath = args[i];
      continue;
    }
    if (arg.startsWith('--target-config=')) {
      out.targetConfigPath = arg.slice('--target-config='.length);
      continue;
    }
    if (arg === '--target-creds') {
      i += 1;
      if (i >= args.length) {
        throw new Error('--target-creds requires a value');
      }
      out.targetCredsPath = args[i];
      continue;
    }
    if (arg.startsWith('--target-creds=')) {
      out.targetCredsPath = arg.slice('--target-creds='.length);
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      out.assumeYes = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown init remote finish option: ${arg}`);
    }
    if (!out.sessionRef) {
      out.sessionRef = arg;
      continue;
    }
    if (!out.archivePath) {
      out.archivePath = arg;
      continue;
    }
    throw new Error(`Unexpected init remote finish argument: ${arg}`);
  }

  if (!out.sessionRef || !out.archivePath) {
    throw new Error('init remote finish requires SESSION_REF and ARCHIVE_PATH');
  }

  return out;
}

function parseInitArgs(args) {
  if (!args.length) {
    return { mode: 'local' };
  }

  if (args[0] === 'remote') {
    if (args.length < 2) {
      throw new Error('init remote requires a subcommand: bootstrap, run, or finish');
    }
    const subcommand = args[1];
    const rest = args.slice(2);
    if (subcommand === 'bootstrap') {
      return parseInitRemoteBootstrapArgs(rest);
    }
    if (subcommand === 'run') {
      return parseInitRemoteRunArgs(rest);
    }
    if (subcommand === 'finish') {
      return parseInitRemoteFinishArgs(rest);
    }
    throw new Error(`Unknown init remote subcommand: ${subcommand}`);
  }

  if (args[0] === '--remote-bootstrap') {
    return parseInitRemoteBootstrapArgs(args.slice(1));
  }
  if (args[0] === '--remote') {
    return parseInitRemoteRunArgs(args.slice(1));
  }
  if (args[0].startsWith('--remote=')) {
    const token = args[0].slice('--remote='.length);
    return parseInitRemoteRunArgs([token, ...args.slice(1)]);
  }
  if (args[0] === '--remote-bootstrap-finish') {
    return parseInitRemoteFinishArgs(args.slice(1));
  }

  throw new Error(`Unexpected init arguments: ${args.join(' ')}`);
}

function parseArgs(argv) {
  const global = parseGlobalOptions(argv);
  const [command, ...rest] = global.remaining;

  if (global.showVersion) {
    if (command) {
      throw new Error('--version cannot be combined with a command');
    }
    return {
      command: 'version',
      configPath: global.configPath,
      dbPath: global.dbPath,
      options: {},
    };
  }

  if (!command) {
    return {
      command: null,
      configPath: global.configPath,
      dbPath: global.dbPath,
      options: {},
    };
  }

  const parsed = {
    command,
    configPath: global.configPath,
    dbPath: global.dbPath,
    options: {},
  };

  if (command === 'auth') {
    parsed.options = parseAuthArgs(rest);
    return parsed;
  }
  if (command === 'sync') {
    parsed.options = parseSyncArgs(rest);
    return parsed;
  }
  if (command === 'providers') {
    parsed.options = parseProvidersArgs(rest);
    return parsed;
  }
  if (command === 'init') {
    parsed.options = parseInitArgs(rest);
    return parsed;
  }
  if (command === 'init-db' || command === 'status') {
    if (rest.length) {
      throw new Error(`Unexpected ${command} arguments: ${rest.join(' ')}`);
    }
    return parsed;
  }

  throw new Error(`Unknown command: ${command}`);
}

function resolveDbPath(overrideDbPath, loadedConfig) {
  if (overrideDbPath) {
    return overrideDbPath;
  }
  if (loadedConfig?.data?.app?.db) {
    return loadedConfig.data.app.db;
  }
  return './health.sqlite';
}

function resolveCredsPath(configPath) {
  return path.join(path.dirname(path.resolve(configPath)), '.health-sync.creds');
}

function enableHint(providerId) {
  const builtin = new Set(['oura', 'withings', 'hevy', 'strava', 'whoop', 'eightsleep']);
  if (builtin.has(providerId)) {
    return `[${providerId}].enabled = true`;
  }
  return `[plugins.${providerId}].enabled = true`;
}

function configSectionForProvider(configData, providerId) {
  if (configData?.[providerId] && typeof configData[providerId] === 'object') {
    return configData[providerId];
  }
  if (configData?.plugins?.[providerId] && typeof configData.plugins[providerId] === 'object') {
    return configData.plugins[providerId];
  }
  return {};
}

function hasText(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function hasSavedAccessToken(providerId, section, db) {
  const token = db.getOAuthToken(providerId);
  if (token?.accessToken) {
    return true;
  }
  if (providerId === 'strava' || providerId === 'eightsleep') {
    return hasText(section?.access_token);
  }
  return false;
}

function providerLikelySetup(providerId, section, db, supportsAuth) {
  if (providerId === 'hevy') {
    return hasText(section?.api_key);
  }

  if (providerId === 'oura' || providerId === 'withings' || providerId === 'whoop') {
    const hasOauthConfig = hasText(section?.client_id)
      && hasText(section?.client_secret)
      && hasText(section?.redirect_uri);
    return hasOauthConfig && hasSavedAccessToken(providerId, section, db);
  }

  if (providerId === 'strava') {
    if (hasText(section?.access_token)) {
      return true;
    }
    const hasOauthConfig = hasText(section?.client_id)
      && hasText(section?.client_secret)
      && hasText(section?.redirect_uri);
    return hasOauthConfig && hasSavedAccessToken(providerId, section, db);
  }

  if (providerId === 'eightsleep') {
    return hasSavedAccessToken(providerId, section, db);
  }

  if (!supportsAuth) {
    return false;
  }

  return hasSavedAccessToken(providerId, section, db);
}

function onboardingStatePath(configPath) {
  return path.join(path.dirname(path.resolve(configPath)), '.health-sync.onboarding-state.json');
}

function loadOnboardingState(configPath) {
  const statePath = onboardingStatePath(configPath);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!Array.isArray(parsed?.selectedProviders)) {
      return null;
    }
    return {
      path: statePath,
      selectedProviders: parsed.selectedProviders.map((id) => String(id)),
      nextIndex: Number.isFinite(parsed.nextIndex) ? Math.max(0, Math.trunc(parsed.nextIndex)) : 0,
      results: Array.isArray(parsed.results) ? parsed.results : [],
      updatedAt: parsed.updatedAt || null,
      createdAt: parsed.createdAt || null,
    };
  } catch {
    return null;
  }
}

function saveOnboardingState(configPath, state) {
  const statePath = onboardingStatePath(configPath);
  const payload = {
    selectedProviders: Array.isArray(state?.selectedProviders) ? state.selectedProviders : [],
    nextIndex: Number.isFinite(state?.nextIndex) ? Math.max(0, Math.trunc(state.nextIndex)) : 0,
    results: Array.isArray(state?.results) ? state.results : [],
    createdAt: state?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2));
  return statePath;
}

function clearOnboardingState(configPath) {
  const statePath = onboardingStatePath(configPath);
  if (!fs.existsSync(statePath)) {
    return;
  }
  fs.unlinkSync(statePath);
}

function printOnboardingCompletionReport(summary = {}, smoke = null) {
  const {
    configured = [],
    skipped = [],
    failed = [],
  } = summary;

  console.log('');
  console.log('Onboarding Summary:');
  console.log(`  configured: ${configured.length ? configured.join(', ') : '(none)'}`);
  console.log(`  skipped:    ${skipped.length ? skipped.join(', ') : '(none)'}`);
  console.log(`  failed:     ${failed.length ? failed.map((item) => item.providerId).join(', ') : '(none)'}`);

  if (smoke && Array.isArray(smoke.results) && smoke.results.length) {
    console.log('');
    console.log('Smoke Sync Results:');
    for (const result of smoke.results) {
      if (result.ok) {
        console.log(`  PASS ${result.providerId}`);
      } else {
        console.log(`  FAIL ${result.providerId}: ${result.error}`);
      }
    }
  }

  console.log('');
  console.log('Next commands:');
  console.log('  health-sync sync');
  console.log('  health-sync status');
}

function requireProvider(context, providerId) {
  const plugin = context.providers.get(providerId);
  if (!plugin) {
    const known = context.providers.size
      ? Array.from(context.providers.keys()).sort().join(', ')
      : '(none)';
    throw new Error(
      `Unknown provider \`${providerId}\`. `
      + `Available providers: ${known}. `
      + 'Use `health-sync providers` to inspect discovery/config status.',
    );
  }
  return plugin;
}

function requireAuthPlugin(context, providerId) {
  const plugin = requireProvider(context, providerId);
  if (!plugin.supportsAuth) {
    throw new Error(`Provider \`${providerId}\` does not support auth.`);
  }
  return plugin;
}

async function runAuthForProvider({
  context,
  providerId,
  configPath,
  dbPath,
  db,
  listenHost,
  listenPort,
  allowManualCodeEntry = false,
  showGuide,
  showConfigPrompts,
  askRedoIfWorking,
  progress = null,
  wizardStartAt = null,
}) {
  const plugin = requireAuthPlugin(context, providerId);

  let currentStartAt = wizardStartAt;
  while (true) {
    let loadedConfig = loadConfig(configPath);

    const wizard = await runProviderPreAuthWizard(
      providerId,
      configSectionForProvider(loadedConfig.data, providerId),
      db,
      {
        showGuide,
        showConfigPrompts,
        askRedoIfWorking,
        progress,
        startAt: currentStartAt,
      },
    );

    if (!wizard.proceed) {
      return { skipped: true, reason: wizard.reason || 'skipped' };
    }

    const preAuthUpdates = {
      ...(wizard.updates || {}),
    };
    if (Object.keys(preAuthUpdates).length) {
      updateProviderConfigValues(configPath, providerId, preAuthUpdates);
    }
    loadedConfig = loadConfig(configPath);

    try {
      await plugin.auth(db, loadedConfig.data, new PluginHelpers(loadedConfig.data), {
        listenHost,
        listenPort,
        allowManualCodeEntry,
        configPath,
        dbPath,
      });
      updateProviderConfigValues(configPath, providerId, { enabled: true });
      return {
        skipped: false,
        preflightDetail: wizard.preflightDetail || null,
      };
    } catch (err) {
      if (!hasInteractiveAuthUi() || (!showGuide && !showConfigPrompts)) {
        throw err;
      }
      const action = await promptAuthFailureRecovery(providerId, err?.message || String(err), progress);
      if (action === 'retry') {
        continue;
      }
      if (action === 'edit') {
        currentStartAt = 'config';
        continue;
      }
      if (action === 'guide') {
        currentStartAt = 'guide';
        continue;
      }
      if (action === 'skip') {
        return {
          skipped: true,
          reason: 'auth_failed_skip',
          error: err?.message || String(err),
        };
      }
      throw err;
    }
  }
}

async function runConfigOnlySetupForProvider({
  context,
  providerId,
  configPath,
  db,
  showGuide,
  showConfigPrompts,
  askRedoIfWorking,
  progress = null,
  wizardStartAt = null,
}) {
  requireProvider(context, providerId);

  const loadedConfig = loadConfig(configPath);

  const wizard = await runProviderPreAuthWizard(
    providerId,
    configSectionForProvider(loadedConfig.data, providerId),
    db,
    {
      showGuide,
      showConfigPrompts,
      askRedoIfWorking,
      progress,
      startAt: wizardStartAt,
    },
  );

  if (!wizard.proceed) {
    return { skipped: true, reason: wizard.reason || 'skipped' };
  }

  const updates = {
    enabled: true,
    ...(wizard.updates || {}),
  };
  updateProviderConfigValues(configPath, providerId, updates);
  return {
    skipped: false,
    preflightDetail: wizard.preflightDetail || null,
  };
}

async function runGuidedSetupForProvider(options) {
  const plugin = requireProvider(options.context, options.providerId);
  if (plugin.supportsAuth) {
    return runAuthForProvider(options);
  }
  return runConfigOnlySetupForProvider(options);
}

function usage() {
  return [
    'Usage: health-sync [--config path] [--db path] <command> [options]',
    '       health-sync --version',
    '',
    'Commands:',
    '  init                          Initialize config/database and launch interactive setup (TTY)',
    '  init remote bootstrap         Create one remote bootstrap token',
    '    --expires-in <duration>     Token expiry (default 24h; e.g. 12h, 2d, 3600)',
    '  init remote run <token>       Run onboarding and emit encrypted remote archive',
    '    --output <path>             Output archive path (.enc JSON envelope)',
    '    --keep-local                Keep local config/creds after archive creation',
    '  init remote finish <ref> <archive>  Decrypt archive and import files safely',
    '    --target-config <path>      Import destination for health-sync.toml',
    '    --target-creds <path>       Import destination for .health-sync.creds',
    '',
    '  Alias forms (compatible):',
    '  init --remote-bootstrap',
    '  init --remote <token>',
    '  init --remote-bootstrap-finish <ref> <archive>',
    '  init-db                       Initialize database only',
    '  auth <provider>               Run provider authentication flow for one provider',
    '    --listen-host <host>        OAuth callback listen host (default 127.0.0.1)',
    '    --listen-port <port>        OAuth callback listen port (default 0 -> config redirect port)',
    '    --local                     Enable manual callback/code paste mode',
    '  sync [--providers a,b,c] [-v|--verbose]  Sync enabled providers',
    '  providers [--verbose]         List discovered providers',
    '  status                        Show sync state, counts, and recent runs',
  ].join('\n');
}

async function loadContext(configPath) {
  const loadedConfig = loadConfig(configPath);
  const helpers = new PluginHelpers(loadedConfig.data);
  const { providers, metadata } = await loadProviders(loadedConfig.data, {
    cwd: path.dirname(path.resolve(configPath)),
  });
  return {
    loadedConfig,
    helpers,
    providers,
    metadata,
  };
}

function removeFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

function purgeRemoteLocalSecrets(configPath, credsPath) {
  const removed = [];
  if (removeFileIfExists(configPath)) {
    removed.push(configPath);
  }
  if (removeFileIfExists(credsPath)) {
    removed.push(credsPath);
  }
  return removed;
}

async function cmdInitRemoteBootstrap(parsed) {
  const session = createBootstrapSession({
    expiresInSeconds: parsed.options.expiresInSeconds,
  });

  console.log('Created remote bootstrap session.');
  console.log(`Session fingerprint: ${session.fingerprint}`);
  console.log(`Session expires at: ${session.expiresAt}`);
  console.log(`Bootstrap store: ${bootstrapStoreDir()}`);
  console.log('');
  console.log('Share this command with the user:');
  console.log(`  health-sync init --remote ${session.token}`);
  console.log('');
  console.log('Bootstrap token:');
  console.log(session.token);

  return 0;
}

async function cmdInitRemoteRun(parsed) {
  const tokenDetails = parseBootstrapToken(parsed.options.bootstrapToken, {
    requireNotExpired: true,
  });

  const configPath = path.resolve(parsed.configPath);
  const credsPath = resolveCredsPath(configPath);
  const outputPath = parsed.options.outputPath
    ? path.resolve(parsed.options.outputPath)
    : defaultRemoteArchivePath(configPath, tokenDetails.sessionId);

  console.log('Remote onboarding mode enabled.');
  console.log(`Bootstrap session: ${tokenDetails.keyId.slice(0, 12)}:${tokenDetails.sessionId.slice(0, 8)}`);
  console.log(`Bootstrap expires at: ${tokenDetails.expiresAt}`);
  console.log('');

  const initCode = await cmdInitLocal(parsed);
  if (initCode === 130) {
    return 130;
  }
  if (initCode !== 0) {
    console.warn('Init completed with warnings; packaging current config/creds anyway.');
  }

  const { payload } = buildRemotePayloadFromFiles({
    configPath,
    credsPath,
    allowMissingCreds: true,
    sourceVersion: cliVersion(),
  });
  const envelope = encryptRemotePayload(payload, parsed.options.bootstrapToken, {
    requireNotExpired: true,
  });
  const archivePath = writeRemoteArchiveFile(envelope, outputPath);

  console.log('');
  console.log('Encrypted remote archive created successfully.');
  console.log(`Archive path: ${archivePath}`);
  console.log('Send this archive file to the bot/operator.');

  if (parsed.options.purgeLocal) {
    const removed = purgeRemoteLocalSecrets(configPath, credsPath);
    if (removed.length) {
      console.log('');
      console.log('Purged local sensitive files after archive creation:');
      for (const item of removed) {
        console.log(`  - ${item}`);
      }
    } else {
      console.log('');
      console.log('No local config/creds files found to purge.');
    }
  } else {
    console.log('');
    console.log('Kept local config/creds because --keep-local was set.');
  }

  return initCode;
}

async function cmdInitRemoteFinish(parsed) {
  const configPath = path.resolve(parsed.configPath);
  const targetConfigPath = parsed.options.targetConfigPath
    ? path.resolve(parsed.options.targetConfigPath)
    : configPath;
  const targetCredsPath = parsed.options.targetCredsPath
    ? path.resolve(parsed.options.targetCredsPath)
    : resolveCredsPath(targetConfigPath);

  const result = importRemoteArchive({
    sessionRef: parsed.options.sessionRef,
    archivePath: parsed.options.archivePath,
    targetConfigPath,
    targetCredsPath,
  });

  console.log('Remote bootstrap import complete.');
  console.log(`Imported config: ${result.targetConfigPath}`);
  console.log(`Imported creds: ${result.targetCredsPath}`);
  if (result.backups.length) {
    console.log('Backups created:');
    for (const backup of result.backups) {
      console.log(`  - ${backup}`);
    }
  }
  console.log(`Session consumed at: ${result.consumedAt}`);
  console.log(`Imported token entries: ${result.tokenCount}`);

  return 0;
}

async function cmdInit(parsed) {
  const mode = parsed.options?.mode || 'local';
  if (mode === 'remote-bootstrap') {
    return cmdInitRemoteBootstrap(parsed);
  }
  if (mode === 'remote-run') {
    return cmdInitRemoteRun(parsed);
  }
  if (mode === 'remote-finish') {
    return cmdInitRemoteFinish(parsed);
  }
  return cmdInitLocal(parsed);
}

async function cmdInitLocal(parsed) {
  const configPath = path.resolve(parsed.configPath);
  const explicitDbPath = parsed.dbPath ? String(parsed.dbPath) : null;

  initConfigFile(configPath, explicitDbPath);

  const loaded = loadConfig(configPath);
  const dbPath = resolveDbPath(parsed.dbPath, loaded);
  const db = openDb(dbPath, { credsPath: resolveCredsPath(configPath) });
  db.close();

  console.log(`Initialized config: ${configPath}`);
  console.log(`Initialized database: ${path.resolve(dbPath)}`);

  if (!hasInteractiveAuthUi()) {
    console.log('Interactive setup requires a TTY; run `health-sync auth <provider>` to authenticate later.');
    return 0;
  }

  const authDb = openDb(dbPath, { credsPath: resolveCredsPath(configPath) });
  const setupResults = [];

  try {
    let context = await loadContext(configPath);
    const providerRows = Array.from(context.providers.keys())
      .sort()
      .map((providerId) => {
        const plugin = context.providers.get(providerId);
        const builtInGuide = shouldShowBuiltInGuide(providerId);
        const section = configSectionForProvider(context.loadedConfig.data, providerId);
        const enabled = providerEnabled(context.loadedConfig.data, providerId);
        const setupComplete = providerLikelySetup(
          providerId,
          section,
          authDb,
          Boolean(plugin?.supportsAuth),
        );

        return {
          id: providerId,
          supportsAuth: Boolean(plugin?.supportsAuth),
          supportsInteractiveSetup: Boolean(plugin?.supportsAuth || builtInGuide),
          description: plugin?.description || null,
          enabled,
          setupComplete,
        };
      });

    if (!providerRows.length) {
      console.log('No providers discovered; skipping interactive setup.');
      return 0;
    }
    if (!providerRows.some((provider) => provider.supportsInteractiveSetup)) {
      console.log('No setup-capable providers discovered; skipping interactive setup.');
      return 0;
    }

    const availableProviders = new Set(providerRows.map((row) => row.id));
    const resumeState = loadOnboardingState(configPath);

    let selected = [];
    let startIndex = 0;
    if (resumeState?.selectedProviders?.length) {
      const filtered = resumeState.selectedProviders.filter((id) => availableProviders.has(id));
      if (filtered.length) {
        const resumeChoice = await promptResumeOnboardingSession({
          ...resumeState,
          selectedProviders: filtered,
        });
        if (resumeChoice === 'resume') {
          selected = filtered;
          startIndex = Math.min(filtered.length, Math.max(0, resumeState.nextIndex || 0));
          if (Array.isArray(resumeState.results)) {
            setupResults.push(...resumeState.results);
          }
          console.log(`Resuming onboarding at provider ${startIndex + 1}/${selected.length}.`);
        } else {
          clearOnboardingState(configPath);
        }
      } else {
        clearOnboardingState(configPath);
      }
    }

    if (!selected.length) {
      selected = await promptAuthProviderChecklist(providerRows);
      if (!selected.length) {
        console.log('Skipped provider setup during init.');
        clearOnboardingState(configPath);
        return 0;
      }
      startIndex = 0;
      saveOnboardingState(configPath, {
        selectedProviders: selected,
        nextIndex: 0,
        results: [],
      });
    }

    for (let index = startIndex; index < selected.length; index += 1) {
      const providerId = selected[index];
      const plugin = context.providers.get(providerId);
      const label = authProviderDisplayName(providerId);
      const progress = {
        providerId,
        index: index + 1,
        total: selected.length,
      };

      saveOnboardingState(configPath, {
        selectedProviders: selected,
        nextIndex: index,
        results: setupResults,
      });
      console.log(`Starting guided setup for ${label} (${providerId})...`);
      try {
        const result = await runGuidedSetupForProvider({
          context,
          providerId,
          configPath,
          dbPath,
          db: authDb,
          listenHost: '127.0.0.1',
          listenPort: 0,
          showGuide: shouldShowBuiltInGuide(providerId),
          showConfigPrompts: shouldShowBuiltInGuide(providerId),
          askRedoIfWorking: true,
          progress,
        });
        if (result.skipped) {
          console.log(`Skipped setup for provider ${providerId}.`);
          setupResults.push({
            providerId,
            status: 'skipped',
            detail: result.reason || 'skipped',
          });
          saveOnboardingState(configPath, {
            selectedProviders: selected,
            nextIndex: index + 1,
            results: setupResults,
          });
          continue;
        }
        if (plugin?.supportsAuth) {
          console.log(`Auth finished for provider ${providerId}.`);
        } else {
          console.log(`Setup finished for provider ${providerId}.`);
        }
        setupResults.push({
          providerId,
          status: 'configured',
          detail: result.preflightDetail || null,
        });
      } catch (err) {
        if (isUserAbortError(err)) {
          saveOnboardingState(configPath, {
            selectedProviders: selected,
            nextIndex: index,
            results: setupResults,
          });
          console.warn(err.message);
          return 130;
        }
        console.warn(`WARNING: setup failed for ${providerId}: ${err?.message || String(err)}`);
        setupResults.push({
          providerId,
          status: 'failed',
          detail: err?.message || String(err),
        });
      }
      saveOnboardingState(configPath, {
        selectedProviders: selected,
        nextIndex: index + 1,
        results: setupResults,
      });
    }

    clearOnboardingState(configPath);

    const resultByProvider = new Map();
    for (const row of setupResults) {
      if (!row?.providerId) {
        continue;
      }
      resultByProvider.set(row.providerId, row);
    }

    const configured = [];
    const skipped = [];
    const failed = [];
    for (const [providerId, row] of resultByProvider.entries()) {
      if (row.status === 'configured') {
        configured.push(providerId);
        continue;
      }
      if (row.status === 'skipped') {
        skipped.push(providerId);
        continue;
      }
      if (row.status === 'failed') {
        failed.push({
          providerId,
          error: row.detail || 'Unknown error',
        });
      }
    }

    let smoke = null;
    if (configured.length && await promptSmokeTestChoice(configured)) {
      context = await loadContext(configPath);
      const smokeResults = [];
      for (const providerId of configured) {
        const provider = context.providers.get(providerId);
        if (!provider) {
          smokeResults.push({
            providerId,
            ok: false,
            error: 'Provider not discovered',
          });
          continue;
        }
        try {
          await provider.sync(authDb, context.loadedConfig.data, context.helpers, {
            configPath,
            dbPath,
          });
          smokeResults.push({
            providerId,
            ok: true,
          });
        } catch (err) {
          smokeResults.push({
            providerId,
            ok: false,
            error: err?.message || String(err),
          });
        }
      }
      smoke = { results: smokeResults };
    }

    printOnboardingCompletionReport({
      configured,
      skipped,
      failed,
    }, smoke);

    if (failed.length) {
      console.warn(`Init completed with warnings; ${failed.length} provider setup flow(s) failed.`);
      return 1;
    }

    if (smoke && smoke.results.some((row) => !row.ok)) {
      console.warn('Init completed, but one or more smoke sync checks failed.');
      return 1;
    }
  } finally {
    authDb.close();
  }

  return 0;
}

async function cmdInitDb(parsed) {
  const configPath = path.resolve(parsed.configPath);
  const loaded = loadConfig(configPath);
  const dbPath = resolveDbPath(parsed.dbPath, loaded);

  const db = openDb(dbPath, { credsPath: resolveCredsPath(configPath) });
  db.close();
  console.log(`Initialized database: ${path.resolve(dbPath)}`);
  return 0;
}

async function cmdAuth(parsed) {
  const configPath = path.resolve(parsed.configPath);
  const explicitDbPath = parsed.dbPath ? String(parsed.dbPath) : null;

  initConfigFile(configPath, explicitDbPath);

  const loaded = loadConfig(configPath);
  const dbPath = resolveDbPath(parsed.dbPath, loaded);

  const context = await loadContext(configPath);
  const db = openDb(dbPath, { credsPath: resolveCredsPath(configPath) });

  try {
    const result = await runAuthForProvider({
      context,
      providerId: parsed.options.provider,
      configPath,
      dbPath,
      db,
      listenHost: parsed.options.listenHost,
      listenPort: parsed.options.listenPort,
      allowManualCodeEntry: parsed.options.local,
      showGuide: false,
      showConfigPrompts: parsed.options.provider === 'eightsleep',
      askRedoIfWorking: hasInteractiveAuthUi(),
    });

    if (result.skipped) {
      console.log(`Skipped auth for provider ${parsed.options.provider}.`);
      return 0;
    }

    console.log(`Auth finished for provider ${parsed.options.provider}.`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSync(parsed) {
  const configPath = path.resolve(parsed.configPath);
  const context = await loadContext(configPath);
  const dbPath = resolveDbPath(parsed.dbPath, context.loadedConfig);
  const db = openDb(dbPath, { credsPath: resolveCredsPath(configPath) });
  const previousVerboseLogging = setRequestJsonVerbose(parsed.options.verbose);

  try {
    const discoveredIds = Array.from(context.providers.keys()).sort();
    const requested = parsed.options.providers.length ? parsed.options.providers : discoveredIds;
    if (parsed.options.providers.length) {
      const unknown = requested.filter((id) => !context.providers.has(id));
      if (unknown.length) {
        const known = discoveredIds.length ? discoveredIds.join(', ') : '(none)';
        throw new Error(
          `Unknown provider(s): ${unknown.join(', ')}. `
          + `Available providers: ${known}. `
          + 'Use `health-sync providers` to inspect discovery/config status.',
        );
      }
    }

    const enabledConfiguredPluginIds = Object.entries(context.loadedConfig.data.plugins || {})
      .filter(([, section]) => Boolean(section?.enabled))
      .map(([id]) => id)
      .filter((id) => !context.providers.has(id));
    for (const missingId of enabledConfiguredPluginIds) {
      console.warn(`WARNING: [plugins.${missingId}] is enabled but provider code was not discovered.`);
    }

    const toSync = requested.filter((id) => providerEnabled(context.loadedConfig.data, id));
    const skipped = requested.filter((id) => !providerEnabled(context.loadedConfig.data, id));
    for (const providerId of skipped) {
      console.log(`Skipping ${providerId}: disabled in config (set ${enableHint(providerId)}).`);
    }

    if (!toSync.length) {
      if (!parsed.options.providers.length) {
        console.log(
          'No providers enabled; nothing to sync. '
          + `Enable one or more providers in ${context.loadedConfig.path} `
          + `(e.g. set ${enableHint('hevy')}).`,
        );
      } else if (requested.length) {
        console.log('No enabled providers selected; nothing to sync.');
      } else {
        console.log('No providers specified; nothing to sync.');
      }
      return 0;
    }

    let successes = 0;
    const failures = [];
    for (const providerId of toSync) {
      console.log(`Syncing provider: ${providerId}`);
      try {
        await context.providers.get(providerId).sync(db, context.loadedConfig.data, context.helpers, {
          configPath,
          dbPath,
        });
        successes += 1;
      } catch (err) {
        failures.push(providerId);
        console.warn(`WARNING: ${providerId} sync failed: ${err?.message || String(err)}`);
      }
    }

    if (failures.length) {
      console.warn(
        `Sync completed with warnings (${failures.length}/${toSync.length} providers failed): `
        + failures.join(', '),
      );
      if (successes === 0) {
        console.warn('All selected providers failed.');
      }
      return 1;
    }

    return 0;
  } finally {
    setRequestJsonVerbose(previousVerboseLogging);
    db.close();
  }
}

async function cmdProviders(parsed) {
  const configPath = path.resolve(parsed.configPath);
  const context = await loadContext(configPath);

  const ids = Array.from(context.providers.keys()).sort();
  for (const id of ids) {
    const plugin = context.providers.get(id);
    const meta = context.metadata.get(id) || {};
    const enabled = providerEnabled(context.loadedConfig.data, id);
    const auth = plugin.supportsAuth ? 'yes' : 'no';

    console.log(`${id}\tenabled=${enabled ? 'yes' : 'no'}\tauth=${auth}\tsource=${plugin.source}`);
    if (parsed.options.verbose && meta.moduleSpec) {
      console.log(`  module=${meta.moduleSpec}`);
    }
    if (parsed.options.verbose && plugin.description) {
      console.log(`  description=${plugin.description}`);
    }
  }

  return 0;
}

async function cmdStatus(parsed) {
  const configPath = path.resolve(parsed.configPath);
  const loadedConfig = loadConfig(configPath);
  const dbPath = resolveDbPath(parsed.dbPath, loadedConfig);
  const db = openDb(dbPath, { credsPath: resolveCredsPath(configPath) });

  try {
    const syncState = db.listSyncState();
    const recordCounts = db.listRecordCounts();
    const runs = db.listRecentSyncRuns(20);

    console.log('Sync State:');
    if (!syncState.length) {
      console.log('  (none)');
    }
    for (const row of syncState) {
      console.log(`  ${row.provider}/${row.resource} watermark=${row.watermark || '-'} updated_at=${row.updatedAt || '-'}`);
    }

    console.log('');
    console.log('Record Counts:');
    if (!recordCounts.length) {
      console.log('  (none)');
    }
    for (const row of recordCounts) {
      console.log(`  ${row.provider}/${row.resource}: ${row.count}`);
    }

    console.log('');
    console.log('Recent Sync Runs:');
    if (!runs.length) {
      console.log('  (none)');
    }
    for (const run of runs) {
      const counts = `i=${run.insertedCount} u=${run.updatedCount} d=${run.deletedCount} n=${run.unchangedCount}`;
      const wm = `wm=${run.watermarkBefore || '-'} -> ${run.watermarkAfter || '-'}`;
      console.log(`  #${run.id} ${run.startedAt} ${run.provider}/${run.resource} status=${run.status} ${counts} ${wm}`);
      if (run.errorText) {
        console.log(`    error=${run.errorText.split('\n')[0]}`);
      }
    }

    return 0;
  } finally {
    db.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    if (!parsed.command) {
      console.log(usage());
      return 1;
    }

    if (parsed.command === 'version') {
      console.log(cliVersion());
      return 0;
    }

    if (parsed.command === 'init') {
      return await cmdInit(parsed);
    }
    if (parsed.command === 'init-db') {
      return await cmdInitDb(parsed);
    }
    if (parsed.command === 'auth') {
      return await cmdAuth(parsed);
    }
    if (parsed.command === 'sync') {
      return await cmdSync(parsed);
    }
    if (parsed.command === 'providers') {
      return await cmdProviders(parsed);
    }
    if (parsed.command === 'status') {
      return await cmdStatus(parsed);
    }

    console.error(`Unknown command: ${parsed.command}`);
    return 1;
  } catch (err) {
    console.error(err?.message || String(err));
    if (isUserAbortError(err)) {
      return 130;
    }
    return 1;
  }
}

export {
  parseArgs,
};
