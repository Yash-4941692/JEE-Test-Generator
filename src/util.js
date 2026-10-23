'use strict';

/** Small shared helpers: text extraction from YouTube's deeply nested data,
 * time formatting, and safe number handling. */

/** Pull text out of YouTube's many shapes: string | {simpleText} | {runs:[{text}]} | {content}. */
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return '';

  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.runs)) return node.runs.map((r) => textOf(r) || '').join('');
  if (typeof node.text === 'string') return node.text;
  return '';
}

/** m:ss, or h:mm:ss past an hour. Never renders hours as "0:05:03" noise. */
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function formatTimeMs(ms) {
  // Floor, never round: a start time rounded up would point past the topic start.
  return formatTime(Math.floor((Number(ms) || 0) / 1000));
}

function toSeconds(ms) {
  return Math.max(0, Math.floor((Number(ms) || 0) / 1000));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Decode the handful of entities that show up in captions and titles. */
function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#(\d+);/g, (m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Collapse whitespace and strip zero-width / direction marks YouTube injects. */
function cleanText(str) {
  return decodeEntities(String(str || ''))
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  textOf,
  formatTime,
  formatTimeMs,
  toSeconds,
  clamp,
  decodeEntities,
  cleanText,
};
