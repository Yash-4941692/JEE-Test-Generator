'use strict';

/** HTTP-level tests against a spawned server process. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let child;

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
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

const post = (p, body) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

test('serves the app shell', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /Chapter One/);
  assert.match(body, /id="form"/);
  assert.match(body, /exact topic timestamps/i);
});

test('serves the stylesheet and client script', async () => {
  for (const [file, type] of [['/styles.css', /text\/css/], ['/app.js', /javascript/]]) {
    const res = await fetch(BASE + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), type);
  }
});

test('health endpoint', async () => {
  const res = await fetch(BASE + '/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('lists the offline samples', async () => {
  const res = await fetch(BASE + '/api/samples');
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.deepEqual(data.samples.map((s) => s.key).sort(), ['inferred', 'verified']);
});

test('verified sample returns exact chapter timestamps', async () => {
  const res = await post('/api/samples/verified');
  assert.equal(res.status, 200);
  const report = await res.json();

  assert.equal(report.accuracy.tier, 'verified');
  assert.equal(report.topics.length, 10);
  assert.equal(report.topics[0].startMs, 0);
  assert.equal(report.topics[0].label, 'Introduction to Circular Motion');
  assert.equal(report.topics[1].startMs, 95000);
  assert.ok(report.sample, 'sample results are labelled as samples');
  assert.equal(report.video.id, 'fixtureVer1');
});

test('inferred sample returns approximate topics with confidence and evidence', async () => {
  const res = await post('/api/samples/inferred');
  const report = await res.json();

  assert.equal(report.accuracy.tier, 'inferred');
  assert.equal(report.topics.length, 8);
  for (const topic of report.topics) {
    assert.ok(topic.confidence > 0 && topic.confidence < 1);
    assert.ok(topic.evidence);
  }
  assert.ok(report.sample.groundTruth.length === 8);
});

test('unknown sample is a clean 404', async () => {
  const res = await post('/api/samples/nope');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
});

test('rejects non-YouTube links with a readable message', async () => {
  const res = await post('/api/topics', { url: 'https://vimeo.com/12345' });
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.code, 'NOT_YOUTUBE');
  assert.match(json.error, /Only YouTube/);
});

test('rejects empty and junk input', async () => {
  const empty = await post('/api/topics', { url: '' });
  assert.equal(empty.status, 422);
  assert.equal((await empty.json()).code, 'EMPTY_INPUT');

  const junk = await post('/api/topics', { url: 'hello world' });
  assert.equal(junk.status, 422);
  assert.equal((await junk.json()).code, 'INVALID_URL');
});

test('rejects malformed bodies and wrong methods', async () => {
  const bad = await fetch(BASE + '/api/topics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"url": ',
  });
  assert.equal(bad.status, 400);

  const wrong = await fetch(BASE + '/api/topics');
  assert.equal(wrong.status, 405);
});

test('404s for unknown pages and endpoints', async () => {
  assert.equal((await fetch(BASE + '/nope')).status, 404);
  assert.equal((await post('/api/unknown')).status, 404);
});

test('cannot be walked out of public/ with path traversal', async () => {
  for (const attempt of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js']) {
    const res = await fetch(BASE + attempt);
    if (res.status === 200) {
      const body = await res.text();
      assert.doesNotMatch(body, /require\('node:http'\)/, 'leaked server source via ' + attempt);
      assert.doesNotMatch(body, /CUE_PREFIX/, 'leaked server source via ' + attempt);
    }
  }
});
