'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectFormat,
  parseCaptions,
  parseJson3,
  parseTimedText,
  parseXmlCaptions,
  mergeProgressiveCues,
  toSentences,
  stripInlineTags,
} = require('../src/captions');

test('detectFormat sniffs each shape', () => {
  assert.equal(detectFormat('{"events":[]}'), 'json3');
  assert.equal(detectFormat('WEBVTT\n\n00:00.000 --> 00:02.000\nhi'), 'vtt');
  assert.equal(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nhi'), 'srt');
  assert.equal(detectFormat('<transcript><text start="0">hi</text></transcript>'), 'xml');
  assert.equal(detectFormat('just words'), 'unknown');
});

test('parses json3 cues with absolute times', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'hello' }] },
      { tStartMs: 95000, dDurationMs: 2500, segs: [{ utf8: 'angular ' }, { utf8: 'velocity' }] },
    ],
  });
  const cues = parseJson3(body);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 0);
  assert.equal(cues[1].startMs, 95000);
  assert.equal(cues[1].text, 'angular velocity');
  assert.equal(cues[1].endMs, 97500);
});

test('json3 honours segment-level offsets for a precise start', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 10000, dDurationMs: 4000, segs: [{ utf8: 'a', tOffsetMs: 0 }, { utf8: 'b', tOffsetMs: 1500 }] },
    ],
  });
  const cues = parseJson3(body);
  assert.equal(cues[0].startMs, 10000);
});

test('collapses rolling ASR events instead of duplicating text', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'so now' }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'so now lets' }] },
      { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'so now lets move on' }] },
    ],
  });
  const cues = parseJson3(body);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'so now lets move on');
  assert.equal(cues[0].startMs, 1000, 'keeps the earliest start of the rolling window');
});

test('parses WebVTT including settings and inline tags', () => {
  const body = `WEBVTT

00:00:01.000 --> 00:00:03.000 align:start position:0%
<v Speaker>First line</v>

00:01:15.500 --> 00:01:18.000
Second <c>line</c> here`;

  const cues = parseTimedText(body);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].text, 'First line');
  assert.equal(cues[1].startMs, 75500);
  assert.equal(cues[1].text, 'Second line here');
});

test('parses SRT with comma decimals', () => {
  const body = `1
00:00:01,000 --> 00:00:02,500
Hello there

2
00:01:02,250 --> 00:01:04,000
Second cue`;
  const cues = parseTimedText(body);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].startMs, 62250);
  assert.equal(cues[1].text, 'Second cue');
});

test('handles VTT timestamp tags and drops sound-effect-only cues', () => {
  const body = `WEBVTT

00:00:01.000 --> 00:00:02.000
<00:00:01.200><c>real words</c>

00:00:03.000 --> 00:00:04.000
[Music]`;
  const cues = parseTimedText(body);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'real words');
});

test('parses legacy XML captions', () => {
  const body = `<transcript>
    <text start="1.5" dur="2">First &amp; second</text>
    <text start="95" dur="3">Angular velocity</text>
  </transcript>`;
  const cues = parseXmlCaptions(body);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1500);
  assert.equal(cues[0].text, 'First & second');
  assert.equal(cues[1].startMs, 95000);
});

test('parseCaptions dispatches and flags untimed text', () => {
  const json = parseCaptions('{"events":[{"tStartMs":0,"segs":[{"utf8":"x"}]}]}');
  assert.equal(json.format, 'json3');
  assert.equal(json.untimed, false);

  const plain = parseCaptions('just some pasted words\nand more words');
  assert.equal(plain.format, 'text');
  assert.equal(plain.untimed, true, 'untimed text must be flagged so no times are invented');

  const empty = parseCaptions('');
  assert.equal(empty.format, 'empty');
  assert.deepEqual(empty.cues, []);
});

test('toSentences merges cues but keeps the true first start', () => {
  const cues = [
    { startMs: 1000, endMs: 2000, text: 'so let us look at' },
    { startMs: 2000, endMs: 3000, text: 'angular velocity.' },
    { startMs: 5000, endMs: 6000, text: 'It is a vector.' },
  ];
  const sentences = toSentences(cues);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].startMs, 1000);
  assert.equal(sentences[0].text, 'so let us look at angular velocity.');
  assert.equal(sentences[1].startMs, 5000);
});

test('toSentences splits on long pauses even without punctuation', () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: 'no punctuation here' },
    { startMs: 6000, endMs: 7000, text: 'a completely new thought' },
  ];
  const sentences = toSentences(cues, { maxGapMs: 2500 });
  assert.equal(sentences.length, 2, 'a 5s pause is a boundary');
  assert.equal(sentences[1].startMs, 6000);
});

test('mergeProgressiveCues ignores a re-announced shorter tail', () => {
  const cues = mergeProgressiveCues([
    { startMs: 0, endMs: 1000, text: 'one two three' },
    { startMs: 1000, endMs: 2000, text: 'three' },
  ]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'one two three');
});

test('stripInlineTags removes cue markup', () => {
  assert.equal(stripInlineTags('<c.colorE5E5E5>hi</c>'), 'hi');
  assert.equal(stripInlineTags('<00:00:01.000>later'), 'later');
});
