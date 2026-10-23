'use strict';

/**
 * Offline samples.
 *
 * A hosted preview may have no outbound internet, and reviewers should still be
 * able to see both accuracy tiers work. These run the *real* pipeline — the
 * same chapter reading, caption parsing, sentence merging and cue detection —
 * against captured inputs, with the network layer swapped out.
 *
 * Nothing here fabricates an analysis: it feeds real-shaped data through real
 * code paths. Results are labelled as samples at the API edge.
 */

const fs = require('node:fs');
const path = require('node:path');
const { analyse } = require('./topics');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

const SAMPLES = {
  verified: {
    file: 'verified-example.json',
    name: 'Circular Motion (creator chapters)',
    blurb: 'A lecture whose creator wrote a chapter list — every timestamp is exact.',
  },
  inferred: {
    file: 'inferred-example.json',
    name: 'Second Law of Thermodynamics (no chapters)',
    blurb: 'No chapters at all, so topics are detected from the transcript and marked approximate.',
  },
};

function loadFixture(key) {
  const sample = SAMPLES[key];
  if (!sample) return null;

  const raw = fs.readFileSync(path.join(FIXTURE_DIR, sample.file), 'utf8');
  return { sample, fixture: JSON.parse(raw) };
}

/** Build the same shape fetchWatchPage returns, from a fixture. */
function pageFromFixture(fixture) {
  const playerResponse = {
    playabilityStatus: { status: 'OK' },
    videoDetails: {
      videoId: fixture.id,
      title: fixture.meta.title,
      author: fixture.meta.channel,
      lengthSeconds: String(fixture.meta.lengthSeconds),
      shortDescription: fixture.meta.description,
      isLiveContent: false,
      viewCount: '120000',
    },
    chapters: (fixture.chapters || []).map((c) => ({
      chapterRenderer: {
        timeRangeStartMillis: c.startMs,
        title: { simpleText: c.label },
      },
    })),
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://fixture.invalid/captions?fmt=json3',
            languageCode: fixture.captionTrack.languageCode,
            name: { simpleText: fixture.captionTrack.name },
            kind: fixture.captionTrack.kind,
          },
        ],
      },
    },
  };

  return { html: '', playerResponse, initialData: null };
}

async function runSample(key, options = {}) {
  const loaded = loadFixture(key);
  if (!loaded) return null;

  const { sample, fixture } = loaded;

  const report = await analyse(fixture.id, {
    ...options,
    fetchWatchPage: async () => pageFromFixture(fixture),
    fetchCaptionTrack: async () => JSON.stringify(fixture.captionsJson3),
  });

  return {
    ...report,
    sample: {
      key,
      name: sample.name,
      blurb: sample.blurb,
      note:
        'This is a stored sample, run through the same code as a live video. No network was used.',
      groundTruth: (fixture.groundTruth || []).map((g) => ({
        startMs: g.startMs,
        label: g.label,
      })),
    },
  };
}

function listSamples() {
  return Object.entries(SAMPLES).map(([key, s]) => ({ key, name: s.name, blurb: s.blurb }));
}

module.exports = { runSample, listSamples, SAMPLES, loadFixture, pageFromFixture };
