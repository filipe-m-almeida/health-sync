import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

function stripMillis(isoString) {
  return isoString.replace(/\.\d{3}Z$/, 'Z');
}

export function utcNowIso() {
  return stripMillis(new Date().toISOString());
}

export function isoToDate(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const normalized = trimmed.endsWith('Z') ? trimmed : trimmed;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dtToIsoZ(value) {
  const d = isoToDate(value);
  if (!d) {
    return null;
  }
  return stripMillis(d.toISOString());
}

export function parseYYYYMMDD(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  const d = new Date(`${trimmed}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toEpochSeconds(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(`${trimmed}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) {
        return null;
      }
      return Math.floor(d.getTime() / 1000);
    }
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      return null;
    }
    return Math.floor(d.getTime() / 1000);
  }
  return null;
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function basicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function stableJsonStringify(value) {
  const seen = new WeakSet();
  const normalize = (node) => {
    if (node === null || typeof node !== 'object') {
      return node;
    }
    if (seen.has(node)) {
      throw new TypeError('Cannot stringify circular structures');
    }
    seen.add(node);
    if (Array.isArray(node)) {
      const out = node.map((item) => normalize(item));
      seen.delete(node);
      return out;
    }
    const out = {};
    for (const key of Object.keys(node).sort()) {
      out[key] = normalize(node[key]);
    }
    seen.delete(node);
    return out;
  };
  return JSON.stringify(normalize(value));
}

export function parseRetryAfterSeconds(retryAfter) {
  if (!retryAfter) {
    return null;
  }
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return Math.max(0, Math.floor(retryAfter));
  }
  if (typeof retryAfter !== 'string') {
    return null;
  }
  const trimmed = retryAfter.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number.parseInt(trimmed, 10));
  }
  const retryAt = Date.parse(trimmed);
  if (Number.isNaN(retryAt)) {
    console.warn(`Invalid Retry-After header value: ${retryAfter}`);
    return null;
  }
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function buildHttpError(method, url, response, parsedBody, rawText) {
  const detailCandidates = [];
  if (parsedBody && typeof parsedBody === 'object') {
    for (const key of ['error', 'error_description', 'detail', 'message']) {
      if (parsedBody[key]) {
        detailCandidates.push(String(parsedBody[key]));
      }
    }
  }
  if (!detailCandidates.length && rawText) {
    detailCandidates.push(rawText.slice(0, 240));
  }
  const traceId = response.headers.get('x-trace-id') || response.headers.get('x-request-id');
  const detail = detailCandidates.length ? `: ${detailCandidates.join(' | ')}` : '';
  const trace = traceId ? ` [trace ${traceId}]` : '';
  const err = new Error(`HTTP ${response.status} ${response.statusText} for ${method.toUpperCase()} ${url}${detail}${trace}`);
  err.status = response.status;
  err.url = url;
  err.method = method;
  err.traceId = traceId;
  err.body = parsedBody;
  return err;
}

export async function requestJson(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    params = null,
    json = undefined,
    data = undefined,
    timeoutMs = 30000,
    retries = 3,
    retryBackoffMs = 500,
    expectedStatus = null,
  } = options;

  const target = new URL(url);
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }
      target.searchParams.set(key, String(value));
    }
  }

  const requestHeaders = { ...headers };
  let body = undefined;
  if (json !== undefined) {
    body = JSON.stringify(json);
    if (!Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      requestHeaders['Content-Type'] = 'application/json';
    }
  } else if (data !== undefined) {
    if (data instanceof URLSearchParams) {
      body = data;
    } else if (typeof data === 'object' && data !== null) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) {
          continue;
        }
        form.set(key, String(value));
      }
      body = form;
    } else {
      body = String(data);
    }
    if (!Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  let lastError = null;
  const maxAttempts = Math.max(1, retries);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const response = await fetch(target, {
        method,
        headers: requestHeaders,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const rawText = await response.text();
      let parsedBody = null;
      if (rawText) {
        try {
          parsedBody = JSON.parse(rawText);
        } catch {
          parsedBody = null;
        }
      }

      const shouldRetry = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (shouldRetry && attempt < maxAttempts) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);
        const delayMs = retryAfterSeconds !== null
          ? retryAfterSeconds * 1000
          : retryBackoffMs * (2 ** (attempt - 1));
        await sleep(delayMs);
        continue;
      }

      if (expectedStatus !== null) {
        const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
        if (!allowed.includes(response.status)) {
          throw buildHttpError(method, target.toString(), response, parsedBody, rawText);
        }
      } else if (!response.ok) {
        throw buildHttpError(method, target.toString(), response, parsedBody, rawText);
      }

      if (!rawText) {
        return {};
      }
      if (parsedBody === null) {
        throw new Error(`Expected JSON response from ${target.toString()} but received non-JSON payload`);
      }
      return parsedBody;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      const status = error?.status;
      const retryable = (status === 429 || (status >= 500 && status <= 599))
        || error?.name === 'AbortError'
        || error?.cause?.code === 'ECONNRESET'
        || error?.cause?.code === 'ETIMEDOUT';
      if (attempt < maxAttempts && retryable) {
        const delayMs = retryBackoffMs * (2 ** (attempt - 1));
        await sleep(delayMs);
        continue;
      }
      if (attempt >= maxAttempts) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(`Request failed for ${method.toUpperCase()} ${target.toString()}`, { cause: error });
      }
    }
  }

  throw new Error(`Request failed for ${method.toUpperCase()} ${target.toString()}`, { cause: lastError });
}

export class OAuthResult {
  constructor({ code = null, state = null, error = null, issuer = null } = {}) {
    this.code = code;
    this.state = state;
    this.error = error;
    this.issuer = issuer;
  }
}

function oauthResultFromQueryParams(params) {
  const code = params.get('code') || null;
  const state = params.get('state') || null;
  const error = params.get('error') || null;
  const issuer = params.get('iss') || params.get('issuer') || null;
  if (!code && !error) {
    return null;
  }
  return new OAuthResult({ code, state, error, issuer });
}

export function oauthResultFromPaste(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return oauthResultFromQueryParams(url.searchParams);
    } catch {
      return null;
    }
  }

  const queryIdx = trimmed.indexOf('?');
  if (queryIdx >= 0 && queryIdx < trimmed.length - 1) {
    const params = new URLSearchParams(trimmed.slice(queryIdx + 1));
    const parsed = oauthResultFromQueryParams(params);
    if (parsed) {
      return parsed;
    }
  }

  if (trimmed.includes('=') || trimmed.includes('&')) {
    const params = new URLSearchParams(trimmed.replace(/^\?/, ''));
    const parsed = oauthResultFromQueryParams(params);
    if (parsed) {
      return parsed;
    }
  }

  if (/^[A-Za-z0-9._-]{8,}$/.test(trimmed)) {
    return new OAuthResult({ code: trimmed });
  }

  return null;
}

function tryOpen(command, args, url) {
  try {
    const child = spawn(command, [...args, url], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function openInBrowser(url) {
  if (!url) {
    return false;
  }
  if (process.platform === 'darwin') {
    return tryOpen('open', [], url);
  }
  if (process.platform === 'win32') {
    return tryOpen('cmd', ['/c', 'start', ''], url);
  }
  return tryOpen('xdg-open', [], url);
}

export async function oauthListenForCode(options = {}) {
  const {
    listenHost = '127.0.0.1',
    listenPort = 0,
    callbackPath = '/callback',
    timeoutSeconds = 300,
    onStatus = null,
  } = options;

  const normalizedPath = callbackPath.startsWith('/') ? callbackPath : `/${callbackPath}`;

  let resolved = false;
  let resolvePromise;
  let rejectPromise;

  const resultPromise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  let rl = null;
  let timeoutHandle = null;

  const finish = (callback) => {
    if (resolved) {
      return;
    }
    resolved = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (rl) {
      rl.close();
      rl = null;
    }
    server.close(() => {
      callback();
    });
  };

  const resolveOnce = (value) => {
    finish(() => resolvePromise(value));
  };

  const rejectOnce = (error) => {
    finish(() => rejectPromise(error));
  };

  const server = http.createServer((req, res) => {
    try {
      const origin = `http://${listenHost}:${server.address()?.port ?? listenPort}`;
      const url = new URL(req.url || '/', origin);
      if (url.pathname !== normalizedPath) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }
      const parsed = oauthResultFromQueryParams(url.searchParams);
      if (!parsed) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Missing OAuth code/error in callback URL.');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><body><h3>Authentication complete.</h3><p>You can close this tab.</p></body></html>');
      resolveOnce(parsed);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Callback handling failed.');
      rejectOnce(err);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : listenPort;
  const callbackUrl = `http://${listenHost}:${activePort}${normalizedPath}`;
  if (typeof onStatus === 'function') {
    onStatus(`Listening for OAuth callback on ${callbackUrl}`);
  }

  if (process.stdin.isTTY) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (typeof onStatus === 'function') {
      onStatus('If browser redirect fails, paste the full callback URL or auth code and press Enter.');
    }
    rl.setPrompt('OAuth code/callback> ');
    rl.prompt();
    rl.on('line', (line) => {
      const parsed = oauthResultFromPaste(line);
      if (parsed) {
        resolveOnce(parsed);
        return;
      }
      process.stdout.write('Could not parse input. Paste callback URL or code.\n');
      rl.prompt();
    });
  }

  timeoutHandle = setTimeout(() => {
    rejectOnce(new Error(`Timed out after ${timeoutSeconds}s waiting for OAuth callback`));
  }, Math.max(1, timeoutSeconds) * 1000);

  return resultPromise;
}
