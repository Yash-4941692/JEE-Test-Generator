'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { resolve, ResolveError } = require('./src/resolver');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* --- tiny in-memory rate limit (per IP) ---------------------------------- */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now - e.start > WINDOW_MS * 2) hits.delete(ip);
}, 60_000).unref();

/* --- helpers ------------------------------------------------------------ */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ResolveError('That request was too large.', 'BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // Never serve outside public/
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/* --- demo chain ---------------------------------------------------------- *
 * A real redirect chain served by this app, used by the "Try a demo" button.
 * It exists so the UI can be exercised even where the host has no outbound
 * internet (sandboxed previews, locked-down networks).
 * ------------------------------------------------------------------------- */
const DEMO_ROUTES = {
  '/demo/start': (res) => {
    res.writeHead(302, { location: '/demo/interstitial', 'content-type': 'text/html' });
    res.end('<html><body>moved</body></html>');
  },
  '/demo/interstitial': (res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Please wait…</title>' +
        '<meta http-equiv="refresh" content="2; url=/demo/continue"></head>' +
        '<body><p>Preparing your link…</p></body></html>'
    );
  },
  '/demo/continue': (res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Continue</title></head><body>' +
        "<script>window.location.replace('/demo/destination');</script>" +
        '<a href="/demo/destination">Continue</a></body></html>'
    );
  },
  '/demo/destination': (res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>JEE Main 2025 — Sample Question Paper</title></head>' +
        '<body><h1>JEE Main 2025 — Sample Question Paper</h1>' +
        '<p>This is the end of the demo chain.</p></body></html>'
    );
  },
};

function handleDemo(req, res, pathname) {
  const route = DEMO_ROUTES[pathname];
  if (!route) return false;
  route(res);
  return true;
}

/* --- server ------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (pathname.startsWith('/demo/')) {
    if (handleDemo(req, res, pathname)) return;
    res.writeHead(404).end('Unknown demo step');
    return;
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  // Runs the full resolver against this app's own demo chain. URLs are
  // returned as relative paths so they open through the preview, not the
  // viewer's own localhost.
  if (pathname === '/api/demo') {
    const origin = `http://127.0.0.1:${PORT}`;
    const rel = (u) => (typeof u === 'string' ? u.replace(origin, '') || '/' : u);
    try {
      const result = await resolve(`${origin}/demo/start`, { allowPrivateHosts: true });
      return sendJson(res, 200, {
        ...result,
        demo: true,
        input: 'demo chain',
        entryUrl: rel(result.entryUrl),
        finalUrl: rel(result.finalUrl),
        finalHost: 'this app (demo)',
        hops: result.hops.map((h) => ({ ...h, url: rel(h.url), next: rel(h.next) })),
        anchors: result.anchors.map((a) => ({ ...a, url: rel(a.url) })),
      });
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: 'The demo chain failed to run.',
        code: 'DEMO_FAILED',
      });
    }
  }

  if (pathname === '/api/resolve') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Use POST.' });
    }

    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Too many lookups in a row. Give it a minute.',
        code: 'RATE_LIMITED',
      });
    }

    try {
      const raw = await readBody(req);
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Send JSON: { "url": "..." }' });
      }
      const result = await resolve(payload.url ?? '', {});
      return sendJson(res, 200, result);
    } catch (err) {
      const known = err instanceof ResolveError;
      return sendJson(res, known ? 422 : 500, {
        ok: false,
        error: known ? err.message : 'Something went wrong while resolving that link.',
        code: known ? err.code : 'INTERNAL',
      });
    }
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: 'Unknown endpoint.' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Link Inspector running on http://${HOST}:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
