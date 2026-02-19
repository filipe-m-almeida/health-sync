import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { providerEnabled } from '../src/plugins/base.js';
import { loadProviders } from '../src/plugins/loader.js';
import { baseConfig, makeTempDir, removeDir } from './test-helpers.js';

function writeModule(dirPath, filename, source) {
  const fullPath = path.join(dirPath, filename);
  fs.writeFileSync(fullPath, source, 'utf8');
  return `./${filename}`;
}

test('loadProviders accepts config module plugin', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const moduleSpec = writeModule(
    dir,
    'demo-plugin.js',
    `
      export default {
        id: 'demo',
        description: 'Demo plugin',
        supportsAuth: false,
        async sync() {}
      };
    `,
  );

  const cfg = baseConfig({
    plugins: {
      demo: {
        enabled: true,
        module: moduleSpec,
      },
    },
  });

  const { providers } = await loadProviders(cfg, { cwd: dir });
  assert.ok(providers.has('demo'));
  assert.ok(providers.has('oura'));
  assert.equal(providerEnabled(cfg, 'demo'), true);
});

test('loadProviders rejects id mismatch for configured module', async (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const moduleSpec = writeModule(
    dir,
    'other-plugin.js',
    `
      export default {
        id: 'other',
        supportsAuth: false,
        async sync() {}
      };
    `,
  );

  const cfg = baseConfig({
    plugins: {
      demo: {
        enabled: true,
        module: moduleSpec,
      },
    },
  });

  await assert.rejects(
    () => loadProviders(cfg, { cwd: dir }),
    /Plugin id mismatch/,
  );
});

test('built-in eightsleep provider supports auth', async () => {
  const { providers } = await loadProviders(baseConfig(), {});
  assert.ok(providers.has('eightsleep'));
  assert.equal(Boolean(providers.get('eightsleep').supportsAuth), true);
});

test('built-in whoop provider supports auth', async () => {
  const { providers } = await loadProviders(baseConfig(), {});
  assert.ok(providers.has('whoop'));
  assert.equal(Boolean(providers.get('whoop').supportsAuth), true);
});
