import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { main, parseArgs } from '../src/cli.js';
import { dbPathFor, jsonResponse, makeTempDir, removeDir, withFetchMock } from './test-helpers.js';

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function writePlugin(dirPath, id, bodySource) {
  const filePath = path.join(dirPath, `${id}-plugin.js`);
  writeFile(filePath, bodySource);
  return `./${path.basename(filePath)}`;
}

function configForPlugins(dbPath, plugins) {
  const lines = [
    '[app]',
    `db = "${dbPath}"`,
    '',
  ];
  for (const plugin of plugins) {
    lines.push(`[plugins.${plugin.id}]`);
    lines.push('enabled = true');
    lines.push(`module = "${plugin.moduleSpec}"`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

test('parseArgs preserves global db before subcommand', () => {
  const parsed = parseArgs(['--db', '/tmp/global.sqlite', 'status']);
  assert.equal(parsed.dbPath, '/tmp/global.sqlite');
  assert.equal(parsed.command, 'status');
});

test('parseArgs preserves global config before subcommand', () => {
  const parsed = parseArgs(['--config', '/tmp/health-sync.toml', 'status']);
  assert.equal(parsed.configPath, '/tmp/health-sync.toml');
  assert.equal(parsed.command, 'status');
});

test('parseArgs accepts subcommand override style for db', () => {
  const parsed = parseArgs(['--db', '/tmp/global.sqlite', 'status', '--db', '/tmp/sub.sqlite']);
  assert.equal(parsed.dbPath, '/tmp/sub.sqlite');
});

test('parseArgs has providers and init subcommands', () => {
  assert.equal(parseArgs(['providers']).command, 'providers');
  assert.equal(parseArgs(['init']).command, 'init');
});

test('parseArgs supports init remote subcommands and alias flags', () => {
  const bootstrap = parseArgs(['init', 'remote', 'bootstrap', '--expires-in', '12h']);
  assert.equal(bootstrap.command, 'init');
  assert.equal(bootstrap.options.mode, 'remote-bootstrap');
  assert.equal(bootstrap.options.expiresInSeconds, 12 * 60 * 60);

  const run = parseArgs(['init', 'remote', 'run', 'hsr1.example', '--keep-local']);
  assert.equal(run.options.mode, 'remote-run');
  assert.equal(run.options.bootstrapToken, 'hsr1.example');
  assert.equal(run.options.purgeLocal, false);

  const runAlias = parseArgs(['init', '--remote', 'hsr1.alias']);
  assert.equal(runAlias.options.mode, 'remote-run');
  assert.equal(runAlias.options.bootstrapToken, 'hsr1.alias');

  const finish = parseArgs(['init', 'remote', 'finish', 'abc123', 'bundle.enc']);
  assert.equal(finish.options.mode, 'remote-finish');
  assert.equal(finish.options.sessionRef, 'abc123');
  assert.equal(finish.options.archivePath, 'bundle.enc');
});

test('parseArgs supports --version and rejects combining it with a command', () => {
  const parsed = parseArgs(['--version']);
  assert.equal(parsed.command, 'version');

  assert.throws(
    () => parseArgs(['--version', 'status']),
    /--version cannot be combined with a command/,
  );
});

test('parseArgs sync accepts verbose flags', () => {
  const longFlag = parseArgs(['sync', '--verbose', '--providers', 'oura']);
  assert.equal(longFlag.options.verbose, true);
  assert.deepEqual(longFlag.options.providers, ['oura']);

  const shortFlag = parseArgs(['sync', '-v', '--providers=hevy,strava']);
  assert.equal(shortFlag.options.verbose, true);
  assert.deepEqual(shortFlag.options.providers, ['hevy', 'strava']);
});

test('main --version prints current package version', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(' '));
  try {
    const rc = await main(['--version']);
    assert.equal(rc, 0);
  } finally {
    console.log = originalLog;
  }

  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const expectedVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
  assert.deepEqual(logs, [expectedVersion]);
});

test('parseArgs rejects flag-like auth provider id', () => {
  assert.throws(
    () => parseArgs(['auth', '-h']),
    /auth requires PROVIDER argument|Invalid provider id/,
  );
});

test('parseArgs auth accepts --local manual callback mode', () => {
  const parsed = parseArgs(['auth', '--local', 'oura', '--listen-port', '8486']);
  assert.equal(parsed.options.provider, 'oura');
  assert.equal(parsed.options.local, true);
  assert.equal(parsed.options.listenPort, 8486);

  const fallback = parseArgs(['auth', 'oura']);
  assert.equal(fallback.options.local, false);
});

test('init creates scaffolded config from example template', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const configPath = path.join(dir, 'health-sync.toml');
  const dbPath = dbPathFor(dir, 'custom-init.sqlite');
  const rc = await main(['--config', configPath, '--db', dbPath, 'init']);
  assert.equal(rc, 0);

  const content = fs.readFileSync(configPath, 'utf8');
  assert.match(content, /health-sync configuration \(example\)/);
  assert.match(content, /^\[app\]$/m);
  assert.ok(content.includes(`db = "${dbPath}"`));
  assert.match(content, /^\[oura\]$/m);
  assert.match(content, /^\[withings\]$/m);
  assert.match(content, /^\[hevy\]$/m);
  assert.match(content, /^\[strava\]$/m);
  assert.match(content, /^\[whoop\]$/m);
  assert.match(content, /^\[eightsleep\]$/m);
});

test('remote bootstrap -> run -> finish creates importable encrypted archive', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const storeDir = path.join(dir, 'remote-store');
  const priorStore = process.env.HEALTH_SYNC_REMOTE_BOOTSTRAP_DIR;
  process.env.HEALTH_SYNC_REMOTE_BOOTSTRAP_DIR = storeDir;
  t.after(() => {
    if (priorStore === undefined) {
      delete process.env.HEALTH_SYNC_REMOTE_BOOTSTRAP_DIR;
    } else {
      process.env.HEALTH_SYNC_REMOTE_BOOTSTRAP_DIR = priorStore;
    }
  });

  const configPath = path.join(dir, 'user-health-sync.toml');
  const archivePath = path.join(dir, 'payload.enc');
  const dbPath = dbPathFor(dir, 'remote-init.sqlite');

  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(' '));

  let bootstrapRc = 1;
  try {
    bootstrapRc = await main(['--config', configPath, 'init', 'remote', 'bootstrap', '--expires-in', '1h']);
  } finally {
    console.log = originalLog;
  }
  assert.equal(bootstrapRc, 0);

  const token = logs.find((line) => line.startsWith('hsr1.'));
  assert.ok(token);

  const runRc = await main([
    '--config',
    configPath,
    '--db',
    dbPath,
    'init',
    'remote',
    'run',
    token,
    '--output',
    archivePath,
    '--keep-local',
  ]);
  assert.equal(runRc, 0);
  assert.equal(fs.existsSync(archivePath), true);

  const importedConfig = path.join(dir, 'imported-health-sync.toml');
  const importedCreds = path.join(dir, '.imported-health-sync.creds');
  const finishRc = await main([
    'init',
    'remote',
    'finish',
    token,
    archivePath,
    '--target-config',
    importedConfig,
    '--target-creds',
    importedCreds,
  ]);
  assert.equal(finishRc, 0);
  assert.equal(fs.existsSync(importedConfig), true);
  assert.equal(fs.existsSync(importedCreds), true);
  assert.match(fs.readFileSync(importedConfig, 'utf8'), /^\[app\]$/m);
});

test('sync continues after one provider failure and returns non-zero', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const dbPath = dbPathFor(dir);
  const callsPath = path.join(dir, 'calls.log');
  const okSpec = writePlugin(
    dir,
    'ok',
    `
      import fs from 'node:fs';
      export default {
        id: 'ok',
        supportsAuth: false,
        async sync() { fs.appendFileSync(${JSON.stringify(callsPath)}, 'ok\\n'); }
      };
    `,
  );
  const failSpec = writePlugin(
    dir,
    'fail',
    `
      import fs from 'node:fs';
      export default {
        id: 'fail',
        supportsAuth: false,
        async sync() {
          fs.appendFileSync(${JSON.stringify(callsPath)}, 'fail\\n');
          throw new Error('boom');
        }
      };
    `,
  );
  const ok2Spec = writePlugin(
    dir,
    'ok2',
    `
      import fs from 'node:fs';
      export default {
        id: 'ok2',
        supportsAuth: false,
        async sync() { fs.appendFileSync(${JSON.stringify(callsPath)}, 'ok2\\n'); }
      };
    `,
  );

  const configPath = path.join(dir, 'health-sync.toml');
  writeFile(configPath, configForPlugins(dbPath, [
    { id: 'ok', moduleSpec: okSpec },
    { id: 'fail', moduleSpec: failSpec },
    { id: 'ok2', moduleSpec: ok2Spec },
  ]));

  const rc = await main([
    '--config',
    configPath,
    'sync',
    '--providers',
    'ok',
    'fail',
    'ok2',
  ]);

  assert.equal(rc, 1);
  const calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['ok', 'fail', 'ok2']);
});

test('sync returns non-zero when all selected providers fail', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const dbPath = dbPathFor(dir);
  const failASpec = writePlugin(
    dir,
    'faila',
    `export default { id: 'faila', async sync() { throw new Error('a down'); } };`,
  );
  const failBSpec = writePlugin(
    dir,
    'failb',
    `export default { id: 'failb', async sync() { throw new Error('b down'); } };`,
  );

  const configPath = path.join(dir, 'health-sync.toml');
  writeFile(configPath, configForPlugins(dbPath, [
    { id: 'faila', moduleSpec: failASpec },
    { id: 'failb', moduleSpec: failBSpec },
  ]));

  const rc = await main([
    '--config',
    configPath,
    'sync',
    '--providers',
    'faila',
    'failb',
  ]);
  assert.equal(rc, 1);
});

test('sync with unknown requested provider fails fast', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const dbPath = dbPathFor(dir);
  const callsPath = path.join(dir, 'calls.log');
  const okSpec = writePlugin(
    dir,
    'ok',
    `
      import fs from 'node:fs';
      export default {
        id: 'ok',
        async sync() { fs.appendFileSync(${JSON.stringify(callsPath)}, 'ok\\n'); }
      };
    `,
  );
  const configPath = path.join(dir, 'health-sync.toml');
  writeFile(configPath, configForPlugins(dbPath, [{ id: 'ok', moduleSpec: okSpec }]));

  const rc = await main([
    '--config',
    configPath,
    'sync',
    '--providers',
    'unknown-provider',
  ]);

  assert.equal(rc, 1);
  assert.equal(fs.existsSync(callsPath), false);
});

test('sync returns success when selected providers are disabled', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const dbPath = dbPathFor(dir);
  const moduleSpec = writePlugin(
    dir,
    'demo',
    `export default { id: 'demo', async sync() {} };`,
  );
  const configPath = path.join(dir, 'health-sync.toml');
  writeFile(
    configPath,
    `
[app]
db = "${dbPath}"

[plugins.demo]
enabled = false
module = "${moduleSpec}"
`,
  );

  const rc = await main(['--config', configPath, 'sync', '--providers', 'demo']);
  assert.equal(rc, 0);
});

test('sync prints provider progress and -v logs HTTP calls', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const dbPath = dbPathFor(dir);
  const utilModuleUrl = pathToFileURL(path.join(process.cwd(), 'src', 'util.js')).href;
  const moduleSpec = writePlugin(
    dir,
    'http-demo',
    `
      import { requestJson } from ${JSON.stringify(utilModuleUrl)};
      export default {
        id: 'http-demo',
        supportsAuth: false,
        async sync() {
          await requestJson('https://example.test/ping');
        },
      };
    `,
  );

  const configPath = path.join(dir, 'health-sync.toml');
  writeFile(configPath, configForPlugins(dbPath, [{ id: 'http-demo', moduleSpec }]));

  withFetchMock(t, async () => jsonResponse({ ok: true }));

  const verboseLogs = [];
  const originalLog = console.log;
  console.log = (...parts) => verboseLogs.push(parts.map((part) => String(part)).join(' '));
  try {
    const rcVerbose = await main(['--config', configPath, 'sync', '-v', '--providers', 'http-demo']);
    assert.equal(rcVerbose, 0);
  } finally {
    console.log = originalLog;
  }

  assert.ok(verboseLogs.some((line) => line.includes('Syncing provider: http-demo')));
  assert.ok(verboseLogs.some((line) => line.includes('[http] -> GET https://example.test/ping')));
  assert.ok(verboseLogs.some((line) => line.includes('[http] <- 200')));

  const quietLogs = [];
  console.log = (...parts) => quietLogs.push(parts.map((part) => String(part)).join(' '));
  try {
    const rcQuiet = await main(['--config', configPath, 'sync', '--providers', 'http-demo']);
    assert.equal(rcQuiet, 0);
  } finally {
    console.log = originalLog;
  }

  assert.ok(quietLogs.some((line) => line.includes('Syncing provider: http-demo')));
  assert.equal(quietLogs.some((line) => line.includes('[http] ->')), false);
  assert.equal(quietLogs.some((line) => line.includes('[http] <-')), false);
});

test('auth initializes app db and executes plugin auth', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const configPath = path.join(dir, 'health-sync.toml');
  const dbPath = dbPathFor(dir, 'auth.sqlite');
  const markerPath = path.join(dir, 'auth-ran.txt');

  const moduleSpec = writePlugin(
    dir,
    'demo-auth',
    `
      import fs from 'node:fs';
      export default {
        id: 'demo-auth',
        supportsAuth: true,
        async sync() {},
        async auth() { fs.writeFileSync(${JSON.stringify(markerPath)}, 'ok', 'utf8'); },
      };
    `,
  );
  writeFile(
    configPath,
    `
[plugins.demo-auth]
enabled = true
module = "${moduleSpec}"
`,
  );

  const rc = await main([
    '--config',
    configPath,
    '--db',
    dbPath,
    'auth',
    'demo-auth',
  ]);
  assert.equal(rc, 0);

  const content = fs.readFileSync(configPath, 'utf8');
  assert.match(content, /\[app\]/);
  assert.match(content, new RegExp(dbPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(markerPath), true);
});
