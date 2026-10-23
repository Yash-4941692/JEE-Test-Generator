'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { analyse } = require('./src/topics');
const { YouTubeError } = require('./src/youtube');
const { runSample, listSamples } = require('./src/demo');
const { withBudget, BudgetExceeded } = require('./src/budget');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Answer before any gateway in front of us gives up. A proxy that times out
// returns its own HTML error page, which the browser can only report as a bare
// "HTTP 502" — so we send JSON first, always.
const REQUEST_BUDGET_MS = Number(process.env.REQUEST_BUDGET_MS) || 10000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 7000;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/* --- rate limit ---------------------------------------------------------- */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 25;
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

/* --- helpers ------------------------------------------------------------- */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const STATUS_FOR_CODE = {
  EMPTY_INPUT: 422,
  INVALID_URL: 422,
  NOT_YOUTUBE: 422,
  VIDEO_UNAVAILABLE: 404,
  UPSTREAM_RATE_LIMITED: 429,
  TIMEOUT: 504,
  FETCH_FAILED: 502,
  PAGE_UNREADABLE: 502,
  RATE_LIMITED: 429,
};

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new YouTubeError('That request was too large.', 'INVALID_URL'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

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

/* --- routing ------------------------------------------------------------- */
async function route(req, res, pathname) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      budgetMs: REQUEST_BUDGET_MS,
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    });
  }

  if (pathname === '/api/samples' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, samples: listSamples() });
  }

  if (pathname.startsWith('/api/samples/') && req.method === 'POST') {
    const key = pathname.split('/').pop();
    try {
      const report = await runSample(key);
      if (!report) return sendJson(res, 404, { ok: false, error: 'Unknown sample.', code: 'NOT_FOUND' });
      return sendJson(res, 200, report);
    } catch (err) {
      log('sample failed', key, err && err.message);
      return sendJson(res, 500, {
        ok: false,
        error: 'That sample failed to run.',
        code: 'SAMPLE_FAILED',
      });
    }
  }

  if (pathname === '/api/topics') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Use POST.' });
    }

    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Too many videos in a row. Give it a minute.',
        code: 'RATE_LIMITED',
      });
    }

    let payload = {};
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch (err) {
      if (err instanceof YouTubeError) {
        return sendJson(res, 413, { ok: false, error: err.message, code: err.code });
      }
      return sendJson(res, 400, { ok: false, error: 'Send JSON: { "url": "..." }', code: 'BAD_JSON' });
    }

    try {
      // Never wait longer than our own budget — answer with JSON before a proxy
      // in front of us times out and replaces the response with its own page.
      const report = await withBudget(
        () => analyse(payload.url ?? '', { timeoutMs: UPSTREAM_TIMEOUT_MS }),
        REQUEST_BUDGET_MS
      );
      return sendJson(res, 200, report);
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        log('budget exceeded after', err.budgetMs + 'ms');
        return sendJson(res, 504, {
          ok: false,
          error: 'YouTube took too long to answer, so the lookup was stopped before the request timed out. Try again, or use the offline samples.',
          code: 'TIMEOUT',
        });
      }

      const known = err instanceof YouTubeError;
      const status = known ? STATUS_FOR_CODE[err.code] || 500 : 500;
      if (!known) log('unexpected analysis error:', err && (err.stack || err.message));
      return sendJson(res, status, {
        ok: false,
        error: known ? err.message : 'Something went wrong while reading that video.',
        code: known ? err.code : 'INTERNAL',
        ...(known && err.details && Object.keys(err.details).length ? { details: err.details } : {}),
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
}

/* --- server -------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let pathname = '/';

  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  // One log line per request: this is how you tell an app failure apart from a
  // gateway failure. If the browser reports an error and nothing appears here,
  // the request never reached the app.
  res.on('finish', () => {
    if (!pathname.startsWith('/api/')) return;
    log(`${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });

  try {
    await route(req, res, pathname);
  } catch (err) {
    log('handler crashed:', err && (err.stack || err.message));
    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: 'The server hit an unexpected error while handling that request.',
        code: 'INTERNAL',
      });
    } else {
      res.end();
    }
  }
});

// Keep serving: a stray rejection must not take the whole app down, because a
// dead app behind a proxy is indistinguishable from a gateway error to a user.
process.on('unhandledRejection', (reason) => {
  log('unhandled rejection:', reason && (reason.stack || reason.message || reason));
});
process.on('uncaughtException', (err) => {
  log('uncaught exception:', err && (err.stack || err.message));
});

server.listen(PORT, HOST, () => {
  console.log(`Chapter One running on http://${HOST}:${PORT}`);
  log(`budget ${REQUEST_BUDGET_MS}ms, upstream timeout ${UPSTREAM_TIMEOUT_MS}ms`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
