'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { textOf, formatTime, formatTimeMs, toSeconds, cleanText, decodeEntities } = require('../src/util');

test('formatTime renders mm:ss and h:mm:ss', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9), '0:09');
  assert.equal(formatTime(75), '1:15');
  assert.equal(formatTime(599), '9:59');
  assert.equal(formatTime(600), '10:00');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTimeMs(95500), '1:35');
  assert.equal(formatTime(-5), '0:00', 'negative clamps to zero');
  assert.equal(formatTime('nope'), '0:00');
});

test('toSeconds floors milliseconds', () => {
  assert.equal(toSeconds(1999), 1);
  assert.equal(toSeconds(2000), 2);
  assert.equal(toSeconds(undefined), 0);
});

test('textOf reads every shape YouTube uses for text', () => {
  assert.equal(textOf('plain'), 'plain');
  assert.equal(textOf({ simpleText: 'simple' }), 'simple');
  assert.equal(textOf({ runs: [{ text: 'a' }, { text: 'b' }] }), 'ab');
  assert.equal(textOf([{ simpleText: 'x' }, 'y']), 'xy');
  assert.equal(textOf({ content: 'content' }), 'content');
  assert.equal(textOf(null), '');
  assert.equal(textOf({ unknown: 1 }), '');
});

test('decodeEntities handles numeric and named entities', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&quot;quoted&quot;'), '"quoted"');
  assert.equal(decodeEntities('&#39;'), "'");
  assert.equal(decodeEntities('&#x27;'), "'");
  assert.equal(decodeEntities('it&apos;s'), "it's");
});

test('cleanText strips zero-width junk and collapses whitespace', () => {
  assert.equal(cleanText('  hello\u200b   world  '), 'hello world');
  assert.equal(cleanText('\u202aformatted\u202c'), 'formatted');
  assert.equal(cleanText('line\n\n  break'), 'line break');
  assert.equal(cleanText(null), '');
});
