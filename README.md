# Chapter One

Paste a YouTube lecture. Get every topic with the second it starts.

```
0:00   Introduction to Circular Motion              verified
1:35   Angular Displacement and Angular Velocity    verified
7:10   Centripetal Acceleration Derivation          verified
```

No accounts, no database, no API keys, zero runtime dependencies. One Node process
serves the UI and does the work.

```bash
npm start        # http://localhost:3000
npm test         # 94 tests
npm run evaluate # measured accuracy on the labelled fixture
```

Requires Node 20+.

---

## The accuracy contract

The project you described asked for topic timestamps at "99.99% accuracy". That number
is achievable for one half of the problem and meaningless for the other, so this app
separates them and labels every row accordingly.

| Tier | Where the time comes from | Is the number exact? |
| --- | --- | --- |
| **Verified** | A creator-defined chapter, or a timestamped line the creator wrote in the description | **Yes.** It is the same number YouTube jumps to. Nothing is inferred. You can check any row against the video. |
| **Inferred** | No chapters existed, so topic boundaries were detected from the transcript | The *time* is exact — it is the true start of that sentence in the captions. Whether that sentence starts a new topic is a judgment, so each row carries a confidence score and the sentence it came from. |
| **Unavailable** | No chapters and no usable captions | Nothing is claimed. It says so instead of inventing times. |

Three rules follow from that, and they are enforced by tests:

1. **A timestamp is never invented.** Every number traces to chapter data, a description
   line, or a caption cue. There is no interpolation and no "probably around here".
2. **The tiers are never mixed silently.** The UI badges every row, and the API returns
   a `tier` on the report and on each topic.
3. **When the source is empty, the answer is empty.** A video with no chapters and no
   captions returns zero topics and an explanation.

### Measured, not claimed

`npm run evaluate` runs the detector against a hand-labelled fixture transcript:

```
── Inferred tier: transcript cue detection ──────────────────────
labelled topics  8
detected         8
hits (±15s)      8   (±5s: 8)
exact timestamps 8 of 8 (error 0s)
precision        100.0%
recall           100.0%
max timing err   0.0s
label agreement  8/8

── Verified tier: creator chapters ──────────────────────────────
timestamps       identical to the source chapters (0s error)
```

Read that honestly: **one labelled fixture is not a benchmark.** It is a lecture-shaped
transcript written with realistic ASR phrasing, and the numbers above mean the pipeline
is correct on it and the timestamps land exactly on the cue — not that every video on
YouTube will score 100%. Real-world performance depends on how explicitly the speaker
announces transitions. A lecture that says "moving on to entropy" is easy; one that
changes subject without saying so is not detectable by rules at all.

That is precisely why the inferred tier is marked approximate and why verified data is
preferred whenever it exists.

## What it reads

For a given video, in priority order:

1. **YouTube chapters** from the player response (creator-defined `chapterRenderer` markers).
2. **Description chapters** — a timestamped list that starts at `0:00` and ascends, which
   is YouTube's own chapter convention. Parsed with a real attribute parser, so `0:00 - Intro`,
   `0:00 • Intro`, `1:02:03 Intro` and `0:00 ▶ Intro` all work.
3. **Captions** for the transcript — manual or auto-generated, in `json3`, WebVTT, SRT or
   legacy XML. Rolling ASR events are collapsed (otherwise the transcript is mostly
   duplicates), and cue-level offsets are honoured so a start time is never rounded to the
   previous caption block.

Chapters always win for timing: if a video has chapters, captions are never used to place
a topic, only to describe it.

## Limitations, stated plainly

- **Captions are required for the inferred tier.** No audio transcription is performed.
  A video with no captions and no chapters yields nothing — by design.
- **Captchas and consent walls are not bypassed.** If YouTube serves a bot/consent page,
  the API says so (`PAGE_UNREADABLE`) rather than pretending.
- **Rules, not a language model.** Topic *naming* is heuristic: it strips the transition
  phrase and cuts the sentence at the first clause boundary. That keeps it deterministic,
  free and offline, at the cost of the occasional slightly stiff name ("Second law of
  thermodynamics" rather than "The Second Law"). An LLM pass is the obvious upgrade; it
  is not wired in because it would make results non-deterministic and require a key.
- **English-oriented cues.** The transition patterns are English. Captions in other
  languages will fall back to chapters or produce nothing.
- **Single video, not a playlist.** No bulk mode yet.

## API

```bash
curl -X POST http://localhost:3000/api/topics \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=VIDEO_ID"}'
```

```json
{
  "ok": true,
  "video": {
    "id": "VIDEO_ID",
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "title": "Circular Motion — Complete One Shot",
    "channel": "Physics Wallah Foundation",
    "durationMs": 1625000,
    "durationLabel": "27:05",
    "thumbnail": "https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg"
  },
  "accuracy": {
    "tier": "verified",
    "method": "youtube-chapters",
    "statement": "Every timestamp is a creator-defined chapter, exact to the second and checkable on the video."
  },
  "sources": {
    "youtubeChapters": { "available": true, "count": 10 },
    "descriptionTimestamps": { "available": true, "count": 10, "confidence": 1 },
    "captions": { "available": true, "used": "English", "isAsr": true, "cueCount": 11 }
  },
  "topics": [
    {
      "index": 1,
      "startMs": 0,
      "label": "Introduction to Circular Motion",
      "tier": "verified",
      "confidence": 1,
      "method": "youtube-chapters",
      "evidence": "Listed as a chapter on the video"
    }
  ],
  "topicCount": 1,
  "warnings": [],
  "elapsedMs": 640
}
```

Other endpoints: `GET /api/health`, `GET /api/samples`, `POST /api/samples/:key`.
Errors return `{ "ok": false, "error": "...", "code": "..." }` with codes
`EMPTY_INPUT`, `INVALID_URL`, `NOT_YOUTUBE`, `VIDEO_UNAVAILABLE`, `UPSTREAM_RATE_LIMITED`,
`TIMEOUT`, `FETCH_FAILED`, `PAGE_UNREADABLE`, `RATE_LIMITED`.

Input accepts `watch?v=`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`, `music.youtube.com`,
a scheme-less URL, or a bare 11-character video ID.

## Offline samples

The **Try offline samples** button runs stored fixtures through the *same* pipeline with
the network layer swapped out — one video with creator chapters (verified tier), one with
no chapters at all (inferred tier). This exists so the app is demonstrable on a host with
no outbound internet, and so the test suite can assert the accuracy contract without
network flakiness. Sample results are labelled as samples.

## How it works

```
public/index.html, app.js, styles.css   UI
server.js                               static files, rate limit, API
src/youtube.js                          URL parsing, page fetch, embedded JSON, captions
src/captions.js                         json3 / VTT / SRT / XML -> cues -> sentences
src/description.js                      chapter lists out of descriptions
src/topics.js                           tier selection, cue detection, label cleanup
src/demo.js                             fixtures through the real pipeline
scripts/evaluate.js                     precision / recall / timing error
```

Cue detection is deterministic: seven ordered patterns ("let's move on to", "next topic
is", "topic three", "finally let's…"), matched across a short rolling window so a
transition split over several caption cues is still found, and never matched mid-sentence
so back-references ("as we saw when we looked at friction") are ignored.

Rate limit: 25 videos per IP per minute. Body caps: 8 MB page, 4 MB captions. Hop timeouts
12–15s.

## Deploying

```bash
docker build -t chapter-one .
docker run -p 3000:3000 chapter-one
```

Any Node 20+ host works (Render, Railway, Fly, a VPS). **The host needs outbound internet
to reach YouTube**; a sandboxed environment without it will return `FETCH_FAILED` and point
you at the offline samples.

## Troubleshooting

**"The gateway returned HTTP 502" / a bare `HTTP 502`.**
That is not the app failing — it is whatever sits in front of it (a preview proxy,
load balancer, reverse proxy) giving up and sending its own error page instead of the
app's JSON. The app now says so explicitly and offers **Retry**, instead of echoing a
status code. Two things make this diagnosable:

- Every API request is logged with its status and duration:
  `2026-10-23T08:25:13.197Z POST /api/topics -> 502 (36ms)`. If you see the line,
  the request reached the app and the status is real. If you see **nothing**, the
  request never arrived and the problem is in front of the app.
- `GET /api/health` reports the server budget: `{ ok, uptime, budgetMs, upstreamTimeoutMs }`.
  The UI pings it on load to tell "app down" apart from "lookup failed".

Requests run under a hard budget (`REQUEST_BUDGET_MS`, default **10000ms**) that is
shorter than a typical proxy timeout, so a slow YouTube connection produces our own
JSON `504 TIMEOUT` rather than a proxy's HTML 502. Upstream fetches use
`UPSTREAM_TIMEOUT_MS` (default **7000ms**). Raise both if you host it behind something
patient, lower them if your proxy is aggressive:

```bash
REQUEST_BUDGET_MS=20000 UPSTREAM_TIMEOUT_MS=15000 npm start
```

**"Couldn't reach YouTube (ECONNRESET / ENOTFOUND)".**
The host has no outbound internet, or YouTube is blocked from it. Sandboxed previews
behave this way. The offline samples still work; deploy somewhere with egress to
resolve real videos.

## Tests

```
test/util.test.js         5  time formatting, text extraction, entities
test/youtube.test.js     12  URL shapes, embedded JSON, chapters, caption tracks
test/description.test.js 13  chapter-list rules, confidence, false positives
test/captions.test.js    13  every caption format, rolling ASR, pause splitting
test/topics.test.js      18  tier contract, cue detection, label cleanup, accuracy floor
test/ui.test.js          16  real UI in jsdom: badges, links, copy, errors, gateway failures
test/server.test.js      12  HTTP routes, samples, error codes, traversal, health
test/budget.test.js       5  request deadline behaviour
```

The tests use local fixtures and mock responses, so the suite runs offline.

## Licence

MIT.
