import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { main, parseArgs } from '../src/cli.js';
import { dbPathFor, makeTempDir, removeDir } from './test-helpers.js';

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
