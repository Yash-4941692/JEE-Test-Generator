'use strict';

/**
 * Description parsing.
 *
 * Two jobs:
 *  1. Pull YouTube chapters out of the description. YouTube's own convention is
 *     a list of lines starting with a timestamp, the first at 0:00, at least
 *     three of them, ascending. Those chapters appear on the watch page *and*
 *     are what this app treats as the most authoritative topic source.
 *  2. Pull useful metadata: links, timestamps mentioned in prose, and whether
 *     the description looks like a JEE-style "topics covered" list.
 */

const { cleanText } = require('./util');

// 0:00 / 00:00 / 1:02:03 / 1:02 / 00:00:00 — with optional surrounding junk.
const STAMP_LINE =
  /^[\s\-–—•*·|]*(\d{1,2}(?::\d{2}){1,2})\s*(?:[-–—:|•·]|\s{2,}|\s+(?=\S))\s*(.*)$/;

/** "1:02:03" | "4:12" | "01:02" -> seconds (null when unparseable). */
function stampToSeconds(stamp) {
  const text = String(stamp ?? '').trim();
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length > 3) return null;

  // Seconds are always 0-59; minutes/seconds of an h:mm:ss are too.
  const secondsPart = parts[parts.length - 1];
  if (secondsPart > 59) return null;
  if (parts.length === 3 && parts[1] > 59) return null;

  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Find chapter lines in a description.
 * Returns { chapters, confidence, reason } where confidence reflects how
 * strongly the list follows YouTube's chapter convention.
 */
function parseDescriptionChapters(description) {
  const chapters = [];
  const lines = String(description || '').replace(/\r\n?/g, '\n').split('\n');

  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.length > 400) continue;

    const m = raw.match(STAMP_LINE);
    if (!m) continue;

    const seconds = stampToSeconds(m[1]);
    if (seconds == null) continue;

    let label = cleanText(m[2] || '');
    // Strip decorations like "▶", emoji bullets or pipes around the label.
    label = label.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N})]+$/u, '').trim();

    chapters.push({ startMs: seconds * 1000, label, source: 'description' });
  }

  // De-duplicate identical starts (description templates often repeat a line).
  const seen = new Set();
  const unique = chapters.filter((c) => {
    const key = c.startMs;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Must be ascending to count as a real list.
  let ascending = true;
  for (let i = 1; i < unique.length; i++) {
    if (unique[i].startMs <= unique[i - 1].startMs) {
      ascending = false;
      break;
    }
  }

  // Only label-less stamps are not useful chapters.
  const labelled = unique.filter((c) => c.label.length > 0);

  let confidence = 0;
  let reason = '';

  if (labelled.length === 0) {
    confidence = 0;
    reason = 'no timestamped lines with labels';
  } else if (labelled.length >= 3 && ascending && labelled[0].startMs === 0) {
    confidence = 1;
    reason = `YouTube chapter list (${labelled.length} chapters from 0:00, ascending)`;
  } else if (labelled.length >= 2 && ascending) {
    confidence = 0.75;
    reason = `timestamped list without the 0:00 rule (${labelled.length} entries)`;
  } else {
    confidence = 0.4;
    reason = 'timestamps present but not a clean ascending list';
  }

  return {
    chapters: labelled.length ? labelled : unique,
    confidence,
    ascending,
    reason,
  };
}

/**
 * Does this description read like a chapter list for a study/lecture video?
 * Used only to adjust wording, never to invent timestamps.
 */
function looksLikeLectureList(chapters) {
  if (!chapters || chapters.length < 3) return false;
  const keywords = /theory|concept|problem|example|question|solution|pyq|practice|revision|exercise|topic|introduction|summary|doubt/i;
  const hits = chapters.filter((c) => keywords.test(c.label)).length;
  return hits / chapters.length >= 0.3;
}

/** Pull http(s) links out of the description; skips YouTube's own nav links. */
function extractLinks(description) {
  const out = [];
  const seen = new Set();
  for (const m of String(description || '').matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (host === 'youtube.com' || host === 'youtu.be') continue;
      out.push({ url, host });
    } catch {
      /* ignore malformed */
    }
  }
  return out.slice(0, 15);
}

/** Prose mentions of a timestamp ("...starts at 4:12...") — evidence, not chapters. */
function extractInlineStamps(description) {
  const out = [];
  for (const m of String(description || '').matchAll(/(?:^|\s|\(|\[)((?:\d{1,2}:)?\d{1,2}:\d{2})(?=\s|$|[),.;])/g)) {
    const seconds = stampToSeconds(m[1]);
    if (seconds != null) out.push({ startMs: seconds * 1000, stamp: m[1] });
  }
  return out.slice(0, 40);
}

module.exports = {
  stampToSeconds,
  parseDescriptionChapters,
  looksLikeLectureList,
  extractLinks,
  extractInlineStamps,
};
