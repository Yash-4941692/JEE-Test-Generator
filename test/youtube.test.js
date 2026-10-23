'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yt = require('../src/youtube');

const ID = 'dQw4w9WgXcQ';

test('parseVideoId accepts every common YouTube link shape', () => {
  const cases = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=90s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=42`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `youtube.com/watch?v=${ID}`,
    ID,
    `  ${ID}  `,
  ];
  for (const c of cases) {
    assert.equal(yt.parseVideoId(c).id, ID, `failed for ${c}`);
  }
});

test('parseVideoId keeps a ?t= offset', () => {
  assert.equal(yt.parseVideoId(`https://youtu.be/${ID}?t=90`).startAtMs, 90000);
  assert.equal(yt.parseVideoId(`https://youtu.be/${ID}?t=90s`).startAtMs, 90000);
  assert.equal(yt.parseVideoId(`https://youtu.be/${ID}`).startAtMs, 0);
});

test('parseVideoId rejects other sites and junk', () => {
  assert.throws(() => yt.parseVideoId('https://vimeo.com/12345'), /Only YouTube/);
  assert.throws(() => yt.parseVideoId('https://example.com/watch?v=abc'), /Only YouTube/);
  assert.throws(() => yt.parseVideoId(''), /Paste a YouTube link/);
  assert.throws(() => yt.parseVideoId('   '), /Paste a YouTube link/);
  assert.throws(() => yt.parseVideoId('https://youtube.com/watch?v=short'), /valid video ID/);
  assert.throws(() => yt.parseVideoId('https://youtube.com/'), /valid video ID/);
  assert.throws(() => yt.parseVideoId('just some words'), /doesn't look like a YouTube link/);
});

test('error codes identify the failure type', () => {
  try {
    yt.parseVideoId('https://vimeo.com/1');
  } catch (err) {
    assert.equal(err.code, 'NOT_YOUTUBE');
    assert.ok(err instanceof yt.YouTubeError);
  }
});

test('extractBalancedJson respects strings, escapes and nesting', () => {
  const text = 'prefix {"a":{"b":"}not the end{"},"c":[1,2]} suffix';
  const json = yt.extractBalancedJson(text);
  assert.deepEqual(JSON.parse(json), { a: { b: '}not the end{' }, c: [1, 2] });

  assert.equal(yt.extractBalancedJson('no braces here'), null);
  assert.equal(yt.extractBalancedJson('{"unclosed": '), null);
});

test('extractInitialJson finds the assigned global', () => {
  const html = `
    <html><script>
      var ytInitialPlayerResponse = {"videoDetails":{"title":"T"}};
      var ytInitialData = {"contents":{"x":1}};
    </script></html>`;
  assert.equal(yt.extractInitialJson(html, 'ytInitialPlayerResponse').videoDetails.title, 'T');
  assert.deepEqual(yt.extractInitialJson(html, 'ytInitialData'), { contents: { x: 1 } });
  assert.equal(yt.extractInitialJson(html, 'ytInitialOther'), null);
});

test('extractInitialJson survives braces inside strings', () => {
  const html = `var ytInitialData = {"a":"}{ tricky","b":{"c":2}};`;
  assert.deepEqual(yt.extractInitialJson(html, 'ytInitialData'), { a: '}{ tricky', b: { c: 2 } });
});

test('readChapters reads both the player and panel shapes', () => {
  const playerResponse = {
    chapters: [
      { chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: 'Intro' } } },
      { chapterRenderer: { timeRangeStartMillis: 95000, title: { runs: [{ text: 'Angular ' }, { text: 'velocity' }] } } },
    ],
  };
  const initialData = {
    panel: {
      items: [
        {
          macroMarkersListItemRenderer: {
            title: { simpleText: 'Friction' },
            onTap: { watchEndpoint: { startTimeSeconds: 200 } },
          },
        },
      ],
    },
  };

  const chapters = yt.readChapters(playerResponse, initialData);
  assert.equal(chapters.length, 3);
  assert.deepEqual(chapters[0], { startMs: 0, label: 'Intro', source: 'chapter' });
  assert.equal(chapters[1].startMs, 95000);
  assert.equal(chapters[1].label, 'Angular velocity');
  assert.equal(chapters[2].startMs, 200000);
  assert.equal(chapters[2].label, 'Friction');
});

test('readCaptionTracks and pickCaptionTrack prefer manual English', () => {
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: 'https://x/asr-hi', languageCode: 'hi', kind: 'asr', name: { simpleText: 'Hindi (auto)' } },
          { baseUrl: 'https://x/manual-hi', languageCode: 'hi', kind: '', name: { simpleText: 'Hindi' } },
          { baseUrl: 'https://x/manual-en', languageCode: 'en', kind: '', name: { simpleText: 'English' } },
        ],
      },
    },
  };

  const tracks = yt.readCaptionTracks(playerResponse);
  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].kind, 'asr');
  assert.equal(tracks[1].kind, 'manual');

  const picked = yt.pickCaptionTrack(tracks);
  assert.equal(picked.baseUrl, 'https://x/manual-en');
  assert.equal(yt.pickCaptionTrack([]), null);
  assert.equal(yt.pickCaptionTrack(null), null);
});

test('pickCaptionTrack falls back to ASR when that is all there is', () => {
  const tracks = [
    { baseUrl: 'https://x/a', languageCode: 'en', kind: 'asr', name: 'English (auto)' },
  ];
  assert.equal(yt.pickCaptionTrack(tracks).baseUrl, 'https://x/a');
});

test('readVideoDetails falls back to initial data when the player is thin', () => {
  const playerResponse = { videoDetails: { title: 'Only a title', lengthSeconds: '0' } };
  const initialData = {
    a: { videoOwnerRenderer: { title: { runs: [{ text: 'Some Channel' }] } } },
    b: { lengthText: { simpleText: '1:02:03' } },
  };
  const details = yt.readVideoDetails(playerResponse, initialData);
  assert.equal(details.title, 'Only a title');
  assert.equal(details.channel, 'Some Channel');
  assert.equal(details.lengthSeconds, 3723);
});

test('readPlayability surfaces the status', () => {
  assert.deepEqual(yt.readPlayability({ playabilityStatus: { status: 'OK' } }), {
    status: 'OK',
    reason: '',
  });
  const blocked = yt.readPlayability({
    playabilityStatus: { status: 'LOGIN_REQUIRED', reason: { simpleText: 'Sign in to confirm' } },
  });
  assert.equal(blocked.status, 'LOGIN_REQUIRED');
  assert.equal(blocked.reason, 'Sign in to confirm');
  assert.equal(yt.readPlayability(null).status, 'UNKNOWN');
});
