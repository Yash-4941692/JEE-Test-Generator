'use strict';

/** Real HTTP-level tests against a spawned server process. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let child;

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the listening log line.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('running on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error('server exited: ' + code)));
  });
});

test.after(() => {
  if (child) child.kill('SIGTERM');
});

const post = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

test('serves the app shell', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /Link Inspector/);
  assert.match(body, /id="form"/);
});

test('serves the stylesheet and script', async () => {
  for (const [file, type] of [
    ['/styles.css', /text\/css/],
    ['/app.js', /javascript/],
  ]) {
    const res = await fetch(BASE + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), type);
  }
});

test('health endpoint responds', async () => {
  const res = await fetch(BASE + '/api/health');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
});

test('the demo chain resolves end to end over HTTP', async () => {
  const res = await post('/api/demo');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.demo, true);
  assert.equal(json.finalUrl, '/demo/destination');
  assert.equal(json.hopCount, 3);
  assert.deepEqual(
    json.hops.map((h) => h.kind),
    ['http-redirect', 'meta-refresh', 'js-redirect']
  );
  assert.equal(json.finalTitle, 'JEE Main 2025 — Sample Question Paper');

  // and the destination it reports actually exists
  const dest = await fetch(BASE + json.finalUrl);
  assert.equal(dest.status, 200);
});

test('rejects non-link input with 422 and a readable message', async () => {
  const res = await post('/api/resolve', { url: 'not a link' });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.code, 'INVALID_INPUT');
  assert.match(json.error, /doesn't look like a link/i);
});

test('rejects localhost targets (SSRF) with 422', async () => {
  const res = await post('/api/resolve', { url: 'http://127.0.0.1:22/' });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.code, 'PRIVATE_HOST');
});

test('rejects malformed JSON bodies', async () => {
  const res = await fetch(BASE + '/api/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"url": ',
  });
  assert.equal(res.status, 400);
});

test('serves 404s for unknown pages and endpoints', async () => {
  assert.equal((await fetch(BASE + '/nope')).status, 404);
  const api = await fetch(BASE + '/api/unknown', { method: 'POST' });
  assert.equal(api.status, 404);
});

test('cannot be walked out of public/ with path traversal', async () => {
  for (const attempt of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js']) {
    const res = await fetch(BASE + attempt);
    if (res.status === 200) {
      const body = await res.text();
      assert.doesNotMatch(body, /require\('node:http'\)/, 'leaked server source via ' + attempt);
    }
  }
});
