'use strict';

/**
 * Link resolver: follows a short link through its real redirect chain and
 * reports the final destination.
 *
 * Handles: HTTP 3xx chains, <meta refresh>, simple JS location jumps,
 * JSON/plain-text URL responses, and embedded destination params.
 *
 * Does NOT defeat interactive bot checks (Cloudflare "Just a moment",
 * captcha / "verify you are human" gates). When it hits one it reports the
 * gate honestly and surfaces any destination the page already exposes.
 */

const dns = require('node:dns/promises');
const net = require('node:net');

const DEFAULTS = {
  maxHops: 12,
  perHopTimeoutMs: 12000,
  totalTimeoutMs: 35000,
  maxBodyBytes: 512 * 1024,
  allowPrivateHosts: false, // tests set this to true to use local mock servers
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * Input parsing
 * ------------------------------------------------------------------ */

/**
 * Accepts a bare URL, a domain without a scheme, or a whole pasted message
 * containing a URL somewhere in it. Returns a normalised absolute URL.
 */
function parseInput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ResolveError('Paste a link first.', 'EMPTY_INPUT');
  }

  const text = raw.trim();

  // 1. A proper URL sitting anywhere in the pasted text.
  const withScheme = text.match(/\bhttps?:\/\/[^\s<>"'`]+/i);
  let candidate = withScheme ? withScheme[0] : null;

  // 2. Some other scheme (ftp://, file://, ...) — say so instead of
  //    "helpfully" rewriting it into an https link.
  if (!candidate) {
    const otherScheme = text.match(/\b([a-z][a-z0-9+.-]*):\/\//i);
    if (otherScheme) {
      throw new ResolveError('Only http and https links can be resolved.', 'BAD_SCHEME');
    }
  }

  // 3. Otherwise a bare domain like "vplink.in/snB67M".
  if (!candidate) {
    const bare = text.match(
      /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s<>"'`]*)?)/i
    );
    if (bare) candidate = 'https://' + bare[1];
  }

  if (!candidate) {
    throw new ResolveError("That doesn't look like a link.", 'INVALID_INPUT');
  }

  // Pasting usually grabs trailing punctuation: "(...)", "...", ")".
  candidate = candidate.replace(/[)\].,;:!?'"]+$/g, '');

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new ResolveError("That doesn't look like a link.", 'INVALID_INPUT');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ResolveError('Only http and https links can be resolved.', 'BAD_SCHEME');
  }
  if (!url.hostname) {
    throw new ResolveError("That link doesn't have a host.", 'INVALID_INPUT');
  }

  return url.toString();
}

class ResolveError extends Error {
  constructor(message, code = 'RESOLVE_FAILED') {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * SSRF guard — don't let the server be pointed at its own network
 * ------------------------------------------------------------------ */

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80')) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // unique local
    // IPv4-mapped ::ffff:127.0.0.1
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    h === 'metadata.google.internal'
  );
}

async function assertPublicHost(url, options) {
  if (options.allowPrivateHosts) return;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isPrivateHostname(hostname)) {
    throw new ResolveError('Refusing to resolve a local/private address.', 'PRIVATE_HOST');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new ResolveError('Refusing to resolve a local/private address.', 'PRIVATE_HOST');
    }
    return;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ResolveError(`Couldn't find the domain "${hostname}".`, 'DNS_FAILED');
  }

  if (!records.length) {
    throw new ResolveError(`Couldn't find the domain "${hostname}".`, 'DNS_FAILED');
  }
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new ResolveError('That domain points at a local/private address.', 'PRIVATE_HOST');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

async function readCapped(res, cap) {
  const buf = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > cap) {
        buf.push(chunk.subarray(0, chunk.length - (size - cap)));
        break;
      }
      buf.push(chunk);
    }
  } catch {
    /* body truncated / connection reset — keep what we have */
  }
  return Buffer.concat(buf).toString('utf8');
}

async function fetchHop(url, options, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ResolveError('Timed out following the redirect chain.', 'TIMEOUT');
  }

  const signal = AbortSignal.timeout(Math.min(options.perHopTimeoutMs, remaining));

  let res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,hi;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ResolveError('The site took too long to respond.', 'TIMEOUT');
    }
    const cause = err && err.cause ? err.cause.code || err.cause.message : '';
    throw new ResolveError(
      cause ? `Couldn't reach the site (${cause}).` : "Couldn't reach the site.",
      'FETCH_FAILED'
    );
  }

  const headers = res.headers;
  const contentType = (headers.get('content-type') || '').toLowerCase();

  if (res.status >= 300 && res.status < 400) {
    const location = headers.get('location');
    if (res.body) await res.body.cancel().catch(() => {});
    return { status: res.status, contentType, location, body: null, headers };
  }

  const looksTextual =
    !contentType ||
    contentType.includes('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('javascript');

  let body = '';
  let truncated = false;
  if (looksTextual && res.body) {
    body = await readCapped(res, options.maxBodyBytes);
    truncated = body.length >= options.maxBodyBytes;
    await res.body.cancel().catch(() => {});
  } else if (res.body) {
    await res.body.cancel().catch(() => {});
  }

  return { status: res.status, contentType, location: null, body, headers, truncated };
}

/* ------------------------------------------------------------------ *
 * Page inspection
 * ------------------------------------------------------------------ */

/** Parse the attributes of a single HTML tag: `k="v"`, `k='v'` or bare `k=v`. */
function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;
  for (const m of tag.matchAll(re)) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[m[1].toLowerCase()] = value;
  }
  return attrs;
}

/**
 * Read every <meta http-equiv="refresh"> in the document and return the
 * URLs it points at. Attribute-aware, so mixed quoting like
 * content="0;URL='/best'" works.
 */
function metaRefreshTargets(body) {
  const targets = [];
  for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(m[0]);
    const equiv = (attrs['http-equiv'] || '').toLowerCase().trim();
    if (equiv !== 'refresh') continue;
    const content = attrs.content || '';
    const inner = content.match(/url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i);
    const target = inner ? inner[1] ?? inner[2] ?? inner[3] : '';
    if (target && target.trim()) targets.push(target.trim());
  }
  return targets;
}

function cleanCandidate(value, baseUrl) {
  if (!value) return null;
  let v = String(value)
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\x2[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/&amp;/g, '&')
    .trim();

  if (!v || v === '#' || /^(javascript|mailto|tel|data|about):/i.test(v)) return null;

  try {
    const abs = new URL(v, baseUrl);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    return abs.toString();
  } catch {
    return null;
  }
}

/**
 * Find places the page asks the browser to go next.
 * Returns [{ url, kind, confidence }] strongest first.
 */
function extractRedirects(body, baseUrl) {
  const found = [];
  const push = (url, kind, confidence) => {
    const clean = cleanCandidate(url, baseUrl);
    if (!clean) return;
    if (clean === baseUrl) return; // self-refresh, ignore
    if (found.some((f) => f.url === clean)) return;
    found.push({ url: clean, kind, confidence });
  };

  // <meta http-equiv="refresh" content="0; url=...">
  for (const target of metaRefreshTargets(body)) {
    push(target, 'meta-refresh', 95);
  }

  // location.replace("...") / location.assign("...")
  const replaceRe = /(?:window\.|document\.|top\.|self\.|parent\.)?location\s*\.\s*(?:replace|assign)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gi;
  for (const m of body.matchAll(replaceRe)) push(m[1], 'js-redirect', 90);

  // location.href = "..." / window.location = "..."
  const assignRe =
    /(?:window\.|document\.|top\.|self\.|parent\.)?location(?:\s*\.\s*href)?\s*=\s*["'`]([^"'`]+)["'`]/gi;
  for (const m of body.matchAll(assignRe)) push(m[1], 'js-redirect', 85);

  // Base64 destinations: atob("aHR0cHM6...") or dest = "aHR0cHM6..."
  const b64Re =
    /(?:atob\s*\(\s*["'`]([A-Za-z0-9+/=_-]{16,})["'`]\s*\)|(?:var|let|const)\s+[\w$]*(?:url|link|dest|target|final)[\w$]*\s*=\s*["'`]([A-Za-z0-9+/=_-]{16,})["'`])/gi;
  for (const m of body.matchAll(b64Re)) {
    const raw = m[1] || m[2];
    if (!raw) continue;
    try {
      const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
        .toString('utf8')
        .trim();
      // Absolute URL, or a rooted path like "/go/abc123".
      if (/^https?:\/\/\S+$/i.test(text) || /^\/[^\s"'`<>]*$/.test(text)) {
        push(text, 'base64', 80);
      }
    } catch {
      /* not base64 */
    }
  }

  // JSON APIs: {"url":"https://..."} / {"link": ...} / {"redirect": ...}
  const jsonRe = /["'](?:url|link|redirect|redirect_url|destination|target|final_url)["']\s*:\s*["']([^"']+)["']/gi;
  for (const m of body.matchAll(jsonRe)) {
    if (/^https?:\/\//i.test(m[1])) push(m[1], 'json-field', 70);
  }

  // Absolute URLs assigned to a variable named url/href near the top of a script.
  const genericRe = /(?:var|let|const)\s+(?:url|link|href|target)\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]/gi;
  for (const m of body.matchAll(genericRe)) push(m[1], 'js-variable', 60);

  return found.sort((a, b) => b.confidence - a.confidence);
}

/** Every external link on the page — offered to the user, never auto-followed. */
function extractAnchors(body, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const clean = cleanCandidate(m[1], baseUrl);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    let label = '';
    const tag = m[0];
    const after = body.slice(m.index + tag.length, m.index + tag.length + 400);
    const text = after.match(/^([^<]{2,80})</);
    if (text) label = text[1].trim().replace(/\s+/g, ' ');
    let host = '';
    try {
      host = new URL(clean).hostname.replace(/^www\./, '');
    } catch {}
    out.push({ url: clean, label, host });
  }
  return out;
}

const BLOCK_SIGNATURES = [
  {
    code: 'cloudflare',
    label: 'Cloudflare bot check',
    re: /cf-browser-verification|challenge-platform|cf_chl_opt|__cf_chl|Just a moment\.\.\.|Attention Required! \| Cloudflare|Verify you are human/i,
  },
  {
    code: 'captcha',
    label: 'Captcha / human verification',
    re: /g-recaptcha|hcaptcha\.com|h-captcha|cf-turnstile|recaptcha\/api\.js/i,
  },
  {
    code: 'turnstile',
    label: 'Interactive verification page',
    re: /please (?:verify|complete the (?:check|verification))|complete the security check|enable javascript and cookies to continue/i,
  },
];

function detectBlock(body, res) {
  if (!body) return null;
  for (const sig of BLOCK_SIGNATURES) {
    if (sig.re.test(body)) {
      return { code: sig.code, label: sig.label };
    }
  }
  const server = (res.headers.get('server') || '').toLowerCase();
  if ((res.status === 403 || res.status === 503) && server.includes('cloudflare')) {
    return { code: 'cloudflare', label: 'Blocked by Cloudflare' };
  }
  return null;
}

function extractTitle(html) {
  if (!html) return '';
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (!m) return '';
  return m[1]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .slice(0, 160);
}

/** Destinations hidden inside the link's own query params (?url=, ?r=, base64...). */
function embeddedCandidates(urlString) {
  const out = [];
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return out;
  }
  for (const [key, value] of url.searchParams) {
    if (!value) continue;
    const decoded = (() => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    })();

    if (/^https?:\/\//i.test(decoded)) {
      out.push({ url: decoded, from: key, how: 'plain' });
      continue;
    }
    // base64 / base64url
    if (/^[A-Za-z0-9+/_=-]{16,}$/.test(decoded)) {
      try {
        const b64 = decoded.replace(/-/g, '+').replace(/_/g, '/');
        const text = Buffer.from(b64, 'base64').toString('utf8').trim();
        if (/^https?:\/\//i.test(text)) {
          out.push({ url: text, from: key, how: 'base64' });
        }
      } catch {
        /* not base64 */
      }
    }
  }
  return out.map((c) => ({ ...c, url: cleanCandidate(c.url, urlString) })).filter((c) => c.url);
}

/* ------------------------------------------------------------------ *
 * Main entry point
 * ------------------------------------------------------------------ */

async function resolve(rawInput, userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  const startedAt = Date.now();
  const deadline = startedAt + options.totalTimeoutMs;
  const hops = [];
  const warnings = [];

  const entryUrl = parseInput(rawInput);
  let current = entryUrl;
  let finalPage = null;
  let blocked = null;

  for (let hop = 0; hop < options.maxHops; hop++) {
    let url;
    try {
      url = new URL(current);
    } catch {
      throw new ResolveError('Ran into a malformed URL in the chain.', 'BAD_CHAIN');
    }

    await assertPublicHost(url, options);

    const res = await fetchHop(current, options, deadline);
    const title = res.body ? extractTitle(res.body) : '';

    // --- HTTP redirect -------------------------------------------------
    if (res.location) {
      const next = cleanCandidate(res.location, current);
      hops.push({
        url: current,
        host: url.hostname,
        status: res.status,
        kind: 'http-redirect',
        note: `HTTP ${res.status}`,
        next,
      });
      if (!next) {
        warnings.push('The server sent a redirect to a location that could not be followed.');
        finalPage = { url: current, status: res.status, contentType: res.contentType, title };
        break;
      }
      current = next;
      continue;
    }

    // --- HTML / JS redirect --------------------------------------------
    const isHtml =
      res.contentType.includes('html') || res.contentType.includes('xhtml');

    if (isHtml && res.body) {
      const gate = detectBlock(res.body, res);
      if (gate) {
        blocked = {
          ...gate,
          message:
            'This page is an interactive verification gate (the "click to continue" / "verify you are human" step). ' +
            'It only opens for a real browser session, so it cannot be resolved automatically — and faking that check is not something this tool does.',
        };
        warnings.push(`${gate.label} reached — the destination is behind human verification.`);
      }

      const redirects = extractRedirects(res.body, current);
      if (redirects.length) {
        const best = redirects[0];
        hops.push({
          url: current,
          host: url.hostname,
          status: res.status,
          kind: best.kind,
          note:
            best.kind === 'meta-refresh'
              ? 'Meta refresh'
              : best.kind === 'json-field'
              ? 'Destination in JSON'
              : 'JavaScript redirect',
          next: best.url,
        });
        current = best.url;
        continue;
      }
    }

    // --- JSON / plain text that is just a URL --------------------------
    if (!isHtml && res.body) {
      const trimmed = res.body.trim();
      if (/^https?:\/\/\S+$/i.test(trimmed)) {
        const next = cleanCandidate(trimmed, current);
        if (next && next !== current) {
          hops.push({
            url: current,
            host: url.hostname,
            status: res.status,
            kind: 'text-url',
            note: 'Plain-text URL',
            next,
          });
          current = next;
          continue;
        }
      }
    }

    // --- We've landed ------------------------------------------------
    const anchors = isHtml && res.body ? extractAnchors(res.body, current) : [];
    finalPage = {
      url: current,
      status: res.status,
      contentType: res.contentType,
      title,
      truncated: Boolean(res.truncated),
      anchors,
    };
    break;
  }

  // Ran out of hops without landing anywhere.
  if (!finalPage) {
    const lastUrl = hops.length ? hops[hops.length - 1].url : entryUrl;
    finalPage = { url: lastUrl, status: null, contentType: '', title: '', anchors: [] };
    warnings.push(`Stopped after ${options.maxHops} redirects — the chain may loop or be very long.`);
  }

  // If the entry link literally carries a destination, surface it.
  const embedded = embeddedCandidates(entryUrl);
  if (embedded.length && embedded[0].url !== finalPage.url) {
    for (const e of embedded) {
      if (e.url === finalPage.url) continue;
      warnings.push(`The link itself carries a destination in ?${e.from}= (${e.how}).`);
    }
  }

  let host = '';
  try {
    host = new URL(finalPage.url).hostname.replace(/^www\./, '');
  } catch {}

  const fileType = describeContentType(finalPage.contentType, finalPage.url);

  return {
    ok: true,
    input: rawInput.trim(),
    entryUrl,
    finalUrl: finalPage.url,
    finalHost: host,
    finalStatus: finalPage.status,
    finalTitle: finalPage.title || '',
    finalContentType: finalPage.contentType || '',
    finalFileType: fileType,
    hops,
    hopCount: hops.length,
    blocked,
    warnings: [...new Set(warnings)],
    anchors: (finalPage.anchors || []).slice(0, 12),
    embedded,
    elapsedMs: Date.now() - startedAt,
  };
}

function describeContentType(contentType, url) {
  const ct = (contentType || '').split(';')[0].trim();
  if (ct.includes('pdf')) return 'PDF document';
  if (ct.includes('zip') || ct.includes('compressed') || ct.includes('x-rar')) return 'Archive';
  if (ct.includes('msword') || ct.includes('officedocument')) return 'Document';
  if (ct.includes('json')) return 'JSON';
  if (ct.includes('html')) return 'Web page';
  if (ct.includes('image/')) return 'Image';
  if (ct.includes('video/')) return 'Video';
  if (ct.includes('octet-stream')) {
    const ext = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    return ext ? `.${ext.toLowerCase()} file` : 'Binary file';
  }
  return ct || 'Unknown';
}

module.exports = {
  resolve,
  parseInput,
  extractRedirects,
  extractAnchors,
  embeddedCandidates,
  isPrivateIp,
  ResolveError,
  DEFAULTS,
};
