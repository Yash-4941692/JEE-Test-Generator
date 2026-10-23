'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyse, inferTopicsFromCues, normaliseLabel, similarLabels } = require('../src/topics');
const { runSample, loadFixture, pageFromFixture } = require('../src/demo');
const { metrics } = require('../scripts/evaluate');
const { YouTubeError } = require('../src/youtube');

const cue = (startMs, text, durationMs = 4000) => ({
  startMs,
  endMs: startMs + durationMs,
  text,
});

/* ------------------------------------------------------------------ *
 * Tier contract
 * ------------------------------------------------------------------ */

test('verified tier: chapter timestamps are passed through untouched', async () => {
  const { fixture } = await loadFixture('verified');
  const report = await runSample('verified');

  assert.equal(report.accuracy.tier, 'verified');
  assert.equal(report.accuracy.method, 'youtube-chapters');
  assert.equal(report.topics.length, fixture.chapters.length);

  report.topics.forEach((topic, i) => {
    assert.equal(topic.startMs, fixture.chapters[i].startMs, 'timestamp must be exact');
    assert.equal(topic.label, fixture.chapters[i].label);
    assert.equal(topic.tier, 'verified');
    assert.equal(topic.confidence, 1);
  });
  assert.deepEqual(report.warnings, []);
});

test('verified tier: every reported time is a real chapter time', async () => {
  const { fixture } = await loadFixture('verified');
  const report = await runSample('verified');
  const validTimes = new Set(fixture.chapters.map((c) => c.startMs));
  for (const topic of report.topics) {
    assert.ok(validTimes.has(topic.startMs), `${topic.startMs} is not a chapter time`);
  }
});

test('inferred tier is labelled and explained, never presented as exact', async () => {
  const report = await runSample('inferred');

  assert.equal(report.accuracy.tier, 'inferred');
  assert.equal(report.accuracy.method, 'transcript-cue');
  assert.match(report.accuracy.statement, /approximate/i);

  for (const topic of report.topics) {
    assert.equal(topic.tier, 'inferred');
    assert.ok(topic.confidence > 0 && topic.confidence < 1, 'inferred topics carry a real confidence');
    assert.ok(topic.evidence.length > 0, 'every inferred topic shows the sentence it came from');
    assert.ok(topic.startMs >= 0);
  }

  assert.ok(
    report.warnings.some((w) => /no chapters|approximate/i.test(w)),
    'the user must be told the boundaries are approximate'
  );
});

test('no sources means no timestamps at all', async () => {
  const fixture = {
    id: 'fixtureNone',
    meta: {
      title: 'Silent Video',
      channel: 'Nobody',
      lengthSeconds: 300,
      description: 'No chapters in this description at all.',
    },
    chapters: [],
    captionTrack: null,
    captionsJson3: null,
  };

  const report = await analyse('fixtureNone', {
    fetchWatchPage: async () => ({
      html: '',
      playerResponse: {
        playabilityStatus: { status: 'OK' },
        videoDetails: {
          videoId: fixture.id,
          title: fixture.meta.title,
          author: fixture.meta.channel,
          lengthSeconds: '300',
          shortDescription: fixture.meta.description,
        },
      },
      initialData: null,
    }),
    fetchCaptionTrack: async () => '',
  });

  assert.equal(report.accuracy.tier, 'none');
  assert.deepEqual(report.topics, [], 'must not invent topics');
  assert.equal(report.topicCount, 0);
  assert.ok(report.warnings.some((w) => /no chapters and no captions/i.test(w)));
});

test('description-only chapters count as verified, with a warning when unusual', async () => {
  const description = '0:30 First topic\n2:00 Second topic\n4:00 Third topic';
  const report = await analyse('fixtureDes1', {
    fetchWatchPage: async () => ({
      html: '',
      playerResponse: {
        playabilityStatus: { status: 'OK' },
        videoDetails: {
          videoId: 'fixtureDes1',
          title: 'T',
          author: 'A',
          lengthSeconds: '600',
          shortDescription: description,
        },
      },
      initialData: null,
    }),
    fetchCaptionTrack: async () => '',
  });

  assert.equal(report.accuracy.tier, 'verified');
  assert.equal(report.accuracy.method, 'description-timestamps');
  assert.deepEqual(report.topics.map((t) => t.startMs), [30000, 120000, 240000]);
  assert.ok(report.warnings.some((w) => /description/i.test(w)));
});

test('unplayable videos raise a specific, honest error', async () => {
  for (const status of ['LOGIN_REQUIRED', 'AGE_VERIFICATION_REQUIRED', 'PRIVATE']) {
    await assert.rejects(
      () =>
        analyse('fixtureBad1', {
          fetchWatchPage: async () => ({
            html: '',
            playerResponse: { playabilityStatus: { status, reason: { simpleText: 'nope' } } },
            initialData: null,
          }),
        }),
      (err) => {
        assert.ok(err instanceof YouTubeError);
        assert.equal(err.code, 'VIDEO_UNAVAILABLE');
        return true;
      }
    );
  }
});

/* ------------------------------------------------------------------ *
 * Detector behaviour
 * ------------------------------------------------------------------ */

test('detects transitions and uses the cue start, not the block start', () => {
  const topics = inferTopicsFromCues([
    cue(0, 'ok so in this lecture we will cover friction'),
    cue(20000, 'now let us look at static friction'),
    cue(30000, 'static friction opposes the applied force'),
    cue(60000, 'moving on to kinetic friction'),
  ]);

  assert.deepEqual(topics.map((t) => t.startMs), [0, 20000, 60000]);
  assert.equal(topics[0].label, 'Introduction');
  assert.equal(topics[1].label, 'Static friction');
  assert.equal(topics[2].label, 'Kinetic friction');
});

test('ignores back-references mid-sentence', () => {
  const topics = inferTopicsFromCues([
    cue(0, 'friction has two kinds'),
    cue(10000, 'as we discussed earlier when we looked at heat engines this matters'),
    cue(20000, 'so now let us move on to tension'),
  ]);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].startMs, 20000);
});

test('joins a transition split across caption cues', () => {
  const topics = inferTopicsFromCues([
    cue(0, 'so now let'),
    cue(900, 's move on to'),
    cue(1800, 'projectile motion'),
  ]);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].startMs, 0, 'timestamp is the first cue of the sentence');
  assert.equal(topics[0].label, 'Projectile motion');
});

test('does not emit a topic for a bare transition with no subject', () => {
  const topics = inferTopicsFromCues([cue(0, 'ok so now let us move on')]);
  assert.deepEqual(topics, []);
});

test('collapse near-duplicate topics close together', () => {
  const topics = inferTopicsFromCues([
    cue(0, 'now let us look at friction'),
    cue(5000, 'now let us look at friction'),
    cue(40000, 'next topic is tension'),
  ]);
  assert.equal(topics.length, 2);
});

test('ambient captions without cues produce nothing', () => {
  const topics = inferTopicsFromCues([
    cue(0, 'this is a normal sentence without any transition phrase'),
    cue(10000, 'another normal sentence that just keeps going'),
  ]);
  assert.deepEqual(topics, []);
});

test('similarLabels compares meaningfully', () => {
  assert.ok(similarLabels('Angular velocity', 'angular velocities') >= 0.5);
  assert.ok(similarLabels('Entropy', 'Friction') < 0.5);
});

test('normaliseLabel trims a spoken sentence into a topic name', () => {
  assert.equal(normaliseLabel('entropy is a measure of the disorder'), 'Entropy');
  assert.equal(normaliseLabel('heat engines a heat engine takes heat'), 'Heat engines');
  assert.equal(normaliseLabel('the second law of thermodynamics the second law'), 'Second law of thermodynamics');
  assert.equal(normaliseLabel('refrigerators and heat pumps a refrigerator is'), 'Refrigerators and heat pumps');
  assert.equal(normaliseLabel('a quick revision remember entropy increases'), 'Quick revision');
  assert.equal(normaliseLabel('question'), '', 'a bare structural word names nothing');
  assert.equal(normaliseLabel(''), '');
});

/* ------------------------------------------------------------------ *
 * Measured accuracy on the labelled fixture
 * ------------------------------------------------------------------ */

test('detector meets its accuracy floor on the labelled fixture', async () => {
  const { fixture } = await loadFixture('inferred');
  const report = await runSample('inferred');
  const m = metrics(report.topics, fixture.groundTruth);

  assert.equal(m.recall, 1, `missed topics: ${m.missed.map((x) => x.label).join(', ')}`);
  assert.ok(m.precision >= 0.9, `precision was ${m.precision}`);
  assert.equal(m.maxErrorMs, 0, 'timestamps must land on the exact cue');
  assert.ok(m.labelMatches >= m.hits * 0.9, 'topic names should match the labelled ones');
});

test('analysis is deterministic — same input, same output', async () => {
  const a = await runSample('inferred');
  const b = await runSample('inferred');
  assert.deepEqual(
    a.topics.map((t) => [t.startMs, t.label]),
    b.topics.map((t) => [t.startMs, t.label])
  );
});

test('captions are not used for timing once chapters exist', async () => {
  const report = await runSample('verified');
  const { fixture } = await loadFixture('verified');

  assert.ok(report.sources.captions.available, 'captions were available');
  const chapterTimes = new Set(fixture.chapters.map((c) => c.startMs));
  for (const topic of report.topics) {
    assert.ok(chapterTimes.has(topic.startMs));
    assert.equal(topic.method, 'youtube-chapters');
  }
});

test('report carries the metadata the UI needs', async () => {
  const report = await runSample('verified');
  assert.equal(report.video.id, 'fixtureVer1');
  assert.match(report.video.url, /^https:\/\/www\.youtube\.com\/watch\?v=fixtureVer1$/);
  assert.equal(report.video.durationLabel, '27:05');
  assert.match(report.video.thumbnail, /i\.ytimg\.com/);
  assert.equal(typeof report.elapsedMs, 'number');
  assert.ok(report.sources.youtubeChapters.count === 10);
});
