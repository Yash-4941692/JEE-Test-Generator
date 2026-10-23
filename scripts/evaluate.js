#!/usr/bin/env node
'use strict';

/**
 * Accuracy measurement.
 *
 * This is the honest answer to "how accurate is it?" — instead of a marketing
 * number, it compares the detector against hand-labelled topic starts on a
 * fixture transcript and prints precision, recall and timing error.
 *
 *   npm run evaluate
 *
 * The verified path is also checked here: chapter timestamps must come out
 * byte-identical to the source, because in that tier nothing is inferred.
 */

const { runSample, loadFixture } = require('../src/demo');
const { formatTimeMs } = require('../src/util');

// A detected topic counts as a correct hit if it starts within this window of
// the labelled topic. Caption lines are whole utterances, so 5s is generous
// for "the same topic"; 15s is the outer bound where a human would still agree.
const TIGHT_MS = 5000;
const LOOSE_MS = 15000;

function matchTopics(detected, truth, toleranceMs) {
  const used = new Set();
  const pairs = [];

  for (const t of truth) {
    let best = null;
    for (let i = 0; i < detected.length; i++) {
      if (used.has(i)) continue;
      const err = Math.abs(detected[i].startMs - t.startMs);
      if (err <= toleranceMs && (!best || err < best.err)) best = { i, err };
    }
    if (best) {
      used.add(best.i);
      pairs.push({ truth: t, detected: detected[best.i], err: best.err });
    }
  }

  const missed = truth.filter((t) => !pairs.some((p) => p.truth === t));
  const extra = detected.filter((d, i) => !used.has(i));
  return { pairs, missed, extra };
}

function labelMatch(a, b) {
  const norm = (s) =>
    new Set(
      s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
    );
  const sa = norm(a);
  const sb = norm(b);
  if (!sa.size || !sb.size) return false;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.min(sa.size, sb.size) >= 0.5;
}

function metrics(detected, truth) {
  const tight = matchTopics(detected, truth, TIGHT_MS);
  const loose = matchTopics(detected, truth, LOOSE_MS);

  const errors = loose.pairs.map((p) => p.err);
  const labelsOk = loose.pairs.filter((p) => labelMatch(p.detected.label, p.truth.label)).length;

  return {
    truth: truth.length,
    detected: detected.length,
    tightHits: tight.pairs.length,
    hits: loose.pairs.length,
    precision: detected.length ? loose.pairs.length / detected.length : 0,
    recall: truth.length ? loose.pairs.length / truth.length : 0,
    meanErrorMs: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0,
    maxErrorMs: errors.length ? Math.max(...errors) : 0,
    exactHits: errors.filter((e) => e === 0).length,
    labelMatches: labelsOk,
    pairs: loose.pairs,
    missed: loose.missed,
    extra: loose.extra,
  };
}

async function main() {
  const { fixture } = await loadFixture('inferred');
  const truth = fixture.groundTruth;

  const inferred = await runSample('inferred');
  const m = metrics(inferred.topics, truth);

  console.log('\n── Inferred tier: transcript cue detection ──────────────────────');
  console.log(`fixture          ${fixture.meta.title}`);
  console.log(`labelled topics  ${m.truth}`);
  console.log(`detected         ${m.detected}`);
  console.log(`hits (±15s)      ${m.hits}   (±5s: ${m.tightHits})`);
  console.log(`exact timestamps ${m.exactHits} of ${m.hits} (error 0s)`);
  console.log(`precision        ${(m.precision * 100).toFixed(1)}%`);
  console.log(`recall           ${(m.recall * 100).toFixed(1)}%`);
  console.log(`mean timing err  ${(m.meanErrorMs / 1000).toFixed(1)}s`);
  console.log(`max timing err   ${(m.maxErrorMs / 1000).toFixed(1)}s`);
  console.log(`label agreement  ${m.labelMatches}/${m.hits}`);

  console.log('\n  matched:');
  for (const p of m.pairs) {
    const err = p.err === 0 ? 'exact' : `+${(p.err / 1000).toFixed(0)}s`;
    const ok = labelMatch(p.detected.label, p.truth.label) ? '✓' : '~';
    console.log(
      `   ${ok} ${formatTimeMs(p.truth.startMs).padStart(6)}  ${p.truth.label.padEnd(30)} → ${p.detected.label.padEnd(32)} ${err}`
    );
  }
  if (m.missed.length) {
    console.log('\n  missed:');
    for (const t of m.missed) console.log(`   ✗ ${formatTimeMs(t.startMs).padStart(6)}  ${t.label}`);
  }
  if (m.extra.length) {
    console.log('\n  extra:');
    for (const d of m.extra) console.log(`   + ${formatTimeMs(d.startMs).padStart(6)}  ${d.label} (conf ${d.confidence})`);
  }

  // ---- verified tier: must be exact by construction ----
  const { fixture: verifiedFixture } = await loadFixture('verified');
  const verified = await runSample('verified');
  const exact =
    verified.topics.length === verifiedFixture.chapters.length &&
    verified.topics.every((t, i) => t.startMs === verifiedFixture.chapters[i].startMs);

  console.log('\n── Verified tier: creator chapters ──────────────────────────────');
  console.log(`topics           ${verified.topics.length}`);
  console.log(`tier             ${verified.accuracy.tier}`);
  console.log(`timestamps       ${exact ? 'identical to the source chapters (0s error)' : 'MISMATCH — BUG'}`);

  console.log('\nNote: these numbers come from one labelled fixture, not a benchmark.\n');
  process.exitCode = exact ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

module.exports = { metrics, matchTopics, labelMatch, TIGHT_MS, LOOSE_MS };
