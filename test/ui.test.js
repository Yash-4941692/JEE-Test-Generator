'use strict';

/**
 * UI smoke test: loads the real index.html + app.js into jsdom, stubs fetch,
 * and checks what actually renders.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function boot({ respond }) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    virtualConsole,
    url: 'https://preview.test/',
    pretendToBeVisual: true,
  });

  // jsdom lacks these; the UI calls them.
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.localStorage.clear();
  dom.window.fetch = async (url, init) => respond(url, init ? JSON.parse(init.body) : null);
  dom.window.navigator.clipboard = { writeText: async () => {} };

  dom.window.eval(appJs);
  return { dom, window: dom.window, doc: dom.window.document, errors };
}

const DEMO = {
  ok: true,
  demo: true,
  input: 'demo chain',
  entryUrl: '/demo/start',
  finalUrl: '/demo/destination',
  finalHost: 'this app (demo)',
  finalStatus: 200,
  finalTitle: 'JEE Main 2025 — Sample Question Paper',
  finalContentType: 'text/html; charset=utf-8',
  finalFileType: 'Web page',
  hops: [
    { url: '/demo/start', status: 302, kind: 'http-redirect', note: 'HTTP 302', next: '/demo/interstitial' },
    { url: '/demo/interstitial', status: 200, kind: 'meta-refresh', note: 'Meta refresh', next: '/demo/continue' },
    { url: '/demo/continue', status: 200, kind: 'js-redirect', note: 'JavaScript redirect', next: '/demo/destination' },
  ],
  hopCount: 3,
  blocked: null,
  warnings: [],
  anchors: [],
  embedded: [],
  elapsedMs: 58,
};

const REAL = {
  ok: true,
  demo: false,
  input: 'https://vplink.in/snB67M',
  entryUrl: 'https://vplink.in/snB67M',
  finalUrl: 'https://drive.example.com/file/d/abc123/view?usp=sharing',
  finalHost: 'drive.example.com',
  finalStatus: 200,
  finalTitle: 'JEE Main 2025 Question Paper',
  finalContentType: 'text/html; charset=utf-8',
  finalFileType: 'Web page',
  hops: [
    {
      url: 'https://vplink.in/snB67M',
      status: 302,
      kind: 'http-redirect',
      note: 'HTTP 302',
      next: 'https://arolinks.com/short/K2x9',
    },
    {
      url: 'https://arolinks.com/short/K2x9',
      status: 200,
      kind: 'meta-refresh',
      note: 'Meta refresh',
      next: 'https://drive.example.com/file/d/abc123/view?usp=sharing',
    },
  ],
  hopCount: 2,
  blocked: null,
  warnings: [],
  anchors: [
    { url: 'https://example.com/paper.pdf', label: 'Download question paper', host: 'example.com' },
  ],
  embedded: [],
  elapsedMs: 412,
};

const tick = () => new Promise((r) => setTimeout(r, 0));
async function submit(doc, window, value) {
  doc.querySelector('#url').value = value;
  doc.querySelector('#form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  await tick();
  await tick();
}

test('page boots without script errors and starts empty', () => {
  const { doc, errors, window } = boot({ respond: async () => ({ ok: true, json: async () => REAL }) });
  assert.equal(errors.length, 0);
  assert.equal(doc.querySelector('#result').hidden, true);
  assert.equal(doc.querySelector('#history-wrap').hidden, true);
  assert.equal(doc.querySelector('#demo').textContent, 'Try a demo chain');
  window.close();
});

test('demo chain renders every hop exactly once, with the destination last', async () => {
  const { window, doc } = boot({ respond: async () => ({ ok: true, json: async () => DEMO }) });

  doc.querySelector('#demo').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  await tick();
  await tick();

  const result = doc.querySelector('#result');
  assert.equal(result.hidden, false);
  assert.match(result.textContent, /Demo chain/);
  assert.equal(doc.querySelector('.final-url').textContent, '/demo/destination');

  const hops = [...doc.querySelectorAll('.hop-url')].map((n) => n.textContent);
  assert.deepEqual(hops, [
    '/demo/start',
    '/demo/interstitial',
    '/demo/continue',
    '/demo/destination',
  ]);

  // destination row is flagged final and tagged once
  const last = doc.querySelector('.hop.final');
  assert.match(last.textContent, /Destination/);
  assert.doesNotMatch(last.textContent, /JavaScript redirect/,
    'generic note must not repeat the kind label');
  const urlRows = [...doc.querySelectorAll('.hop-url')].filter(
    (n) => n.textContent === '/demo/destination'
  );
  assert.equal(urlRows.length, 1, 'destination must not appear twice');

  // demo runs are not pushed into history
  assert.equal(doc.querySelector('#history-wrap').hidden, true);
  window.close();
});

test('a real link shows the destination, copy button and chain', async () => {
  const { window, doc } = boot({ respond: async () => ({ ok: true, json: async () => REAL }) });

  await submit(doc, window, 'https://vplink.in/snB67M');

  assert.equal(doc.querySelector('.final-url').textContent, REAL.finalUrl);
  assert.match(doc.querySelector('.result-top').textContent, /Resolved/);
  assert.match(doc.querySelector('.result-top').textContent, /2 redirects/);

  // open + copy actions exist and point at the destination
  const open = doc.querySelector('a.btn.primary');
  assert.equal(open.getAttribute('href'), REAL.finalUrl);
  assert.equal(open.getAttribute('target'), '_blank');
  assert.match(open.textContent, /Open destination/);

  // facts
  const text = doc.querySelector('.facts').textContent;
  assert.match(text, /drive\.example\.com/);
  assert.match(text, /JEE Main 2025 Question Paper/);

  // chain: start -> hop -> destination
  const hops = [...doc.querySelectorAll('.hop-url')].map((n) => n.textContent);
  assert.equal(hops.length, 3);
  assert.equal(hops[2], REAL.finalUrl);

  // anchors found on the page are offered
  assert.match(doc.querySelector('.anchors').textContent, /Download question paper/);

  // and it lands in history
  assert.equal(doc.querySelector('#history-wrap').hidden, false);
  assert.match(doc.querySelector('#history').textContent, /vplink\.in/);
  window.close();
});

test('copy button copies the final URL without clobbering its own label', async () => {
  let copied = null;
  const { window, doc } = boot({ respond: async () => ({ ok: true, json: async () => REAL }) });
  window.navigator.clipboard.writeText = async (t) => { copied = t; };

  await submit(doc, window, 'https://vplink.in/snB67M');

  const btn = [...doc.querySelectorAll('button.btn')].find((b) => /Copy link/.test(b.textContent));
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();

  assert.equal(copied, REAL.finalUrl);
  assert.equal(btn.querySelector('.btn-label').textContent, 'Copied');
  assert.equal(btn.querySelectorAll('span').length, 2, 'icon + label, no duplicated label');
  window.close();
});

test('a gated destination is labelled as gated, not as resolved', async () => {
  const gated = {
    ...REAL,
    finalUrl: 'https://arolinks.com/short/K2x9',
    finalHost: 'arolinks.com',
    blocked: {
      code: 'cloudflare',
      label: 'Cloudflare bot check',
      message: 'This page is an interactive verification gate.',
    },
    warnings: ['Cloudflare bot check reached — the destination is behind human verification.'],
  };
  const { window, doc } = boot({ respond: async () => ({ ok: true, json: async () => gated }) });
  await submit(doc, window, 'https://arolinks.com/short/K2x9');

  assert.match(doc.querySelector('.result-top').textContent, /Gated/);
  assert.doesNotMatch(doc.querySelector('.result-top').textContent, /Resolved/);
  assert.match(doc.querySelector('.note').textContent, /Cloudflare bot check/);
  assert.match(doc.querySelector('.final-label').textContent, /Last reachable URL/);
  window.close();
});

test('server errors and bad input surface as an alert, not a crash', async () => {
  const { window, doc } = boot({
    respond: async () => ({
      ok: false,
      status: 422,
      json: async () => ({ ok: false, error: "That doesn't look like a link.", code: 'INVALID_INPUT' }),
    }),
  });

  await submit(doc, window, 'hello there');
  const alertBox = doc.querySelector('#alert');
  assert.equal(alertBox.hidden, false);
  assert.match(alertBox.textContent, /doesn't look like a link/);
  assert.equal(doc.querySelector('#result').hidden, true);
  window.close();
});

test('a network failure explains the outbound-internet possibility', async () => {
  const { window, doc } = boot({
    respond: async () => ({
      ok: false,
      status: 422,
      json: async () => ({ ok: false, error: "Couldn't reach the site (ECONNRESET).", code: 'FETCH_FAILED' }),
    }),
  });
  await submit(doc, window, 'https://vplink.in/snB67M');
  assert.match(doc.querySelector('#alert').textContent, /outbound internet/);
  window.close();
});
