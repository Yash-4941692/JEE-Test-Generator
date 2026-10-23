'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  resolve,
  parseInput,
  extractRedirects,
  embeddedCandidates,
  isPrivateIp,
  ResolveError,
} = require('../src/resolver');

/** Start a mock site with a routing table, return { origin, close }. */
async function mockSite(routes) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const handler = routes[url.pathname];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    handler(req, res, url);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const html = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const redirect = (res, to, status = 302) => {
  res.writeHead(status, { location: to, 'content-type': 'text/html' });
  res.end('<html><body>moved</body></html>');
};

const opts = { allowPrivateHosts: true, perHopTimeoutMs: 4000, totalTimeoutMs: 12000 };

/* ------------------------------------------------------------------ */

test('parseInput accepts bare URLs, bare domains and messy pastes', () => {
  assert.equal(parseInput('https://vplink.in/snB67M'), 'https://vplink.in/snB67M');
  assert.equal(parseInput('vplink.in/snB67M'), 'https://vplink.in/snB67M');
  assert.equal(
    parseInput('here is the link https://arolinks.com/x9k2 thanks!'),
    'https://arolinks.com/x9k2'
  );
  assert.equal(parseInput('(https://vplink.in/snB67M).'), 'https://vplink.in/snB67M');
  assert.equal(parseInput('  https://a.co/b?x=1#frag  '), 'https://a.co/b?x=1#frag');

  assert.throws(() => parseInput(''), /Paste a link/);
  assert.throws(() => parseInput('   '), /Paste a link/);
  assert.throws(() => parseInput('hello there'), /doesn't look like a link/);
  assert.throws(() => parseInput('ftp://example.com/file'), /doesn't look like a link|http/);
});

test('follows a multi-hop 301/302 chain to the real destination', async () => {
  const site = await mockSite({
    '/snB67M': (req, res) => redirect(res, '/step2', 301),
    '/step2': (req, res) => redirect(res, '/step3', 302),
    '/step3': (req, res) => redirect(res, '/final', 307),
    '/final': (req, res) =>
      html(res, '<html><head><title>JEE Main 2025 Paper</title></head><body>ok</body></html>'),
  });
  try {
    const r = await resolve(`${site.origin}/snB67M`, opts);
    assert.equal(r.finalUrl, `${site.origin}/final`);
    assert.equal(r.finalStatus, 200);
    assert.equal(r.finalTitle, 'JEE Main 2025 Paper');
    assert.equal(r.hopCount, 3);
    assert.deepEqual(r.hops.map((h) => h.status), [301, 302, 307]);
    assert.equal(r.blocked, null);
    assert.ok(r.elapsedMs >= 0);
  } finally {
    await site.close();
  }
});

test('resolves relative Location headers against the current hop', async () => {
  const site = await mockSite({
    '/a': (req, res) => redirect(res, '../deep/page?q=1'),
    '/deep/page': (req, res) => html(res, '<title>done</title>'),
  });
  try {
    const r = await resolve(`${site.origin}/a`, opts);
    assert.equal(r.finalUrl, `${site.origin}/deep/page?q=1`);
  } finally {
    await site.close();
  }
});

test('follows a <meta http-equiv="refresh"> interstitial', async () => {
  const site = await mockSite({
    '/m': (req, res) =>
      html(
        res,
        `<html><head><title>Please wait</title>
         <meta http-equiv="refresh" content="3; url=/destination"></head>
         <body>Redirecting…</body></html>`
      ),
    '/destination': (req, res) => html(res, '<title>Destination</title><p>hi</p>'),
  });
  try {
    const r = await resolve(`${site.origin}/m`, opts);
    assert.equal(r.finalUrl, `${site.origin}/destination`);
    assert.equal(r.hops[0].kind, 'meta-refresh');
    assert.equal(r.hopCount, 1);
  } finally {
    await site.close();
  }
});

test('follows a simple JavaScript location.replace jump', async () => {
  const site = await mockSite({
    '/js': (req, res) =>
      html(res, `<html><script>window.location.replace("/target");</script></html>`),
    '/target': (req, res) => html(res, '<title>Made it</title>'),
  });
  try {
    const r = await resolve(`${site.origin}/js`, opts);
    assert.equal(r.finalUrl, `${site.origin}/target`);
    assert.equal(r.hops[0].kind, 'js-redirect');
  } finally {
    await site.close();
  }
});

test('follows an absolute JS location.href assignment across no hops', async () => {
  const site = await mockSite({
    '/js2': (req, res) =>
      html(res, `<script type="text/javascript">location.href = "/after";</script>`),
    '/after': (req, res) => html(res, '<title>after</title>'),
  });
  try {
    const r = await resolve(`${site.origin}/js2`, opts);
    assert.equal(r.finalUrl, `${site.origin}/after`);
  } finally {
    await site.close();
  }
});

test('reports a Cloudflare-style gate instead of pretending to resolve it', async () => {
  const site = await mockSite({
    '/gate': (req, res) =>
      html(
        res,
        `<html><head><title>Just a moment...</title></head>
         <body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
         Verify you are human</body></html>`,
        403
      ),
  });
  try {
    const r = await resolve(`${site.origin}/gate`, opts);
    assert.ok(r.blocked, 'expected a blocked result');
    assert.equal(r.blocked.code, 'cloudflare');
    assert.equal(r.finalUrl, `${site.origin}/gate`);
    assert.ok(r.warnings.length > 0);
  } finally {
    await site.close();
  }
});

test('stops on a redirect loop instead of spinning forever', async () => {
  const site = await mockSite({
    '/loop': (req, res) => redirect(res, '/loop'),
  });
  try {
    const r = await resolve(`${site.origin}/loop`, { ...opts, maxHops: 4 });
    assert.equal(r.hopCount, 4);
    assert.ok(r.warnings.some((w) => /loop|long/i.test(w)));
  } finally {
    await site.close();
  }
});

test('surfaces links found on a gateway page without auto-following them', async () => {
  const site = await mockSite({
    '/gw': (req, res) =>
      html(
        res,
        `<html><body>
           <h1>Please wait 10 seconds</h1>
           <a href="/get/file.pdf">Click here to continue</a>
         </body></html>`
      ),
    '/get/file.pdf': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4');
    },
  });
  try {
    const r = await resolve(`${site.origin}/gw`, opts);
    // Did not silently walk into the "continue" link:
    assert.equal(r.finalUrl, `${site.origin}/gw`);
    assert.equal(r.anchors.length, 1);
    assert.equal(r.anchors[0].url, `${site.origin}/get/file.pdf`);
    assert.equal(r.anchors[0].label, 'Click here to continue');
  } finally {
    await site.close();
  }
});

test('reports the file type of a direct file destination', async () => {
  const site = await mockSite({
    '/f': (req, res) => redirect(res, '/paper.pdf', 301),
    '/paper.pdf': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4');
    },
  });
  try {
    const r = await resolve(`${site.origin}/f`, opts);
    assert.equal(r.finalFileType, 'PDF document');
    assert.equal(r.finalUrl, `${site.origin}/paper.pdf`);
  } finally {
    await site.close();
  }
});

test('decodes destinations hidden in query params', () => {
  const plain = embeddedCandidates('https://short.io/x?url=https%3A%2F%2Fexample.com%2Fpaper.pdf');
  assert.equal(plain.length, 1);
  assert.equal(plain[0].url, 'https://example.com/paper.pdf');

  const b64 = embeddedCandidates(
    'https://short.io/x?r=' + Buffer.from('https://example.com/hidden').toString('base64')
  );
  assert.equal(b64[0].url, 'https://example.com/hidden');
  assert.equal(b64[0].how, 'base64');

  assert.deepEqual(embeddedCandidates('https://short.io/x?q=hello'), []);
});

test('extractRedirects prefers meta refresh over script noise', () => {
  const body = `
    <meta content="0;URL='/best'" http-equiv="refresh">
    <script>var url = "/weaker";</script>`;
  const found = extractRedirects(body, 'https://site.test/page');
  assert.equal(found[0].url, 'https://site.test/best');
  assert.equal(found[0].kind, 'meta-refresh');
});

test('extractRedirects ignores javascript:, anchors and self-refreshes', () => {
  const body = `
    <meta http-equiv="refresh" content="0;url=https://site.test/page">
    <script>location.href = "javascript:void(0)";</script>
    <script>location.href = "#";</script>`;
  assert.deepEqual(extractRedirects(body, 'https://site.test/page'), []);
});

test('rejects localhost and private IPs unless explicitly allowed', async () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.1.2.3'), true);
  assert.equal(isPrivateIp('192.168.0.5'), true);
  assert.equal(isPrivateIp('172.16.4.4'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('2606:4700::1111'), false);

  await assert.rejects(
    () => resolve('http://127.0.0.1:9/secret', {}),
    (err) => err instanceof ResolveError && err.code === 'PRIVATE_HOST'
  );
  await assert.rejects(
    () => resolve('http://localhost:9/secret', {}),
    (err) => err instanceof ResolveError && err.code === 'PRIVATE_HOST'
  );
});

test('surfaces a friendly error when the host cannot be reached', async () => {
  await assert.rejects(
    () => resolve('http://127.0.0.1:1/nothing', { ...opts, perHopTimeoutMs: 1500 }),
    (err) => err instanceof ResolveError && err.code === 'FETCH_FAILED'
  );
});

test('decodes base64 destinations embedded in script', () => {
  const b64 = Buffer.from('https://drive.google.com/file/d/xyz/view').toString('base64');

  const viaAtob = extractRedirects(
    `<script>window.location.replace(atob("${b64}"))</script>`,
    'https://vplink.in/x'
  );
  assert.equal(viaAtob[0].kind, 'base64');
  assert.equal(viaAtob[0].url, 'https://drive.google.com/file/d/xyz/view');

  const viaVar = extractRedirects(`<script>var dest = "${b64}";</script>`, 'https://vplink.in/x');
  assert.equal(viaVar[0].url, 'https://drive.google.com/file/d/xyz/view');
});

test('unescapes raw-slash JavaScript string literals', () => {
  const found = extractRedirects(
    '<script>location.href="https:\\x2f\\x2fexample.com\\x2fp.pdf"</script>',
    'https://vplink.in/x'
  );
  assert.equal(found[0].url, 'https://example.com/p.pdf');
});

test('follows a base64 script hop end to end', async () => {
  const site = await mockSite({
    '/b64': (req, res) => {
      const target = Buffer.from('/real-target').toString('base64');
      html(res, `<script>location.replace(atob("${target}"))</script>`);
    },
    '/real-target': (req, res) => html(res, '<title>decoded</title>'),
  });
  try {
    const r = await resolve(`${site.origin}/b64`, opts);
    assert.equal(r.finalUrl, `${site.origin}/real-target`);
    assert.equal(r.hops[0].kind, 'base64');
  } finally {
    await site.close();
  }
});
