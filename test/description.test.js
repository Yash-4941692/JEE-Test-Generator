'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stampToSeconds,
  parseDescriptionChapters,
  looksLikeLectureList,
  extractLinks,
  extractInlineStamps,
} = require('../src/description');

test('stampToSeconds parses m:ss and h:mm:ss', () => {
  assert.equal(stampToSeconds('0:00'), 0);
  assert.equal(stampToSeconds('1:15'), 75);
  assert.equal(stampToSeconds('27:05'), 1625);
  assert.equal(stampToSeconds('1:02:03'), 3723);
  assert.equal(stampToSeconds('10:00'), 600);
});

test('stampToSeconds rejects impossible times', () => {
  assert.equal(stampToSeconds('1:75'), null);
  assert.equal(stampToSeconds('1:2:3:4'), null);
  assert.equal(stampToSeconds('abc'), null);
  assert.equal(stampToSeconds(''), null);
});

test('parses a clean YouTube chapter list', () => {
  const description = `Circular Motion full revision.

0:00 Introduction
1:35 Angular displacement
4:18 Linear and angular speed
7:10 Centripetal acceleration

Notes: https://example.com/notes.pdf`;

  const result = parseDescriptionChapters(description);
  assert.equal(result.confidence, 1);
  assert.equal(result.ascending, true);
  assert.match(result.reason, /YouTube chapter list \(4 chapters/);
  assert.deepEqual(
    result.chapters.map((c) => [c.startMs, c.label]),
    [
      [0, 'Introduction'],
      [95000, 'Angular displacement'],
      [258000, 'Linear and angular speed'],
      [430000, 'Centripetal acceleration'],
    ]
  );
});

test('accepts dashes, bullets, pipes and colons as separators', () => {
  const description = [
    '0:00 - Intro',
    '1:00 – Angular velocity',
    '2:00 • Banking of roads',
    '3:00 | Vertical circles',
  ].join('\n');
  const { chapters, confidence } = parseDescriptionChapters(description);
  assert.equal(confidence, 1);
  assert.deepEqual(chapters.map((c) => c.label), [
    'Intro',
    'Angular velocity',
    'Banking of roads',
    'Vertical circles',
  ]);
});

test('a two-entry ascending list is usable but not full confidence', () => {
  const { chapters, confidence } = parseDescriptionChapters('0:00 Start\n5:30 End');
  assert.equal(chapters.length, 2);
  assert.equal(confidence, 0.75);
});

test('a list not starting at 0:00 loses full confidence', () => {
  const { confidence } = parseDescriptionChapters('0:30 A topic\n2:00 Another topic\n4:00 Third topic');
  assert.ok(confidence < 1, 'should not claim YouTube-chapter confidence');
  assert.equal(confidence, 0.75);
});

test('ignores timestamps without labels and non-list prose', () => {
  const { chapters, confidence } = parseDescriptionChapters('Watch from 1:00 to see it.\nNo list here.');
  assert.equal(confidence, 0, 'prose mentions are not chapters');
  assert.deepEqual(chapters, []);
});

test('detects shuffled lists and refuses to call them chapters', () => {
  const { confidence, ascending } = parseDescriptionChapters('5:00 Later\n1:00 Earlier\n9:00 Last');
  assert.equal(ascending, false);
  assert.ok(confidence <= 0.4);
});

test('de-duplicates repeated start times from templates', () => {
  const { chapters } = parseDescriptionChapters('0:00 Intro\n0:00 Intro\n1:00 Next\n2:00 Third');
  assert.equal(chapters.length, 3);
});

test('strips decoration from labels', () => {
  const { chapters } = parseDescriptionChapters('0:00 ▶ Intro to the course |\n1:00 — Next part');
  assert.equal(chapters[0].label, 'Intro to the course');
  assert.equal(chapters[1].label, 'Next part');
});

test('looksLikeLectureList spots study-style chapter names', () => {
  assert.equal(
    looksLikeLectureList([
      { label: 'Concept of friction' },
      { label: 'Solved problem 1' },
      { label: 'Practice questions' },
    ]),
    true
  );
  assert.equal(looksLikeLectureList([{ label: 'Intro' }, { label: 'Outro' }]), false);
  assert.equal(looksLikeLectureList([]), false);
});

test('extractLinks skips YouTube self-links and dedupes', () => {
  const links = extractLinks(`
    https://youtu.be/abc
    https://example.com/notes.pdf
    https://example.com/notes.pdf
    http://www.other-site.org/path?x=1
  `);
  assert.equal(links.length, 2);
  assert.equal(links[0].host, 'example.com');
  assert.equal(links[1].host, 'other-site.org');
});

test('extractInlineStamps finds prose timestamps as evidence only', () => {
  const stamps = extractInlineStamps('The derivation starts at 4:12 and ends near 9:30.');
  assert.deepEqual(stamps.map((s) => s.startMs), [252000, 570000]);
});
