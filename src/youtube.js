'use strict';

/**
 * YouTube access layer: URL parsing, watch-page fetching, and extraction of
 * the structured JSON YouTube embeds in the page (player response + initial
 * data), plus caption track fetching.
 *
 * Everything here is pure except fetchWatchPage/fetchCaptions, so the parsing
 * can be tested against captured fixtures with no network.
 */

const { textOf, cleanText } = require('./util');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

class YouTubeError extends Error {
  constructor(message, code = 'FETCH_FAILED', details = {}) {
    super(message);
    this.name = 'YouTubeError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ *
 * URL handling
 * ------------------------------------------------------------------ */

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Accepts a watch URL, short URL, shorts/embed/live URL, or a bare 11-char ID. */
function parseVideoId(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new YouTubeError('Paste a YouTube link first.', 'EMPTY_INPUT');
  }

  const raw = input.trim().replace(/^<|>$/g, '');

  // A bare video ID is a valid paste.
  if (VIDEO_ID_RE.test(raw)) return { id: raw, startAtMs: 0 };

  let withScheme = raw;
  if (!/^https?:\/\//i.test(withScheme)) withScheme = 'https://' + withScheme;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new YouTubeError("That doesn't look like a YouTube link.", 'INVALID_URL');
  }

  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) {
    throw new YouTubeError(
      'Only YouTube links are supported right now.',
      'NOT_YOUTUBE',
      { host }
    );
  }

  let id = '';
  const path = url.pathname.replace(/^\/+|\/+$/g, '');

  if (host.endsWith('youtu.be')) {
    id = path.split('/')[0];
  } else if (path === 'watch') {
    id = url.searchParams.get('v') || '';
  } else if (path.startsWith('shorts/') || path.startsWith('embed/') || path.startsWith('live/') || path.startsWith('v/')) {
    id = path.split('/')[1];
  } else if (url.searchParams.get('v')) {
    id = url.searchParams.get('v');
  }

  id = String(id || '').trim();
  if (!VIDEO_ID_RE.test(id)) {
    throw new YouTubeError(
      "Couldn't find a valid video ID in that link.",
      'INVALID_URL'
    );
  }

  // Preserve a ?t= offset so the UI can say "you pasted a link pointing at 4:12".
  let startAtMs = 0;
  const t = url.searchParams.get('t') || url.searchParams.get('start');
  if (t) {
    const m = String(t).match(/^(\d+)(?:s|h|m)?$/i);
    if (m) startAtMs = Number(m[1]) * 1000;
  }

  return { id, startAtMs };
}

/* ------------------------------------------------------------------ *
 * Extracting the JSON blobs YouTube inlines in the page
 * ------------------------------------------------------------------ */

/** Find `{...}` starting at/after `from`, respecting strings and escapes. */
function extractBalancedJson(text, from = 0) {
  const start = text.indexOf('{', from);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Pull a named global object out of the page HTML and parse it. */
function extractInitialJson(html, name) {
  if (!html) return null;

  const patterns = [
    new RegExp(`var\\s+${name}\\s*=\\s*`),
    new RegExp(`${name}\\s*=\\s*`),
    new RegExp(`window\\[["']${name}["']\\]\\s*=\\s*`),
  ];

  for (const re of patterns) {
    const m = re.exec(html);
    if (!m) continue;
    const json = extractBalancedJson(html, m.index + m[0].length);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      /* try the next pattern */
    }
  }
  return null;
}

/** Depth-first walk collecting every object that satisfies `predicate`. */
function findObjects(root, predicate, limit = 2000) {
  const out = [];
  const stack = [root];
  let visited = 0;

  while (stack.length && visited < 200000) {
    const node = stack.pop();
    visited += 1;
    if (!node || typeof node !== 'object') continue;

    if (predicate(node)) {
      out.push(node);
      if (out.length >= limit) break;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading what the page actually contains
 * ------------------------------------------------------------------ */

function readPlayability(playerResponse) {
  const status = playerResponse && playerResponse.playabilityStatus;
  if (!status) return { status: 'UNKNOWN', reason: '' };
  return {
    status: status.status || 'UNKNOWN',
    reason: cleanText(textOf(status.reason) || ''),
  };
}

function readVideoDetails(playerResponse, initialData) {
  const details = (playerResponse && playerResponse.videoDetails) || {};

  let title = details.title || '';
  let author = details.author || '';
  let lengthSeconds = Number(details.lengthSeconds) || 0;
  let description = details.shortDescription || '';

  // Fallbacks live in the initial data. Title and channel are looked up
  // independently — a page can have one without the other.
  if (!title) {
    const primary = findObjects(
      initialData,
      (o) => o.videoPrimaryInfoRenderer && o.videoPrimaryInfoRenderer.title
    )[0];
    if (primary) title = cleanText(textOf(primary.videoPrimaryInfoRenderer.title));
  }
  if (!author) {
    const owner = findObjects(
      initialData,
      (o) => o.videoOwnerRenderer && o.videoOwnerRenderer.title
    )[0];
    if (owner) author = cleanText(textOf(owner.videoOwnerRenderer.title));
  }

  if (!lengthSeconds) {
    const lengthText = findObjects(initialData, (o) => o.lengthText)[0];
    if (lengthText) {
      const parts = textOf(lengthText.lengthText).split(':').map(Number);
      if (parts.every((n) => Number.isFinite(n)) && parts.length >= 2) {
        lengthSeconds = parts.reduce((acc, n) => acc * 60 + n, 0);
      }
    }
  }

  if (!description) {
    const attributed = findObjects(
      initialData,
      (o) => o.attributedDescription && typeof o.attributedDescription.content === 'string'
    )[0];
    if (attributed) description = attributed.attributedDescription.content;
  }

  return {
    title: cleanText(title),
    channel: cleanText(author),
    lengthSeconds,
    description: String(description || ''),
    isLive: Boolean(details.isLiveContent),
    viewCount: Number(details.viewCount) || 0,
  };
}

/** Creator chapters, wherever YouTube put them in the player response. */
function readChapters(playerResponse, initialData) {
  const chapters = [];

  const fromPlayer = findObjects(
    playerResponse,
    (o) => o.chapterRenderer && o.chapterRenderer.timeRangeStartMillis != null
  );
  for (const wrap of fromPlayer) {
    const c = wrap.chapterRenderer;
    chapters.push({
      startMs: Number(c.timeRangeStartMillis) || 0,
      label: cleanText(textOf(c.title)),
      source: 'chapter',
    });
  }

  // The engagement panel version (also used for description chapters).
  const fromPanel = findObjects(initialData, (o) => {
    const m = o.macroMarkersListItemRenderer;
    return (
      m &&
      m.onTap &&
      m.onTap.watchEndpoint &&
      Number.isFinite(Number(m.onTap.watchEndpoint.startTimeSeconds))
    );
  });
  for (const wrap of fromPanel) {
    const m = wrap.macroMarkersListItemRenderer;
    chapters.push({
      startMs: Number(m.onTap.watchEndpoint.startTimeSeconds) * 1000,
      label: cleanText(textOf(m.title)),
      source: 'chapter',
    });
  }

  // Deterministic order regardless of where they were found in the JSON.
  return chapters.sort((a, b) => a.startMs - b.startMs);
}

/** Caption tracks the video exposes (manual or auto-generated). */
function readCaptionTracks(playerResponse) {
  const holder = findObjects(
    playerResponse,
    (o) => Array.isArray(o.captionTracks) && o.captionTracks.length > 0
  )[0];
  if (!holder) return [];

  return holder.captionTracks
    .filter((t) => t && typeof t.baseUrl === 'string')
    .map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode || '',
      name: cleanText(textOf(t.name)) || t.languageCode || '',
      kind: t.kind === 'asr' ? 'asr' : 'manual',
      vssId: t.vssId || '',
    }));
}

/** Pick the most useful track: manual English, then any manual, then English ASR, then anything. */
function pickCaptionTrack(tracks) {
  if (!tracks || !tracks.length) return null;

  const manual = tracks.filter((t) => t.kind === 'manual');
  const asr = tracks.filter((t) => t.kind === 'asr');

  return (
    manual.find((t) => t.languageCode.toLowerCase().startsWith('en')) ||
    manual[0] ||
    asr.find((t) => t.languageCode.toLowerCase().startsWith('en')) ||
    asr[0] ||
    null
  );
}

/* ------------------------------------------------------------------ *
 * Network
 * ------------------------------------------------------------------ */

async function readCapped(res, cap) {
  const parts = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > cap) {
      parts.push(chunk.subarray(0, chunk.length - (size - cap)));
      break;
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Fetch a watch page and return the parsed signals.
 * Throws YouTubeError with a specific code when the video can't be read.
 */
async function fetchWatchPage(id, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const url =
    `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` +
    `&hl=en&gl=US&has_verified=1&bpctr=9999999999`;

  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        'accept-language': 'en-US,en;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        // Skip the EU consent wall.
        cookie: 'CONSENT=YES+cb.20240101-00-p0.en+FX+410; SOCS=CAI',
      },
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new YouTubeError('YouTube took too long to respond.', 'TIMEOUT');
    }
    const code = err && err.cause ? err.cause.code : '';
    throw new YouTubeError(
      code ? `Couldn't reach YouTube (${code}).` : "Couldn't reach YouTube.",
      'FETCH_FAILED'
    );
  }

  if (res.status === 429) {
    throw new YouTubeError('YouTube is rate-limiting this server. Try again shortly.', 'UPSTREAM_RATE_LIMITED');
  }
  if (res.status === 404) {
    throw new YouTubeError('That video does not exist.', 'VIDEO_UNAVAILABLE');
  }
  if (!res.ok) {
    throw new YouTubeError(`YouTube returned HTTP ${res.status}.`, 'FETCH_FAILED');
  }

  const html = await readCapped(res, 8 * 1024 * 1024);

  const playerResponse = extractInitialJson(html, 'ytInitialPlayerResponse');
  const initialData = extractInitialJson(html, 'ytInitialData');

  if (!playerResponse && !initialData) {
    throw new YouTubeError(
      'Could not read the video data — YouTube may have served a consent or bot page. Try again, or run this from a normal network.',
      'PAGE_UNREADABLE'
    );
  }

  return { html, playerResponse, initialData };
}

/** Fetch a caption track as JSON3 (preferred) and return raw payload + type. */
async function fetchCaptionTrack(track, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const url = track.baseUrl.includes('fmt=')
    ? track.baseUrl
    : track.baseUrl + '&fmt=json3';

  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new YouTubeError('Timed out fetching captions.', 'CAPTIONS_TIMEOUT');
    }
    throw new YouTubeError("Couldn't fetch captions.", 'CAPTIONS_FAILED');
  }

  if (!res.ok) {
    throw new YouTubeError(
      `YouTube refused the caption request (HTTP ${res.status}).`,
      'CAPTIONS_FAILED'
    );
  }

  const body = await readCapped(res, 4 * 1024 * 1024);
  return body;
}

module.exports = {
  UA,
  YouTubeError,
  parseVideoId,
  extractBalancedJson,
  extractInitialJson,
  findObjects,
  readPlayability,
  readVideoDetails,
  readChapters,
  readCaptionTracks,
  pickCaptionTrack,
  fetchWatchPage,
  fetchCaptionTrack,
};
