'use strict';

/** UI tests: the real index.html + app.js executed in jsdom with stubbed fetch. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function boot({ respond }) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    virtualConsole,
    url: 'https://preview.test/',
    pretendToBeVisual: true,
  });

  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.localStorage.clear();
  w.fetch = async (url, init) => respond(String(url), init);
  w.navigator.clipboard = { writeText: async () => {} };
  w.eval(appJs);

  return { window: w, doc: w.document, errors };
}

const ok = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 6; i++) await tick();
}

const VERIFIED = {
  ok: true,
  video: {
    id: 'fixtureVer1',
    url: 'https://www.youtube.com/watch?v=fixtureVer1',
    title: 'Circular Motion — Complete One Shot',
    channel: 'Physics Wallah Foundation',
    durationMs: 1625000,
    durationLabel: '27:05',
    thumbnail: 'https://i.ytimg.com/vi/fixtureVer1/hqdefault.jpg',
  },
  accuracy: {
    tier: 'verified',
    method: 'youtube-chapters',
    statement: 'Every timestamp is a creator-defined chapter.',
  },
  sources: {
    youtubeChapters: { available: true, count: 10 },
    descriptionTimestamps: { available: true, count: 10, confidence: 1, reason: 'ok' },
    captions: { available: true, used: 'English', isAsr: true, language: 'en', trackCount: 1, cueCount: 11 },
  },
  topics: [
    { index: 1, startMs: 0, label: 'Introduction to Circular Motion', tier: 'verified', confidence: 1, method: 'youtube-chapters', evidence: 'x' },
    { index: 2, startMs: 95000, label: 'Angular Displacement and Angular Velocity', tier: 'verified', confidence: 1, method: 'youtube-chapters', evidence: 'x' },
    { index: 3, startMs: 430000, label: 'Centripetal Acceleration Derivation', tier: 'verified', confidence: 1, method: 'youtube-chapters', evidence: 'x' },
  ],
  topicCount: 3,
  warnings: [],
  elapsedMs: 640,
};

const INFERRED = {
  ok: true,
  video: {
    id: 'fixtureInf1',
    url: 'https://www.youtube.com/watch?v=fixtureInf1',
    title: 'Second Law of Thermodynamics',
    channel: 'Physics Galaxy',
    durationMs: 322000,
    durationLabel: '5:22',
    thumbnail: 'https://i.ytimg.com/vi/fixtureInf1/hqdefault.jpg',
  },
  accuracy: {
    tier: 'inferred',
    method: 'transcript-cue',
    statement: 'Timestamps mark exactly where the detected transition sentence starts.',
  },
  sources: {
    youtubeChapters: { available: false, count: 0 },
    descriptionTimestamps: { available: false, count: 0, confidence: 0, reason: 'none' },
    captions: { available: true, used: 'English (auto-generated)', isAsr: true, language: 'en', trackCount: 1, cueCount: 33 },
  },
  topics: [
    { index: 1, startMs: 0, label: 'Introduction', tier: 'inferred', confidence: 0.57, method: 'transcript-cue', evidence: 'ok so in today\u2019s lecture we will finish the second law' },
    { index: 2, startMs: 75000, label: 'Entropy', tier: 'inferred', confidence: 0.75, method: 'transcript-cue', evidence: 'next topic is entropy entropy is a measure of the disorder' },
  ],
  topicCount: 2,
  warnings: ['This video has no chapters, so these topics were detected from transitions.'],
  elapsedMs: 880,
};

const EMULATE = {
  ok: true,
  video: { ...VERIFIED.video, title: 'Private-ish video' },
  accuracy: { tier: 'none', method: 'none', statement: 'No chapter data or usable captions were available, so no timestamps are being claimed.' },
  sources: {
    youtubeChapters: { available: false, count: 0 },
    descriptionTimestamps: { available: false, count: 0, confidence: 0, reason: 'none' },
    captions: { available: false, used: null, isAsr: false, language: '', trackCount: 0, cueCount: 0 },
  },
  topics: [],
  topicCount: 0,
  warnings: ['This video has no chapters and no captions, so there is no evidence to derive topics from.'],
  elapsedMs: 500,
};

async function submit(doc, window, value) {
  doc.querySelector('#url').value = value;
  doc.querySelector('#form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

test('boots cleanly with an empty state', () => {
  const { doc, errors, window } = boot({ respond: ok(VERIFIED) });
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelector('#result').hidden, true);
  assert.equal(doc.querySelector('#alert').hidden, true);
  assert.equal(doc.querySelectorAll('.tier').length, 3, 'accuracy tiers are explained up front');
  window.close();
});

test('verified result shows exact times, links that jump to the second, and no confidence bar', async () => {
  const { window, doc } = boot({ respond: ok(VERIFIED) });
  await submit(doc, window, 'https://youtu.be/fixtureVer1');

  assert.equal(doc.querySelector('#result').hidden, false);
  assert.match(doc.querySelector('.banner').textContent, /Verified/);
  assert.match(doc.querySelector('.banner').textContent, /creator-defined chapter/);

  const times = [...doc.querySelectorAll('.topic-time')];
  assert.deepEqual(times.map((t) => t.textContent.trim()), ['0:00', '1:35', '7:10']);
  assert.equal(times[1].getAttribute('href'), 'https://www.youtube.com/watch?v=fixtureVer1&t=95s');
  assert.equal(times[1].getAttribute('target'), '_blank');

  assert.equal(doc.querySelectorAll('.conf').length, 0, 'no confidence shown for exact data');
  assert.equal(doc.querySelectorAll('details.why').length, 0, 'no evidence toggle for exact data');

  assert.match(doc.querySelector('.sources').textContent, /Chapters: 10/);
  assert.match(doc.querySelector('.topic-list').textContent, /Angular Displacement/);
  window.close();
});

test('inferred result is clearly approximate, with confidence and the source sentence', async () => {
  const { window, doc } = boot({ respond: ok(INFERRED) });
  await submit(doc, window, 'https://www.youtube.com/watch?v=fixtureInf1');

  const banner = doc.querySelector('.banner').textContent;
  assert.match(banner, /Inferred/);
  assert.match(banner, /approximate/i);
  assert.doesNotMatch(banner, /^Verified/);

  // times carry the ≈ marker
  const times = [...doc.querySelectorAll('.topic-time')].map((t) => t.textContent);
  assert.ok(times.every((t) => t.includes('≈')), 'approximate times are marked');

  const confs = [...doc.querySelectorAll('.conf-text')].map((c) => c.textContent);
  assert.deepEqual(confs, ['57% confident', '75% confident']);

  const evidence = [...doc.querySelectorAll('.evidence')].map((e) => e.textContent);
  assert.match(evidence[1], /next topic is entropy/);

  assert.match(doc.querySelector('.warn-box').textContent, /no chapters/i);
  window.close();
});

test('a video with no sources claims nothing', async () => {
  const { window, doc } = boot({ respond: ok(EMULATE) });
  await submit(doc, window, 'https://youtu.be/fixtureVer1');

  assert.match(doc.querySelector('.banner').textContent, /Unavailable/);
  assert.equal(doc.querySelectorAll('.topic').length, 0);
  assert.match(doc.querySelector('.empty-state').textContent, /No topics could be derived/);
  assert.match(doc.querySelector('.empty-state').textContent, /rather than guessing/);
  window.close();
});

test('copy list produces timestamped lines', async () => {
  let copied = null;
  const { window, doc } = boot({ respond: ok(VERIFIED) });
  window.navigator.clipboard.writeText = async (text) => { copied = text; };

  await submit(doc, window, 'https://youtu.be/fixtureVer1');

  const btn = [...doc.querySelectorAll('button.btn')].find((b) => /Copy list/.test(b.textContent));
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();

  assert.equal(
    copied,
    '0:00 Introduction to Circular Motion\n' +
      '1:35 Angular Displacement and Angular Velocity\n' +
      '7:10 Centripetal Acceleration Derivation'
  );
  assert.equal(btn.querySelector('.btn-label').textContent, 'Copied');
  window.close();
});

test('copy with links includes a jump URL per topic', async () => {
  let copied = null;
  const { window, doc } = boot({ respond: ok(VERIFIED) });
  window.navigator.clipboard.writeText = async (text) => { copied = text; };

  await submit(doc, window, 'https://youtu.be/fixtureVer1');

  const btn = [...doc.querySelectorAll('button.btn')].find((b) => /Copy with links/.test(b.textContent));
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();

  assert.match(copied, /^0:00\tIntroduction to Circular Motion\thttps:\/\/www\.youtube\.com\/watch\?v=fixtureVer1&t=0s/m);
  assert.match(copied, /1:35\tAngular Displacement.*&t=95s/);
  window.close();
});

test('sample buttons load and are labelled as samples', async () => {
  const { window, doc } = boot({
    respond: async (url) => {
      if (url.includes('/api/samples/verified')) {
        return { ok: true, status: 200, json: async () => ({ ...VERIFIED, sample: { key: 'verified', name: 'Circular Motion', blurb: 'b', note: 'This is a stored sample.' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, samples: [{ key: 'verified', name: 'Circular Motion', blurb: 'chapter sample' }] }) };
    },
  });

  doc.querySelector('#demo-toggle').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();

  const sampleBtn = doc.querySelector('.sample-btn');
  assert.ok(sampleBtn, 'samples are listed');
  sampleBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();

  assert.match(doc.querySelector('.banner').textContent, /Offline sample/);
  assert.match(doc.querySelector('.banner').textContent, /Circular Motion/);
  window.close();
});

test('errors surface as alerts, including the offline-server hint', async () => {
  const { window, doc } = boot({
    respond: async () => ({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, error: "Couldn't reach YouTube (ENOTFOUND).", code: 'FETCH_FAILED' }),
    }),
  });

  await submit(doc, window, 'https://youtu.be/fixtureVer1');
  const alertText = doc.querySelector('#alert').textContent;
  assert.match(alertText, /Couldn't reach YouTube/);
  assert.match(alertText, /offline samples/);
  assert.equal(doc.querySelector('#result').hidden, true);
  window.close();
});

test('non-YouTube links are rejected in the UI', async () => {
  const { window, doc } = boot({
    respond: async () => ({
      ok: false,
      status: 422,
      json: async () => ({ ok: false, error: 'Only YouTube links are supported right now.', code: 'NOT_YOUTUBE' }),
    }),
  });

  await submit(doc, window, 'https://vimeo.com/1');
  assert.match(doc.querySelector('#alert').textContent, /Only YouTube/);
  window.close();
});

test('empty submit is caught before any request', async () => {
  let called = false;
  const { window, doc } = boot({
    respond: async () => { called = true; return { ok: true, status: 200, json: async () => VERIFIED }; },
  });

  doc.querySelector('#form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();

  assert.equal(called, false);
  assert.match(doc.querySelector('#alert').textContent, /Paste a YouTube link first/);
  window.close();
});
