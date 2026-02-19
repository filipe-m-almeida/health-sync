import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dtToIsoZ, sha256Hex, stableJsonStringify, utcNowIso } from './util.js';

export const BOOTSTRAP_TOKEN_PREFIX = 'hsr1.';
export const REMOTE_ARCHIVE_SCHEMA = 'health-sync-remote-archive-v1';
export const REMOTE_PAYLOAD_SCHEMA = 'health-sync-remote-payload-v1';

const DEFAULT_BOOTSTRAP_EXPIRES_SECONDS = 24 * 60 * 60;
const SESSION_FILE_MODE = 0o600;

function hasText(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function encodeBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function decodeBase64Url(value, label = 'base64url input') {
  try {
    return Buffer.from(String(value), 'base64url');
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function parseIsoDate(value, label) {
  const normalized = dtToIsoZ(value);
  if (!normalized) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function defaultSessionStoreDir() {
  if (hasText(process.env.HEALTH_SYNC_REMOTE_BOOTSTRAP_DIR)) {
    return path.resolve(String(process.env.HEALTH_SYNC_REMOTE_BOOTSTRAP_DIR));
  }
  return path.join(os.homedir(), '.health-sync', 'remote-bootstrap');
}

function sessionPath(sessionId, storeDir = null) {
  return path.join(path.resolve(storeDir || defaultSessionStoreDir()), `${sessionId}.json`);
}

function atomicWriteFile(filePath, content, mode = 0o600) {
  ensureDir(path.dirname(path.resolve(filePath)));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomHex(4)}`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Ignore chmod failures on non-POSIX filesystems.
  }
}

function parseDurationUnit(unitRaw) {
  const unit = String(unitRaw || 's').trim().toLowerCase();
  if (unit === '' || unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'second' || unit === 'seconds') {
    return 1;
  }
  if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes') {
    return 60;
  }
  if (unit === 'h' || unit === 'hr' || unit === 'hrs' || unit === 'hour' || unit === 'hours') {
    return 60 * 60;
  }
  if (unit === 'd' || unit === 'day' || unit === 'days') {
    return 24 * 60 * 60;
  }
  throw new Error(`Unsupported duration unit: ${unitRaw}`);
}

function normalizeSessionDoc(doc, label = 'bootstrap session') {
  const value = assertObject(doc, label);
  const sessionId = hasText(value.session_id) ? String(value.session_id) : null;
  const keyId = hasText(value.key_id) ? String(value.key_id) : null;
  const createdAt = parseIsoDate(value.created_at, `${label}.created_at`);
  const expiresAt = parseIsoDate(value.expires_at, `${label}.expires_at`);
  const privateKeyPem = hasText(value.private_key_pkcs8_pem) ? String(value.private_key_pkcs8_pem) : null;
  const recipientPublicDer = hasText(value.recipient_pub_der_b64u) ? String(value.recipient_pub_der_b64u) : null;
  const consumedAt = value.consumed_at ? parseIsoDate(value.consumed_at, `${label}.consumed_at`) : null;

  if (!sessionId || !/^[a-f0-9]{16,64}$/i.test(sessionId)) {
    throw new Error(`Invalid ${label}.session_id`);
  }
  if (!keyId || !/^[a-f0-9]{8,64}$/i.test(keyId)) {
    throw new Error(`Invalid ${label}.key_id`);
  }
  if (!privateKeyPem) {
    throw new Error(`Missing ${label}.private_key_pkcs8_pem`);
  }
  if (!recipientPublicDer) {
    throw new Error(`Missing ${label}.recipient_pub_der_b64u`);
  }

  return {
    version: Number(value.version) || 1,
    sessionId,
    keyId,
    createdAt,
    expiresAt,
    privateKeyPem,
    recipientPublicDer,
    consumedAt,
  };
}

function formatBackupTimestamp(value = new Date()) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-');
}

function validatePayloadFiles(payload) {
  const files = assertObject(payload?.files, 'remote payload.files');
  const config = files['health-sync.toml'];
  const creds = files['.health-sync.creds'];
  if (!config || !hasText(config.content)) {
    throw new Error('Remote payload is missing health-sync.toml');
  }
  if (!creds || !hasText(creds.content)) {
    throw new Error('Remote payload is missing .health-sync.creds');
  }
  return { config, creds };
}

function emptyCredsFileContent() {
  return `${stableJsonStringify({
    version: 1,
    updatedAt: utcNowIso(),
    tokens: {},
  })}\n`;
}

function deriveSymmetricKey({ sharedSecret, salt, sessionId, keyId }) {
  const info = Buffer.from(`health-sync-remote-v1|${sessionId}|${keyId}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 32));
}

function loadPublicKeyFromDerBase64Url(derBase64Url) {
  return crypto.createPublicKey({
    key: decodeBase64Url(derBase64Url, 'recipient public key'),
    format: 'der',
    type: 'spki',
  });
}

function loadPrivateKeyFromPem(privateKeyPem) {
  return crypto.createPrivateKey({
    key: String(privateKeyPem),
    format: 'pem',
    type: 'pkcs8',
  });
}

function parseArchiveEnvelope(raw) {
  const envelope = assertObject(raw, 'remote archive envelope');
  if (envelope.schema !== REMOTE_ARCHIVE_SCHEMA || Number(envelope.version) !== 1) {
    throw new Error('Unsupported remote archive version');
  }
  if (!hasText(envelope.session_id) || !hasText(envelope.key_id)) {
    throw new Error('Remote archive is missing session/key metadata');
  }
  if (!hasText(envelope.ephemeral_pub_der_b64u)) {
    throw new Error('Remote archive is missing ephemeral key');
  }
  if (!hasText(envelope.salt_b64u) || !hasText(envelope.nonce_b64u) || !hasText(envelope.tag_b64u)) {
    throw new Error('Remote archive is missing cryptographic parameters');
  }
  if (!hasText(envelope.ciphertext_b64u)) {
    throw new Error('Remote archive is missing ciphertext');
  }
  if (!hasText(envelope.aad_json)) {
    throw new Error('Remote archive is missing authenticated metadata');
  }

  try {
    const aad = assertObject(JSON.parse(String(envelope.aad_json)), 'remote archive aad');
    if (!hasText(aad.created_at) || !hasText(aad.payload_sha256)) {
      throw new Error('Remote archive AAD is missing required fields');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Remote archive AAD')) {
      throw err;
    }
    throw new Error('Remote archive has invalid authenticated metadata');
  }

  return envelope;
}

export function parseDurationToSeconds(value, fallbackSeconds = DEFAULT_BOOTSTRAP_EXPIRES_SECONDS) {
  if (value === null || value === undefined || value === '') {
    return fallbackSeconds;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  const text = String(value).trim();
  if (!text) {
    return fallbackSeconds;
  }

  const match = text.match(/^(\d+)\s*([a-zA-Z]+)?$/);
  if (!match) {
    throw new Error(`Invalid duration: ${text}`);
  }
  const quantity = Number.parseInt(match[1], 10);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`Invalid duration value: ${text}`);
  }
  const multiplier = parseDurationUnit(match[2] || 's');
  return quantity * multiplier;
}

export function bootstrapStoreDir() {
  return defaultSessionStoreDir();
}

export function parseBootstrapToken(token, options = {}) {
  const requireNotExpired = options.requireNotExpired !== false;
  const trimmed = String(token || '').trim();
  if (!trimmed.startsWith(BOOTSTRAP_TOKEN_PREFIX)) {
    throw new Error(`Bootstrap token must start with ${BOOTSTRAP_TOKEN_PREFIX}`);
  }

  const encoded = trimmed.slice(BOOTSTRAP_TOKEN_PREFIX.length);
  if (!encoded) {
    throw new Error('Bootstrap token is empty');
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(encoded, 'bootstrap token').toString('utf8'));
  } catch {
    throw new Error('Bootstrap token is not valid JSON');
  }
  assertObject(payload, 'bootstrap token payload');

  const normalized = {
    version: Number(payload.v) || 0,
    sessionId: hasText(payload.session_id) ? String(payload.session_id) : '',
    keyId: hasText(payload.key_id) ? String(payload.key_id) : '',
    recipientPublicDer: hasText(payload.recipient_pub) ? String(payload.recipient_pub) : '',
    createdAt: parseIsoDate(payload.created_at, 'bootstrap token created_at'),
    expiresAt: parseIsoDate(payload.expires_at, 'bootstrap token expires_at'),
    checksum: hasText(payload.checksum) ? String(payload.checksum) : '',
  };

  if (normalized.version !== 1) {
    throw new Error('Unsupported bootstrap token version');
  }
  if (!normalized.sessionId || !normalized.keyId || !normalized.recipientPublicDer) {
    throw new Error('Bootstrap token is missing required fields');
  }

  const checksumPayload = {
    v: normalized.version,
    session_id: normalized.sessionId,
    key_id: normalized.keyId,
    recipient_pub: normalized.recipientPublicDer,
    created_at: normalized.createdAt,
    expires_at: normalized.expiresAt,
  };
  const expectedChecksum = sha256Hex(stableJsonStringify(checksumPayload)).slice(0, 24);
  if (normalized.checksum !== expectedChecksum) {
    throw new Error('Bootstrap token checksum mismatch');
  }

  if (requireNotExpired) {
    const nowMs = Date.now();
    if (Date.parse(normalized.expiresAt) <= nowMs) {
      throw new Error(`Bootstrap token expired at ${normalized.expiresAt}`);
    }
  }

  return normalized;
}

export function createBootstrapSession(options = {}) {
  const expiresInSeconds = parseDurationToSeconds(
    options.expiresInSeconds,
    DEFAULT_BOOTSTRAP_EXPIRES_SECONDS,
  );
  const storeDir = path.resolve(options.storeDir || defaultSessionStoreDir());
  ensureDir(storeDir);

  const createdAt = utcNowIso();
  const expiresAt = dtToIsoZ(new Date(Date.parse(createdAt) + (expiresInSeconds * 1000)));
  const sessionId = randomHex(16);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const recipientPublicDer = encodeBase64Url(publicKey.export({ format: 'der', type: 'spki' }));
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const keyId = sha256Hex(recipientPublicDer).slice(0, 24);

  const checksumPayload = {
    v: 1,
    session_id: sessionId,
    key_id: keyId,
    recipient_pub: recipientPublicDer,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  const checksum = sha256Hex(stableJsonStringify(checksumPayload)).slice(0, 24);
  const tokenPayload = { ...checksumPayload, checksum };
  const token = `${BOOTSTRAP_TOKEN_PREFIX}${encodeBase64Url(Buffer.from(stableJsonStringify(tokenPayload), 'utf8'))}`;

  const session = {
    version: 1,
    session_id: sessionId,
    key_id: keyId,
    created_at: createdAt,
    expires_at: expiresAt,
    recipient_pub_der_b64u: recipientPublicDer,
    private_key_pkcs8_pem: String(privateKeyPem),
    consumed_at: null,
  };

  const outPath = sessionPath(sessionId, storeDir);
  atomicWriteFile(outPath, `${stableJsonStringify(session)}\n`, SESSION_FILE_MODE);

  return {
    token,
    sessionId,
    keyId,
    createdAt,
    expiresAt,
    storePath: outPath,
    fingerprint: `${keyId.slice(0, 12)}:${sessionId.slice(0, 8)}`,
  };
}

export function loadBootstrapSession(refOrToken, options = {}) {
  const storeDir = path.resolve(options.storeDir || defaultSessionStoreDir());
  if (!fs.existsSync(storeDir)) {
    throw new Error(`Remote bootstrap store does not exist: ${storeDir}`);
  }

  let tokenDetails = null;
  if (String(refOrToken || '').trim().startsWith(BOOTSTRAP_TOKEN_PREFIX)) {
    tokenDetails = parseBootstrapToken(refOrToken, { requireNotExpired: false });
  }

  const ref = tokenDetails
    ? tokenDetails.sessionId
    : String(refOrToken || '').trim();
  if (!ref) {
    throw new Error('Missing bootstrap session reference');
  }

  const candidate = sessionPath(ref, storeDir);
  if (fs.existsSync(candidate)) {
    const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    const session = normalizeSessionDoc(raw, `bootstrap session ${candidate}`);
    if (tokenDetails && (session.sessionId !== tokenDetails.sessionId || session.keyId !== tokenDetails.keyId)) {
      throw new Error('Bootstrap token does not match stored bootstrap session');
    }
    return {
      ...session,
      filePath: candidate,
    };
  }

  const fileNames = fs.readdirSync(storeDir).filter((name) => name.endsWith('.json'));
  for (const fileName of fileNames) {
    const filePath = path.join(storeDir, fileName);
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    try {
      const session = normalizeSessionDoc(raw, `bootstrap session ${filePath}`);
      if (session.keyId === ref || session.sessionId === ref || session.recipientPublicDer === ref) {
        if (tokenDetails && (session.sessionId !== tokenDetails.sessionId || session.keyId !== tokenDetails.keyId)) {
          throw new Error('Bootstrap token does not match stored bootstrap session');
        }
        return {
          ...session,
          filePath,
        };
      }
    } catch {
      continue;
    }
  }

  throw new Error(`Bootstrap session not found for reference: ${ref}`);
}

export function markBootstrapSessionConsumed(session, options = {}) {
  const storeDir = path.resolve(options.storeDir || defaultSessionStoreDir());
  const loaded = session?.filePath
    ? normalizeSessionDoc(JSON.parse(fs.readFileSync(session.filePath, 'utf8')))
    : loadBootstrapSession(session?.sessionId || session?.keyId, { storeDir });
  const filePath = session?.filePath || sessionPath(loaded.sessionId, storeDir);
  const consumedAt = utcNowIso();
  const updated = {
    version: loaded.version,
    session_id: loaded.sessionId,
    key_id: loaded.keyId,
    created_at: loaded.createdAt,
    expires_at: loaded.expiresAt,
    recipient_pub_der_b64u: loaded.recipientPublicDer,
    private_key_pkcs8_pem: loaded.privateKeyPem,
    consumed_at: consumedAt,
  };
  atomicWriteFile(filePath, `${stableJsonStringify(updated)}\n`, SESSION_FILE_MODE);
  return consumedAt;
}

export function buildRemotePayloadFromFiles(options = {}) {
  const configPath = path.resolve(String(options.configPath || 'health-sync.toml'));
  const credsPath = path.resolve(String(options.credsPath || path.join(path.dirname(configPath), '.health-sync.creds')));
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configContent = fs.readFileSync(configPath, 'utf8');
  let credsContent = null;
  if (fs.existsSync(credsPath)) {
    credsContent = fs.readFileSync(credsPath, 'utf8');
  } else if (options.allowMissingCreds !== false) {
    credsContent = emptyCredsFileContent();
  } else {
    throw new Error(`Creds file not found: ${credsPath}`);
  }

  const payload = {
    schema: REMOTE_PAYLOAD_SCHEMA,
    version: 1,
    created_at: utcNowIso(),
    source_version: hasText(options.sourceVersion) ? String(options.sourceVersion) : '0.0.0',
    files: {
      'health-sync.toml': {
        encoding: 'utf8',
        content: configContent,
        sha256: sha256Hex(configContent),
      },
      '.health-sync.creds': {
        encoding: 'utf8',
        content: credsContent,
        sha256: sha256Hex(credsContent),
      },
    },
  };

  return {
    payload,
    configPath,
    credsPath,
  };
}

export function encryptRemotePayload(payload, bootstrapToken, options = {}) {
  const token = parseBootstrapToken(bootstrapToken, {
    requireNotExpired: options.requireNotExpired !== false,
  });
  const value = assertObject(payload, 'remote payload');
  if (value.schema !== REMOTE_PAYLOAD_SCHEMA || Number(value.version) !== 1) {
    throw new Error('Unsupported remote payload version');
  }

  const recipientPublicKey = loadPublicKeyFromDerBase64Url(token.recipientPublicDer);
  const { privateKey: ephPrivateKey, publicKey: ephPublicKey } = crypto.generateKeyPairSync('x25519');
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephPrivateKey,
    publicKey: recipientPublicKey,
  });

  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = deriveSymmetricKey({
    sharedSecret,
    salt,
    sessionId: token.sessionId,
    keyId: token.keyId,
  });

  const payloadJson = stableJsonStringify(value);
  const payloadSha256 = sha256Hex(payloadJson);
  const compressed = gzipSync(Buffer.from(payloadJson, 'utf8'));

  const archiveCreatedAt = utcNowIso();
  const aad = {
    schema: REMOTE_ARCHIVE_SCHEMA,
    version: 1,
    session_id: token.sessionId,
    key_id: token.keyId,
    created_at: archiveCreatedAt,
    expires_at: token.expiresAt,
    payload_sha256: payloadSha256,
  };

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(stableJsonStringify(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    schema: REMOTE_ARCHIVE_SCHEMA,
    version: 1,
    session_id: token.sessionId,
    key_id: token.keyId,
    aad_json: stableJsonStringify(aad),
    ephemeral_pub_der_b64u: encodeBase64Url(ephPublicKey.export({ format: 'der', type: 'spki' })),
    salt_b64u: encodeBase64Url(salt),
    nonce_b64u: encodeBase64Url(nonce),
    ciphertext_b64u: encodeBase64Url(ciphertext),
    tag_b64u: encodeBase64Url(tag),
  };
}

export function decryptRemoteArchiveEnvelope(envelopeRaw, sessionRef, options = {}) {
  const envelope = parseArchiveEnvelope(envelopeRaw);
  const aad = JSON.parse(String(envelope.aad_json));
  const session = loadBootstrapSession(sessionRef, {
    storeDir: options.storeDir || defaultSessionStoreDir(),
  });

  if (session.consumedAt) {
    throw new Error(`Bootstrap session already consumed at ${session.consumedAt}`);
  }
  if (envelope.session_id !== session.sessionId || envelope.key_id !== session.keyId) {
    throw new Error('Remote archive does not match the selected bootstrap session');
  }

  if (Date.parse(aad.created_at || '') > Date.parse(session.expiresAt)) {
    throw new Error('Remote archive was created after bootstrap session expiry');
  }

  const ephPublicKey = loadPublicKeyFromDerBase64Url(envelope.ephemeral_pub_der_b64u);
  const privateKey = loadPrivateKeyFromPem(session.privateKeyPem);
  const sharedSecret = crypto.diffieHellman({
    privateKey,
    publicKey: ephPublicKey,
  });

  const salt = decodeBase64Url(envelope.salt_b64u, 'remote archive salt');
  const nonce = decodeBase64Url(envelope.nonce_b64u, 'remote archive nonce');
  const tag = decodeBase64Url(envelope.tag_b64u, 'remote archive auth tag');
  const ciphertext = decodeBase64Url(envelope.ciphertext_b64u, 'remote archive ciphertext');

  const key = deriveSymmetricKey({
    sharedSecret,
    salt,
    sessionId: session.sessionId,
    keyId: session.keyId,
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(String(envelope.aad_json), 'utf8'));
  decipher.setAuthTag(tag);

  let compressed = null;
  try {
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Failed to decrypt remote archive (auth/tag mismatch)');
  }

  const payloadJson = gunzipSync(compressed).toString('utf8');
  let payload = null;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error('Decrypted remote archive payload is not valid JSON');
  }

  if (aad.payload_sha256 !== sha256Hex(payloadJson)) {
    throw new Error('Decrypted remote archive payload checksum mismatch');
  }
  if (payload.schema !== REMOTE_PAYLOAD_SCHEMA || Number(payload.version) !== 1) {
    throw new Error('Unsupported remote archive payload schema');
  }

  return {
    envelope,
    payload,
    session,
  };
}

export function writeRemoteArchiveFile(envelope, outputPath) {
  const target = path.resolve(String(outputPath));
  atomicWriteFile(target, `${stableJsonStringify(envelope)}\n`, 0o600);
  return target;
}

export function readRemoteArchiveFile(archivePath) {
  const resolved = path.resolve(String(archivePath));
  if (!fs.existsSync(resolved)) {
    throw new Error(`Remote archive not found: ${resolved}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    throw new Error(`Remote archive is not valid JSON: ${resolved}`);
  }
  return {
    archivePath: resolved,
    envelope: parseArchiveEnvelope(parsed),
  };
}

export function defaultRemoteArchivePath(configPath, sessionId) {
  const safeSession = String(sessionId || '').slice(0, 12) || randomHex(6);
  const dir = path.dirname(path.resolve(configPath));
  return path.join(dir, `health-sync-remote-${safeSession}.enc`);
}

function backupIfExists(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  const backupPath = `${resolved}.bak-${formatBackupTimestamp()}`;
  fs.copyFileSync(resolved, backupPath);
  return backupPath;
}

function writeImportedFile(targetPath, content, mode) {
  atomicWriteFile(path.resolve(targetPath), content, mode);
}

export function importRemoteArchive(options = {}) {
  const archivePath = path.resolve(String(options.archivePath || ''));
  if (!archivePath) {
    throw new Error('archivePath is required');
  }
  const sessionRef = options.sessionRef;
  if (!sessionRef) {
    throw new Error('sessionRef is required');
  }

  const parsed = readRemoteArchiveFile(archivePath);
  const decrypted = decryptRemoteArchiveEnvelope(parsed.envelope, sessionRef, {
    storeDir: options.storeDir || defaultSessionStoreDir(),
  });
  const payload = decrypted.payload;
  const { config, creds } = validatePayloadFiles(payload);

  if (sha256Hex(config.content) !== config.sha256) {
    throw new Error('health-sync.toml checksum mismatch in remote payload');
  }
  if (sha256Hex(creds.content) !== creds.sha256) {
    throw new Error('.health-sync.creds checksum mismatch in remote payload');
  }

  const targetConfigPath = path.resolve(String(options.targetConfigPath || 'health-sync.toml'));
  const targetCredsPath = path.resolve(String(
    options.targetCredsPath || path.join(path.dirname(targetConfigPath), '.health-sync.creds'),
  ));

  const backups = [];
  const configBackup = backupIfExists(targetConfigPath);
  if (configBackup) {
    backups.push(configBackup);
  }
  const credsBackup = backupIfExists(targetCredsPath);
  if (credsBackup) {
    backups.push(credsBackup);
  }

  writeImportedFile(targetConfigPath, String(config.content), 0o600);
  writeImportedFile(targetCredsPath, String(creds.content), 0o600);
  const consumedAt = markBootstrapSessionConsumed(decrypted.session, {
    storeDir: options.storeDir || defaultSessionStoreDir(),
  });

  const tokenCount = (() => {
    try {
      const parsedCreds = JSON.parse(String(creds.content));
      return Object.keys(parsedCreds?.tokens || {}).length;
    } catch {
      return 0;
    }
  })();

  return {
    targetConfigPath,
    targetCredsPath,
    backups,
    consumedAt,
    sessionId: decrypted.session.sessionId,
    keyId: decrypted.session.keyId,
    tokenCount,
  };
}
