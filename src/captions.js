'use strict';

/**
 * Caption parsing. YouTube serves captions in several shapes depending on the
 * track and the fmt param; all of them are normalised here into a flat list of
 * cues: [{ startMs, endMs, text }].
 *
 * Auto-generated tracks (ASR) mark word/segment boundaries with inline timing
 * tags; those are honoured so a topic start is never rounded to the previous
 * caption block.
 */

const { cleanText, decodeEntities } = require('./util');

/* ------------------------------------------------------------------ *
 * Format sniffing
 * ------------------------------------------------------------------ */

function detectFormat(body, hint = '') {
  const head = String(body || '').slice(0, 400).trim();

  if (hint === 'json3' || head.startsWith('{')) return 'json3';
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (hint === 'srt' || /^\d+\s*\n\d{1,2}:\d{2}:\d{2}[.,]\d{3}/.test(head)) return 'srt';
  if (head.startsWith('<')) return 'xml';
  if (/\d{1,2}:\d{2}[.,]\d{3}\s*-->/.test(head)) return 'vtt';
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * json3
 * ------------------------------------------------------------------ */

function parseJson3(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }

  const events = Array.isArray(json.events) ? json.events : [];
  const cues = [];

  for (const event of events) {
    if (!event || !Array.isArray(event.segs)) continue;
    if (!Number.isFinite(event.tStartMs)) continue;

    const text = cleanText(event.segs.map((s) => s && s.utf8 ? s.utf8 : '').join(''));
    if (!text) continue;

    // Segment-level timing gives a precise start when YouTube provides it.
    const firstSeg = event.segs.find((s) => s && Number.isFinite(s.tOffsetMs));
    const startMs = event.tStartMs + (firstSeg ? Number(firstSeg.tOffsetMs) : 0);
    const durationMs = Number.isFinite(event.dDurationMs)
      ? Number(event.dDurationMs)
      : (() => {
          const last = [...event.segs].reverse().find((s) => s && Number.isFinite(s.tOffsetMs));
          return last ? Number(last.tOffsetMs) + 1000 : 2000;
        })();

    cues.push({
      startMs: Math.max(0, Math.round(startMs)),
      endMs: Math.max(0, Math.round(startMs + durationMs)),
      text,
    });
  }

  return mergeProgressiveCues(cues);
}

/**
 * ASR json3 tracks emit rolling events where each event repeats the previous
 * line and appends a few words. Left as-is, the transcript has massive
 * duplication. This collapses that pattern while keeping the earliest start
 * for each distinct piece of text.
 */
function mergeProgressiveCues(cues) {
  if (!cues.length) return cues;

  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...cue });
      continue;
    }

    if (cue.text === prev.text) {
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      continue;
    }

    if (cue.text.startsWith(prev.text) && cue.text.length > prev.text.length) {
      // Rolling window: keep the earliest start, extend the end, grow the text.
      prev.text = cue.text;
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      continue;
    }

    if (prev.text.endsWith(cue.text)) {
      // Same line re-announced with a shorter tail — ignore.
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      continue;
    }

    out.push({ ...cue });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * WebVTT / SRT
 * ------------------------------------------------------------------ */

const TIMESTAMP = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function toMs(hours, minutes, seconds, fraction) {
  const frac = Number((fraction + '00').slice(0, 3));
  return ((Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000) + frac;
}

/** Strip inline VTT/ASR markup: <00:00:01.234>, <c>, <c.colorE5E5E5>, </c>. */
function stripInlineTags(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .trim();
}

function parseTimedText(body) {
  const normalized = String(body || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\uFEFF/g, '');

  const lines = normalized.split('\n');
  const cues = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // A timing line may carry two stamps (start --> end), possibly with settings.
    if (line.includes('-->')) {
      const [startRaw, endRaw] = line.split('-->');
      const sm = startRaw.match(TIMESTAMP);
      const em = (endRaw || '').match(TIMESTAMP);
      if (sm) {
        const startMs = toMs(sm[1], sm[2], sm[3], sm[4]);
        const endMs = em ? toMs(em[1], em[2], em[3], em[4]) : startMs + 2000;

        // Collect the text until the next blank line / timing line.
        const textLines = [];
        let j = i + 1;
        while (j < lines.length && lines[j].trim() && !lines[j].includes('-->')) {
          textLines.push(lines[j]);
          j++;
        }

        const text = cleanText(
          stripInlineTags(textLines.join(' ')).replace(/^\[.*?\]$/, '').trim()
        );
        // Drop musical/sound-effect only cues that ASR emits.
        if (text && !/^[♪♫\s\[\]()]*$/.test(text)) {
          cues.push({ startMs, endMs: Math.max(endMs, startMs + 400), text });
        }
        i = j;
        continue;
      }
    }
    i++;
  }

  return mergeProgressiveCues(cues);
}

/* ------------------------------------------------------------------ *
 * XML (<transcript><text start= dur=>) — legacy YouTube format
 * ------------------------------------------------------------------ */

function parseXmlCaptions(body) {
  const cues = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (const m of String(body).matchAll(re)) {
    const attrs = m[1];
    const startMatch = attrs.match(/\bstart\s*=\s*["']([\d.]+)["']/i);
    const durMatch = attrs.match(/\bdur\s*=\s*["']([\d.]+)["']/i);
    if (!startMatch) continue;

    const startMs = Math.round(Number(startMatch[1]) * 1000);
    const durMs = durMatch ? Math.round(Number(durMatch[1]) * 1000) : 2000;
    const text = cleanText(stripInlineTags(decodeEntities(m[2])));
    if (!text) continue;

    cues.push({ startMs, endMs: startMs + Math.max(durMs, 400), text });
  }
  return mergeProgressiveCues(cues);
}

/** Plain transcript with no timings — cannot be used for exact timestamps. */
function parsePlainText(body) {
  const lines = String(body || '')
    .split(/\n+/)
    .map((l) => cleanText(l))
    .filter(Boolean);
  return lines.map((text, idx) => ({ startMs: idx * 1000, endMs: (idx + 1) * 1000, text, untimed: true }));
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Parse any caption payload into cues.
 * Returns { format, cues, untimed }.
 */
function parseCaptions(body, hint = '') {
  if (!body || !String(body).trim()) {
    return { format: 'empty', cues: [], untimed: false };
  }

  const format = detectFormat(body, hint);

  let cues = [];
  switch (format) {
    case 'json3':
      cues = parseJson3(body);
      break;
    case 'vtt':
    case 'srt':
      cues = parseTimedText(body);
      break;
    case 'xml':
      cues = parseXmlCaptions(body);
      break;
    default:
      cues = [];
  }

  // Last resort: plain text. Marked untimed so no timestamps get invented.
  if (!cues.length && format === 'unknown') {
    const plain = parsePlainText(body);
    if (plain.length) return { format: 'text', cues: plain, untimed: true };
  }

  return { format, cues, untimed: false };
}

/**
 * Merge cues into readable sentences with a start time each.
 * ASR splits mid-sentence, so this rebuilds sentence-ish units while keeping
 * the start of the first cue in each unit — which is the true start.
 */
function toSentences(cues, options = {}) {
  const maxGapMs = options.maxGapMs ?? 2500;
  const sentences = [];
  let current = null;

  const isSentenceEnd = (text) => /[.!?]["')\]]?$/.test(text.trim());

  for (const cue of cues) {
    if (!cue || cue.untimed) continue;
    const text = cue.text.trim();
    if (!text) continue;

    if (!current) {
      current = { startMs: cue.startMs, endMs: cue.endMs, text };
    } else {
      // A long silence means a new thought, punctuation or not — ASR often
      // produces no punctuation at all, so relying on it alone loses boundaries.
      if (cue.startMs - current.endMs > maxGapMs) {
        sentences.push(current);
        current = { startMs: cue.startMs, endMs: cue.endMs, text };
        continue;
      }
      current.text += ' ' + text;
      current.endMs = Math.max(current.endMs, cue.endMs);
    }

    // Close the unit when it ends a sentence or gets long enough to be readable.
    if (isSentenceEnd(current.text) || current.text.length >= 220) {
      sentences.push(current);
      current = null;
    }
  }

  if (current && current.text.trim()) sentences.push(current);
  return sentences;
}

module.exports = {
  detectFormat,
  parseCaptions,
  parseJson3,
  parseTimedText,
  parseXmlCaptions,
  mergeProgressiveCues,
  toSentences,
  stripInlineTags,
};
