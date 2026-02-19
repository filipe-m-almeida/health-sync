import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  BOOTSTRAP_TOKEN_PREFIX,
  buildRemotePayloadFromFiles,
  createBootstrapSession,
  encryptRemotePayload,
  importRemoteArchive,
  loadBootstrapSession,
  parseBootstrapToken,
  parseDurationToSeconds,
  writeRemoteArchiveFile,
} from '../src/remote-bootstrap.js';
import { makeTempDir, removeDir } from './test-helpers.js';

test('parseDurationToSeconds supports human-friendly units', () => {
  assert.equal(parseDurationToSeconds('45s'), 45);
  assert.equal(parseDurationToSeconds('10m'), 600);
  assert.equal(parseDurationToSeconds('3h'), 10800);
  assert.equal(parseDurationToSeconds('2d'), 172800);
  assert.equal(parseDurationToSeconds(120), 120);
});

test('bootstrap token/session roundtrip', (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const session = createBootstrapSession({
    storeDir: dir,
    expiresInSeconds: 3600,
  });

  assert.ok(session.token.startsWith(BOOTSTRAP_TOKEN_PREFIX));

  const parsed = parseBootstrapToken(session.token);
  assert.equal(parsed.sessionId, session.sessionId);
  assert.equal(parsed.keyId, session.keyId);

  const loaded = loadBootstrapSession(parsed.sessionId, { storeDir: dir });
  assert.equal(loaded.sessionId, session.sessionId);
  assert.equal(loaded.keyId, session.keyId);
});

test('encrypted archive can be imported once and marks session consumed', (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));

  const sourceConfig = path.join(dir, 'source.toml');
  const sourceCreds = path.join(dir, '.source.creds');
  fs.writeFileSync(sourceConfig, '[app]\ndb = "./health.sqlite"\n', 'utf8');
  fs.writeFileSync(
    sourceCreds,
    JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00Z', tokens: { oura: { accessToken: 'abc' } } }),
    'utf8',
  );

  const session = createBootstrapSession({
    storeDir: dir,
    expiresInSeconds: 3600,
  });
  const { payload } = buildRemotePayloadFromFiles({
    configPath: sourceConfig,
    credsPath: sourceCreds,
    sourceVersion: '0.3.0',
    allowMissingCreds: false,
  });
  const envelope = encryptRemotePayload(payload, session.token);
  const archivePath = path.join(dir, 'bundle.enc');
  writeRemoteArchiveFile(envelope, archivePath);

  const targetConfig = path.join(dir, 'target.toml');
  const targetCreds = path.join(dir, 'target.creds');
  fs.writeFileSync(targetConfig, 'old-config', 'utf8');
  fs.writeFileSync(targetCreds, 'old-creds', 'utf8');

  const result = importRemoteArchive({
    sessionRef: session.keyId,
    archivePath,
    targetConfigPath: targetConfig,
    targetCredsPath: targetCreds,
    storeDir: dir,
  });

  assert.equal(fs.readFileSync(targetConfig, 'utf8'), fs.readFileSync(sourceConfig, 'utf8'));
  assert.equal(fs.readFileSync(targetCreds, 'utf8'), fs.readFileSync(sourceCreds, 'utf8'));
  assert.equal(result.backups.length, 2);
  assert.equal(result.tokenCount, 1);

  assert.throws(
    () => importRemoteArchive({
      sessionRef: session.keyId,
      archivePath,
      targetConfigPath: targetConfig,
      targetCredsPath: targetCreds,
      storeDir: dir,
    }),
    /already consumed/,
  );
});
