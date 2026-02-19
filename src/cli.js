import path from 'node:path';
import {
  initConfigFile,
  loadConfig,
  scaffoldProviderConfig,
} from './config.js';
import { openDb } from './db.js';
import { PluginHelpers, providerEnabled } from './plugins/base.js';
import { loadProviders } from './plugins/loader.js';
import { setRequestJsonVerbose } from './util.js';

const DEFAULT_CONFIG_PATH = 'health-sync.toml';

function parseGlobalOptions(argv) {
  let configPath = DEFAULT_CONFIG_PATH;
  let dbPath = null;
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
    remaining.push(arg);
  }

  return { configPath, dbPath, remaining };
}

function parseAuthArgs(args) {
  const out = {
    provider: null,
    listenHost: '127.0.0.1',
    listenPort: 0,
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

function parseArgs(argv) {
  const global = parseGlobalOptions(argv);
  const [command, ...rest] = global.remaining;

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
  if (command === 'init' || command === 'init-db' || command === 'status') {
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
  const builtin = new Set(['oura', 'withings', 'hevy', 'strava', 'eightsleep']);
  if (builtin.has(providerId)) {
    return `[${providerId}].enabled = true`;
  }
  return `[plugins.${providerId}].enabled = true`;
}

function usage() {
  return [
    'Usage: health-sync [--config path] [--db path] <command> [options]',
    '',
    'Commands:',
    '  init                          Initialize config file and database',
    '  init-db                       Initialize database only',
    '  auth <provider>               Run provider authentication flow',
    '    --listen-host <host>        OAuth callback listen host (default 127.0.0.1)',
    '    --listen-port <port>        OAuth callback listen port (default 0 -> config redirect port)',
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

async function cmdInit(parsed) {
  const configPath = path.resolve(parsed.configPath);
  const explicitDbPath = parsed.dbPath ? String(parsed.dbPath) : null;

  initConfigFile(configPath, explicitDbPath);

  const loaded = loadConfig(configPath);
  const dbPath = resolveDbPath(parsed.dbPath, loaded);
  const db = openDb(dbPath, { credsPath: resolveCredsPath(configPath) });
  db.close();

  console.log(`Initialized config: ${configPath}`);
  console.log(`Initialized database: ${path.resolve(dbPath)}`);
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

  scaffoldProviderConfig(configPath, parsed.options.provider);

  const context = await loadContext(configPath);
  const db = openDb(dbPath, { credsPath: resolveCredsPath(configPath) });

  try {
    const plugin = context.providers.get(parsed.options.provider);
    if (!plugin) {
      const known = context.providers.size
        ? Array.from(context.providers.keys()).sort().join(', ')
        : '(none)';
      throw new Error(
        `Unknown provider \`${parsed.options.provider}\`. `
        + `Available providers: ${known}. `
        + 'Use `health-sync providers` to inspect discovery/config status.',
      );
    }
    if (!plugin.supportsAuth) {
      throw new Error(`Provider \`${parsed.options.provider}\` does not support auth.`);
    }

    await plugin.auth(db, context.loadedConfig.data, context.helpers, {
      listenHost: parsed.options.listenHost,
      listenPort: parsed.options.listenPort,
      configPath,
      dbPath,
    });

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
    return 1;
  }
}

export {
  parseArgs,
};
