import assert from 'node:assert/strict';
import test from 'node:test';

import {
  oauthResultFromPaste,
  parseRetryAfterSeconds,
  requestJson,
  toEpochSeconds,
} from '../src/util.js';
import { jsonResponse, withFetchMock } from './test-helpers.js';

test('parseRetryAfterSeconds parses numeric seconds', () => {
  assert.equal(parseRetryAfterSeconds('5'), 5);
});

test('parseRetryAfterSeconds parses HTTP-date values', () => {
  const future = new Date(Date.now() + 20_000).toUTCString();
  const parsed = parseRetryAfterSeconds(future);
  assert.ok(parsed !== null);
  assert.ok(parsed >= 1);
  assert.ok(parsed <= 25);
});

test('parseRetryAfterSeconds warns on invalid values', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const parsed = parseRetryAfterSeconds('nonsense');
    assert.equal(parsed, null);
    assert.ok(warnings.some((w) => w.includes('Invalid Retry-After header value')));
  } finally {
    console.warn = originalWarn;
  }
});

test('toEpochSeconds accepts epoch, ISO, and date strings', () => {
  assert.equal(toEpochSeconds('1770715852'), 1770715852);
  assert.equal(toEpochSeconds('2026-02-10T09:30:52Z'), 1770715852);
  assert.equal(toEpochSeconds('2026-02-10'), 1770681600);
});

test('oauthResultFromPaste parses full callback URL', () => {
  const parsed = oauthResultFromPaste('http://127.0.0.1:8486/callback?code=abc123&state=s1');
  assert.ok(parsed);
  assert.equal(parsed.code, 'abc123');
  assert.equal(parsed.state, 's1');
  assert.equal(parsed.error, null);
});

test('oauthResultFromPaste parses query-string shapes', () => {
  const parsed = oauthResultFromPaste('?code=xyz789&state=s2');
  assert.ok(parsed);
  assert.equal(parsed.code, 'xyz789');
  assert.equal(parsed.state, 's2');
});

test('oauthResultFromPaste parses issuer when present', () => {
  const parsed = oauthResultFromPaste(
    'http://localhost:8080/callback?code=c1&iss='
      + 'https%3A%2F%2Fmoi.ouraring.com%2Foauth%2Fv2%2Fext%2Foauth-anonymous',
  );
  assert.ok(parsed);
  assert.equal(parsed.code, 'c1');
  assert.equal(parsed.issuer, 'https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous');
});

test('oauthResultFromPaste parses fragment callback payload', () => {
  const parsed = oauthResultFromPaste('http://127.0.0.1:8486/callback#code=frag-code&state=sf');
  assert.ok(parsed);
  assert.equal(parsed.code, 'frag-code');
  assert.equal(parsed.state, 'sf');
});

test('oauthResultFromPaste falls back to raw code', () => {
  const parsed = oauthResultFromPaste('plain-code-token');
  assert.ok(parsed);
  assert.equal(parsed.code, 'plain-code-token');
  assert.equal(parsed.state, null);
});

test('oauthResultFromPaste rejects unstructured text', () => {
  assert.equal(oauthResultFromPaste('this is not oauth input'), null);
});

test('requestJson retries 5xx responses with backoff and succeeds', async (t) => {
  const responses = [
    jsonResponse({ error: 'temporary' }, { status: 500 }),
    jsonResponse({ error: 'still temporary' }, { status: 502 }),
    jsonResponse({ ok: true }, { status: 200 }),
  ];
  let calls = 0;
  withFetchMock(t, async () => {
    const idx = calls;
    calls += 1;
    return responses[idx];
  });

  const out = await requestJson('https://example.test/endpoint', {
    retryBackoffMs: 0,
  });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 3);
});

test('requestJson retries 429 responses and succeeds', async (t) => {
  const responses = [
    jsonResponse({ error: 'rate_limited' }, { status: 429 }),
    jsonResponse({ ok: true }, { status: 200 }),
  ];
  let calls = 0;
  withFetchMock(t, async () => {
    const idx = calls;
    calls += 1;
    return responses[idx];
  });

  const out = await requestJson('https://example.test/endpoint', {
    retryBackoffMs: 0,
  });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2);
});

test('requestJson 4xx includes trace id and error details', async (t) => {
  withFetchMock(t, async () => jsonResponse(
    {
      error: 'invalid_scope',
      error_description: 'revoked',
    },
    {
      status: 403,
      headers: { 'x-trace-id': 'trace-1' },
    },
  ));

  await assert.rejects(
    () => requestJson('https://example.test/endpoint'),
    (err) => {
      assert.match(String(err.message), /HTTP 403/);
      assert.match(String(err.message), /invalid_scope/);
      assert.match(String(err.message), /revoked/);
      assert.match(String(err.message), /trace-1/);
      return true;
    },
  );
});

test('requestJson 4xx falls back to response text when JSON is invalid', async (t) => {
  withFetchMock(t, async () => new Response('bad request body', { status: 400 }));

  await assert.rejects(
    () => requestJson('https://example.test/endpoint'),
    (err) => {
      assert.match(String(err.message), /HTTP 400/);
      assert.match(String(err.message), /bad request body/);
      return true;
    },
  );
});

test('requestJson retries network errors up to max attempts', async (t) => {
  let calls = 0;
  withFetchMock(t, async () => {
    calls += 1;
    const err = new Error('net down');
    err.cause = { code: 'ECONNRESET' };
    throw err;
  });

  await assert.rejects(
    () => requestJson('https://example.test/endpoint', { retries: 3, retryBackoffMs: 0 }),
    /net down/,
  );
  assert.equal(calls, 3);
});

test('requestJson raises when success response is not JSON', async (t) => {
  withFetchMock(t, async () => new Response('ok but not json', { status: 200 }));

  await assert.rejects(
    () => requestJson('https://example.test/endpoint'),
    /Expected JSON response/,
  );
});
