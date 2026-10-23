'use strict';

/**
 * Topic extraction and the accuracy contract.
 *
 * Every topic carries a tier:
 *
 *   verified — the timestamp comes from data a human created: YouTube chapters
 *              or a chapter list in the description. The number is exact and
 *              can be checked against the video; nothing is guessed.
 *
 *   inferred — no chapter data existed, so boundaries were derived from
 *              deterministic cues in the transcript ("now let's look at…",
 *              "moving on to…", enumerated headings). The timestamp is the
 *              true start of that sentence in the captions, but whether the
 *              speaker *began a topic* there is a judgment. Marked approximate.
 *
 *   none     — neither source exists; no timestamps are produced at all.
 *
 * The two tiers are never mixed into one unlabelled list, and a topic is never
 * emitted with a made-up time.
 */

const { cleanText, clamp, formatTimeMs } = require('./util');
const youtube = require('./youtube');
const { parseCaptions, toSentences } = require('./captions');
const {
  parseDescriptionChapters,
  looksLikeLectureList,
  extractLinks,
} = require('./description');

/* ------------------------------------------------------------------ *
 * Transcript cue detection
 * ------------------------------------------------------------------ */

/**
 * Ordered strongest-first. Each pattern must match at the START of the spoken
 * window, because mid-sentence matches are usually back-references
 * ("as we saw when we looked at friction").
 *
 * FILLER absorbs the words people begin sentences with, so "so now let's look
 * at…" matches the same pattern as "let's look at…".
 */
const FILLER = String.raw`(?:(?:so|ok|okay|alright|now|and|but|right|well|then|also)\b[\s,]*)*`;

const CUES = [
  {
    kind: 'explicit-transition',
    weight: 0.92,
    re: new RegExp(
      `^${FILLER}(?:(?:let(?:'|’)?s|let\\s+us)\\s+(?:now\\s+)?(?:move\\s+on\\s+to|get\\s+started\\s+with|begin\\s+with|start\\s+with|look\\s+at|discuss|talk\\s+about|understand|see|cover|do|solve|jump\\s+into|head\\s+(?:in)?to)|(?:i|we)(?:'|’)?ll\\s+(?:now\\s+)?(?:discuss|cover|look\\s+at|talk\\s+about|see|understand))\\b`,
      'i'
    ),
  },
  {
    kind: 'move-on',
    weight: 0.88,
    re: new RegExp(
      `^${FILLER}(?:moving\\s+on|next\\s+(?:topic|part|section|chapter|we(?:'|’)?ll|up\\b)|the\\s+next\\s+(?:topic|thing|part)|coming\\s+to|(?:now|next|then)\\s+we\\s+(?:come\\s+to|move\\s+to|look\\s+at|will\\s+(?:see|discuss|cover))|let(?:'|’)?s\\s+(?:now\\s+)?(?:proceed|continue))\\b`,
      'i'
    ),
  },
  {
    kind: 'enumerated',
    weight: 0.85,
    re: new RegExp(
      `^${FILLER}(?:topic|part|section|point|chapter|question|problem|example|step)\\s*(?:number\\s*)?(?:no\\.?\\s*)?(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\b`,
      'i'
    ),
  },
  {
    kind: 'ordinal',
    weight: 0.8,
    re: new RegExp(
      `^${FILLER}(?:first|firstly|second|secondly|third|thirdly|next|finally|lastly)\\b[\\s,]*(?:we(?:'|’)?ll|i(?:'|’)?ll|let(?:'|’)?s|the|comes?|is|comes|part|topic|question|problem|example)\\b`,
      'i'
    ),
  },
  {
    kind: 'definition',
    weight: 0.78,
    re: new RegExp(
      `^${FILLER}(?:what\\s+is|what\\s+are|let(?:'|’)?s\\s+(?:understand|define)|definition\\s+of|introduction\\s+to|basics\\s+of|concept\\s+of)\\b`,
      'i'
    ),
  },
  {
    kind: 'agenda',
    weight: 0.7,
    re: new RegExp(
      `^${FILLER}(?:in\\s+this\\s+(?:video|lecture|session|class)|in\\s+today(?:'|’)?s\\s+(?:video|lecture|session|class)|today\\s+we(?:'|’)?(?:ll|re\\s+going\\s+to))\\b`,
      'i'
    ),
  },
  {
    kind: 'solve-start',
    weight: 0.62,
    re: new RegExp(
      `^${FILLER}(?:let(?:'|’)?s\\s+(?:now\\s+)?(?:solve|start\\s+the\\s+questions)|now\\s+we\\s+(?:come\\s+to|look\\s+at))\\b`,
      'i'
    ),
  },
];

/** Strip the transition phrase so the remainder reads like a topic name. */
const CUE_PREFIX_RE = new RegExp(
  `^${FILLER}(?:` +
    [
      `(?:let(?:'|’)?s|let\\s+us)\\s+(?:now\\s+)?(?:move\\s+on\\s+to|get\\s+started\\s+with|begin\\s+with|start\\s+with|look\\s+at|discuss|talk\\s+about|understand|see|cover|do|solve|jump\\s+into|head\\s+(?:in)?to|proceed|continue)`,
      `(?:i|we)(?:'|’)?ll\\s+(?:now\\s+)?(?:discuss|cover|look\\s+at|talk\\s+about|see|understand)`,
      `moving\\s+on(?:\\s+to)?`,
      `next\\s+(?:topic|part|section|chapter|up)\\b(?:\\s+is)?`,
      `the\\s+next\\s+(?:topic|thing|part)`,
      `coming\\s+to`,
      `(?:now|next|then)\\s+we\\s+(?:come\\s+to|move\\s+to|look\\s+at|will\\s+(?:see|discuss|cover))`,
      `(?:topic|part|section|point|chapter|question|problem|example|step)\\s*(?:number\\s*)?(?:no\\.?\\s*)?(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)`,
      `(?:first|firstly|second|secondly|third|thirdly|next|finally|lastly)(?:\\s+(?:let(?:'|’)?s|we(?:'|’)?ll|i(?:'|’)?ll))?(?:\\s+(?:now\\s+)?(?:do|see|look\\s+at|discuss|cover|solve|start|take))?`,
      `(?:what\\s+is|what\\s+are|definition\\s+of|introduction\\s+to|basics\\s+of|concept\\s+of|let(?:'|’)?s\\s+(?:understand|define))`,
      `in\\s+this\\s+(?:video|lecture|session|class)`,
      `in\\s+today(?:'|’)?s\\s+(?:video|lecture|session|class)`,
      `today\\s+we(?:'|’)?(?:ll|re\\s+going\\s+to)`,
      `(?:let(?:'|’)?s\\s+(?:now\\s+)?(?:solve|start\\s+the\\s+questions)|now\\s+we\\s+(?:come\\s+to|look\\s+at))`,
    ].join('|') +
    `)\\b[\\s,:;\\-–—]*`,
  'i'
);

/** Labels that are pure filler even after the cue phrase is stripped. */
const FILLER_LABELS =
  /^(?:it|this|that|this\s+one|that\s+one|the\s+next\s+one|here|there|some|another|a\s+few|everything|nothing|more|it\s+now|now)$/i;

const LEADING_JUNK_RE = /^(?:the|a|an|is|are|was|were|this|that|these|those|it|so|and|but|ok|okay|alright)\b[\s,:;\-–—]*/i;
const TRAILING_JUNK_RE = /[\s,:;\-–—]*(?:^|\s)(?:the|a|an|of|to|in|on|for|with|by|and|or|is|are|was|were|that|which|now|then|here|there)$/i;
const DISCOURSE_RE = /\s+(?:now|remember|okay|ok|alright|anyway)\b/i;

const STOPWORDS = new Set([
  'the','a','an','of','to','in','on','for','with','by','and','or','is','are','was','were',
  'that','this','it','you','we','i','will','can','would','should','then','now','so',
]);

/** Words that start a new clause, so a label should stop before them. */
const CLAUSE_VERBS = new Set([
  'is','are','was','were','means','denote','denotes','represent','represents','tells','tell',
  'gives','give','takes','take','contains','contain','depends','depend','becomes','become',
  'happens','happen','starts','start','works','work','we','you','i','let','can','will','shall',
  'has','have','had','does','do','did','comes','come','goes','go','gets','get','need','needs',
  'want','wants','know','knows','see','look','looks','remember','discussed','discuss',
]);

/** Structural words that name nothing on their own. */
const GENERIC_ONLY = new Set([
  'question','questions','problem','problems','example','examples','topic','topics','part',
  'parts','section','sections','chapter','chapters','step','steps','point','points','number',
  'one','two','three','four','five','six','seven','eight','nine','ten','next','this','it',
]);

function words(text) {
  return text.split(/\s+/).filter(Boolean);
}

/** "entropy entropy is…" -> "entropy is…" */
function collapseRepeats(text) {
  const parts = words(text);
  const out = [];
  for (const word of parts) {
    if (out.length && out[out.length - 1].toLowerCase() === word.toLowerCase()) continue;
    out.push(word);
  }
  return out.join(' ');
}

/** Cut at the first content word that repeats (stem-compared). */
function cutAtRepeat(text) {
  const parts = words(text);
  const seen = new Map();

  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!raw || STOPWORDS.has(raw) || raw.length < 3) continue;
    const stem = raw.slice(0, 6);
    if (seen.has(stem) && i - seen.get(stem) >= 1) {
      return parts.slice(0, i).join(' ').trim();
    }
    seen.set(stem, i);
  }
  return text;
}

/** Cut at a discourse marker, but never before the topic has two words. */
function cutAtDiscourse(text) {
  const parts = words(text);
  for (let i = 2; i < parts.length; i++) {
    if (DISCOURSE_RE.test(' ' + parts[i])) return parts.slice(0, i).join(' ');
  }
  return text;
}

/** Cut before the first clause verb, keeping single-word topic names intact. */
function cutAtVerb(text) {
  const parts = words(text);
  for (let i = 1; i < parts.length; i++) {
    const raw = parts[i].toLowerCase().replace(/[^a-z']/g, '');
    if (CLAUSE_VERBS.has(raw)) return parts.slice(0, i).join(' ');
  }
  return text;
}

function normaliseLabel(raw) {
  let label = cleanText(raw)
    .replace(/^[\s,;:.\-–—]+/, '')
    .replace(/^["'“”([]+/, '')
    .replace(/[\s,;:.\-–—]+$/, '')
    .trim();

  if (!label) return '';

  // 1. Drop a clause that isn't part of the topic name (", which…", "; so…").
  const clause = label.split(/\s*(?:[,;]|\s(?:which|that|because|where|when)\s)\s*/i)[0].trim();
  if (words(clause).length >= 1) label = clause;

  // 2. Collapse stutters and repeats from rolling caption windows.
  label = collapseRepeats(label);

  // 3. Stop where a new thought starts, then where a new clause starts.
  label = cutAtDiscourse(label);
  label = cutAtVerb(label);

  // 4. Stop when a content word repeats — that's a second sentence.
  label = cutAtRepeat(label);

  // 5. Keep it short enough to read as a name.
  const parts = words(label);
  if (parts.length > 8) label = parts.slice(0, 8).join(' ');

  // 6. Strip leading articles/auxiliaries and trailing dangling words.
  label = label.replace(LEADING_JUNK_RE, '').trim();
  for (let i = 0; i < 3; i++) {
    const trimmed = label.replace(TRAILING_JUNK_RE, '').trim();
    if (trimmed === label) break;
    label = trimmed;
  }

  label = label.replace(/\s+/g, ' ').trim();
  if (!label) return '';

  // 7. A single generic structural word names nothing.
  if (GENERIC_ONLY.has(label.toLowerCase())) return '';

  if (/^[a-z]/.test(label)) label = label[0].toUpperCase() + label.slice(1);
  return label;
}

/** Token-set similarity, used to drop the same topic said twice. */
function similarLabels(a, b) {
  const norm = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(
          (w) =>
            w.length > 2 &&
            !['the', 'and', 'for', 'with', 'you', 'this', 'that', 'now', 'let', 'will', 'll'].includes(w)
        )
    );
  const sa = norm(a);
  const sb = norm(b);
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.min(sa.size, sb.size);
}

/**
 * Build a spoken window starting at cue i. ASR splits a single sentence across
 * several cues ("so now let's" | "move on to" | "the second law"), so the
 * transition phrase has to be checked across a short window rather than one cue.
 */
/**
 * Caption cues sometimes split a contraction ("so now let" | "s move on to").
 * Re-join the obvious ones so cue matching still sees "let's".
 */
function repairApostrophes(text) {
  return String(text).replace(
    /\b(let|it|that|what|there|here|don|doesn|didn|isn|aren|wasn|weren|won|couldn|wouldn|shouldn|we|they|you|i)\s+(s|t|re|ve|ll|d|m)\b/gi,
    (m, head, tail) => `${head}'${tail}`
  );
}

function windowFrom(cues, i, maxChars = 140, maxSpanMs = 8000) {
  const first = cues[i];
  const parts = [first.text];
  let endMs = first.endMs;
  let j = i + 1;

  while (j < cues.length) {
    const text = parts.join(' ');
    if (text.length >= maxChars) break;
    if (cues[j].startMs - first.startMs > maxSpanMs) break;
    // A pause longer than 2.5s usually means a new thought; stop there.
    if (cues[j].startMs - endMs > 2500) break;
    parts.push(cues[j].text);
    endMs = Math.max(endMs, cues[j].endMs);
    j++;
  }

  const text = repairApostrophes(parts.join(' ').replace(/\s+/g, ' ').trim());
  return { text, endMs };
}

/**
 * Derive candidate topics from timed caption cues.
 *
 * The timestamp used is the start of the cue where the transition phrase
 * begins — the true start of that sentence in the audio, not an approximation
 * interpolated from a merged block.
 */
function inferTopicsFromCues(cues, options = {}) {
  const minGapMs = options.minGapMs ?? 20000;
  const maxTopics = options.maxTopics ?? 150;
  const isAsr = Boolean(options.isAsr);

  const usable = (cues || []).filter((c) => c && !c.untimed && c.text && c.text.trim());
  const candidates = [];

  for (let i = 0; i < usable.length; i++) {
    const cue = usable[i];
    const window = windowFrom(usable, i);

    const cueMatch = CUES.find((c) => c.re.test(window.text));
    if (!cueMatch) continue;

    const stripped = window.text.replace(CUE_PREFIX_RE, '');
    // The opening "in this lecture we'll cover…" line is an introduction, and
    // its raw wording makes a poor topic name.
    const label = cueMatch.kind === 'agenda' ? 'Introduction' : normaliseLabel(stripped);
    if (!label || label.length < 3) continue;
    if (FILLER_LABELS.test(label)) continue;

    const confidence = clamp(
      cueMatch.weight - (isAsr ? 0.05 : 0) - (label.split(/\s+/).length < 2 ? 0.08 : 0),
      0.3,
      0.95
    );

    candidates.push({
      startMs: cue.startMs,
      label,
      kind: cueMatch.kind,
      confidence: Number(confidence.toFixed(2)),
      evidence: window.text.length > 220 ? window.text.slice(0, 220) + '…' : window.text,
    });
  }

  // Keep the first of any near-duplicate, and collapse topics that are too close.
  const kept = [];
  for (const cand of candidates) {
    const dup = kept.find(
      (k) => Math.abs(k.startMs - cand.startMs) < minGapMs && similarLabels(k.label, cand.label) > 0.8
    );
    if (dup) {
      if (cand.confidence > dup.confidence) Object.assign(dup, cand);
      continue;
    }
    if (kept.some((k) => Math.abs(k.startMs - cand.startMs) < minGapMs)) continue;
    kept.push(cand);
    if (kept.length >= maxTopics) break;
  }

  return kept.map((t, i) => ({
    ...t,
    index: i + 1,
    tier: 'inferred',
    method: 'transcript-cue',
  }));
}

/**
 * Backwards-compatible entry point: accepts merged sentences or raw cues.
 * Detection itself is cue-based for timing precision.
 */
function inferTopicsFromSentences(sentences, options = {}) {
  return inferTopicsFromCues(sentences, options);
}

/* ------------------------------------------------------------------ *
 * Main analysis
 * ------------------------------------------------------------------ */

async function analyse(input, options = {}) {
  const startedAt = Date.now();
  const { id, startAtMs } = youtube.parseVideoId(input);

  // Injectable so the same pipeline runs on fixtures (offline demo + tests)
  // and on the live site.
  const fetchPage = options.fetchWatchPage || youtube.fetchWatchPage;
  const fetchCaptions = options.fetchCaptionTrack || youtube.fetchCaptionTrack;

  const page = await fetchPage(id, options);
  const playability = youtube.readPlayability(page.playerResponse);

  const BLOCKED_STATUSES = {
    LOGIN_REQUIRED: 'This video requires being signed in, so it cannot be read.',
    AGE_VERIFICATION_REQUIRED: 'This video is age-restricted and cannot be read without a session.',
    AGE_CHECK_REQUIRED: 'This video is age-restricted and cannot be read without a session.',
    CONTENT_CHECK_REQUIRED: 'This video requires a consent check this server cannot pass.',
    PRIVATE: 'This video is private.',
    UNPLAYABLE: 'YouTube will not play this video to other sites.',
    ERROR: 'YouTube could not serve this video.',
  };

  if (playability.status !== 'OK' && playability.status !== 'UNKNOWN') {
    const message =
      BLOCKED_STATUSES[playability.status] ||
      playability.reason ||
      `Video unavailable (${playability.status}).`;
    throw new youtube.YouTubeError(message, 'VIDEO_UNAVAILABLE', {
      status: playability.status,
      reason: playability.reason,
    });
  }

  const video = youtube.readVideoDetails(page.playerResponse, page.initialData);
  const warnings = [];

  /* --- chapter sources ------------------------------------------------ */

  const youtubeChapters = youtube
    .readChapters(page.playerResponse, page.initialData)
    .filter((c) => c.label)
    .sort((a, b) => a.startMs - b.startMs);

  const description = parseDescriptionChapters(video.description);

  const descriptionChapters = description.chapters.map((c) => ({
    startMs: c.startMs,
    label: c.label,
    source: 'description',
  }));

  let chapters = [];
  let chapterSource = '';

  if (youtubeChapters.length >= 3) {
    chapters = youtubeChapters;
    chapterSource = 'youtube-chapters';
  } else if (description.confidence >= 0.75 && descriptionChapters.length >= 2) {
    chapters = descriptionChapters;
    chapterSource = 'description-timestamps';
  } else if (youtubeChapters.length > 0) {
    chapters = youtubeChapters;
    chapterSource = 'youtube-chapters';
    warnings.push('YouTube listed fewer than three chapters, so they may be partial.');
  }

  /* --- captions ------------------------------------------------------- */

  const tracks = youtube.readCaptionTracks(page.playerResponse);
  const track = youtube.pickCaptionTrack(tracks);

  let captionInfo = {
    available: Boolean(tracks.length),
    used: null,
    trackCount: tracks.length,
    isAsr: false,
    language: '',
    cueCount: 0,
    cues: [],
    sentences: [],
    failed: null,
  };

  if (track) {
    try {
      const body = await fetchCaptions(track, options);
      const parsed = parseCaptions(body, track.baseUrl.includes('json3') ? 'json3' : '');
      captionInfo = {
        available: true,
        used: track.name,
        trackCount: tracks.length,
        isAsr: track.kind === 'asr',
        language: track.languageCode,
        cueCount: parsed.cues.length,
        cues: parsed.untimed ? [] : parsed.cues,
        sentences: parsed.untimed ? [] : toSentences(parsed.cues),
        failed: parsed.cues.length ? null : 'captions were empty',
      };
      if (parsed.untimed) {
        warnings.push('YouTube returned captions without timings, so they were not used.');
      }
    } catch (err) {
      captionInfo.failed = err.message;
      warnings.push(`Captions could not be fetched (${err.message}), so transcript analysis was skipped.`);
    }
  }

  /* --- assemble topics ------------------------------------------------ */

  let topics = [];
  let tier = 'none';
  let method = 'none';

  if (chapters.length) {
    const useDescriptionConfidence =
      chapterSource === 'description-timestamps' && description.confidence < 1;

    topics = chapters.map((c, i) => ({
      index: i + 1,
      startMs: c.startMs,
      label: c.label,
      tier: 'verified',
      confidence: 1,
      method: chapterSource,
      evidence:
        chapterSource === 'youtube-chapters'
          ? 'Listed as a chapter on the video'
          : `Timestamped line in the description (${description.reason})`,
    }));
    tier = 'verified';
    method = chapterSource;

    if (useDescriptionConfidence) {
      warnings.push(
        'Chapters came from the description rather than YouTube chapters; the list is ascending and usable but does not follow the 0:00 convention.'
      );
    }
    if (description.confidence >= 0.75 && youtubeChapters.length >= 3 && descriptionChapters.length) {
      // Both agree: report whether they match, as a trust signal.
      const same = descriptionChapters.length === youtubeChapters.length &&
        descriptionChapters.every((c, i) => Math.abs(c.startMs - youtubeChapters[i].startMs) < 1000);
      if (same) {
        topics[0].evidence = 'Listed as a chapter on the video and matching the description timestamps';
      }
    }
  } else if (captionInfo.cues.length) {
    topics = inferTopicsFromCues(captionInfo.cues, {
      isAsr: captionInfo.isAsr,
    });
    if (topics.length) {
      tier = 'inferred';
      method = 'transcript-cue';
      warnings.push(
        'This video has no chapters, so these topics were detected from how the speaker transitions between subjects. ' +
          'Timestamps point at the exact sentence where the transition happens, but the choice of boundaries is approximate.'
      );
    }
  }

  if (!topics.length) {
    tier = 'none';
    method = 'none';
    if (!chapters.length && !captionInfo.available) {
      warnings.push('This video has no chapters and no captions, so there is no evidence to derive topics from.');
    } else if (!chapters.length && !captionInfo.cues.length) {
      warnings.push('Captions were available but contained no usable transitions, so no topics were emitted.');
    }
  }

  if (captionInfo.isAsr && topics.length && tier === 'inferred') {
    warnings.push('Topics were derived from auto-generated captions, which mishearing words can shift.');
  }

  const durationMs = video.lengthSeconds ? video.lengthSeconds * 1000 : null;

  return {
    ok: true,
    video: {
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: video.title,
      channel: video.channel,
      durationMs,
      durationLabel: durationMs ? formatTimeMs(durationMs) : '',
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      isLive: video.isLive,
      viewCount: video.viewCount,
      startAtMs: startAtMs || 0,
    },
    accuracy: {
      tier,
      method,
      statement: accuracyStatement(tier, method),
    },
    sources: {
      youtubeChapters: {
        available: youtubeChapters.length > 0,
        count: youtubeChapters.length,
      },
      descriptionTimestamps: {
        available: descriptionChapters.length > 0,
        count: descriptionChapters.length,
        confidence: description.confidence,
        reason: description.reason,
      },
      captions: {
        available: captionInfo.available,
        used: captionInfo.used,
        isAsr: captionInfo.isAsr,
        language: captionInfo.language,
        trackCount: captionInfo.trackCount,
        cueCount: captionInfo.cueCount,
        sentenceCount: captionInfo.sentences.length,
        failed: captionInfo.failed,
      },
    },
    topics,
    topicCount: topics.length,
    lectureStyle: looksLikeLectureList(chapters),
    links: extractLinks(video.description),
    warnings: [...new Set(warnings)],
    elapsedMs: Date.now() - startedAt,
  };
}

function accuracyStatement(tier, method) {
  if (tier === 'verified' && method === 'youtube-chapters') {
    return 'Every timestamp is a creator-defined chapter, exact to the second and checkable on the video.';
  }
  if (tier === 'verified' && method === 'description-timestamps') {
    return 'Every timestamp comes from a timestamped line the creator wrote in the description — exact, not guessed.';
  }
  if (tier === 'inferred') {
    return 'Timestamps mark exactly where the detected transition sentence starts; which sentences count as topic starts is approximate.';
  }
  return 'No chapter data or usable captions were available, so no timestamps are being claimed.';
}

module.exports = {
  analyse,
  inferTopicsFromCues,
  inferTopicsFromSentences,
  normaliseLabel,
  similarLabels,
  CUES,
  accuracyStatement,
};
