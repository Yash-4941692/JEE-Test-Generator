'use strict';

const $ = (sel) => document.querySelector(sel);

const form = $('#form');
const input = $('#url');
const go = $('#go');
const alertBox = $('#alert');
const resultEl = $('#result');
const samplesPanel = $('#samples');
const sampleGrid = $('#sample-grid');
const demoToggle = $('#demo-toggle');

const HISTORY_KEY = 'ch1.history.v1';
const MAX_HISTORY = 6;

/* ------------------------------------------------------------------ *
 * DOM helper — user/video text never goes through innerHTML
 * ------------------------------------------------------------------ */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // static icon markup only
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const ICON = {
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0012.5 3H6a2.5 2.5 0 00-2.5 2.5V13A2.5 2.5 0 006 15.5"/></svg>',
  open: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8"/><path d="M18 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h5"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/><path d="M9 12l2.2 2.2L15.5 10"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5v5M12 16.8v.2"/><path d="M10.3 3.9L2.5 17.4A1.8 1.8 0 004 20h16a1.8 1.8 0 001.5-2.6L13.7 3.9a1.9 1.9 0 00-3.4 0z"/></svg>',
};

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */
let inFlight = null;
let lastReport = null;

function setLoading(on) {
  go.classList.toggle('loading', on);
  go.disabled = on;
  go.querySelector('.label').textContent = on ? 'Reading…' : 'Find topics';
}

function showAlert(message, kind = 'error') {
  alertBox.textContent = message;
  alertBox.className = 'alert' + (kind === 'soft' ? ' soft' : '');
  alertBox.hidden = !message;
}

function clearAlert() {
  alertBox.hidden = true;
  alertBox.textContent = '';
}

function fmt(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const timeUrl = (videoUrl, ms) => `${videoUrl}&t=${Math.floor((Number(ms) || 0) / 1000)}s`;

/* ------------------------------------------------------------------ *
 * copy helpers
 * ------------------------------------------------------------------ */
async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
  }
  if (!ok || !btn) return;

  const label = btn.querySelector('.btn-label');
  const icon = btn.querySelector('.btn-icon');
  if (!label) return;
  const previous = label.textContent;
  if (icon) icon.innerHTML = ICON.check;
  label.textContent = 'Copied';
  setTimeout(() => {
    label.textContent = previous;
    if (icon) icon.innerHTML = ICON.copy;
  }, 1600);
}

function chaptersText(report) {
  return report.topics
    .map((t) => `${fmt(t.startMs)} ${t.label}`)
    .join('\n');
}

function timeListText(report) {
  return report.topics
    .map((t) => `${fmt(t.startMs)}\t${t.label}\t${timeUrl(report.video.url, t.startMs)}`)
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * submit
 * ------------------------------------------------------------------ */
form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(input.value);
});

input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run(input.value);
  }
});

async function run(value, { sample = null } = {}) {
  const raw = (value || '').trim();
  if (!sample && !raw) {
    showAlert('Paste a YouTube link first.');
    input.focus();
    return;
  }

  clearAlert();
  setLoading(true);
  resultEl.hidden = true;

  if (inFlight) inFlight.abort();
  inFlight = new AbortController();

  try {
    const res = sample
      ? await fetch(`/api/samples/${encodeURIComponent(sample)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: inFlight.signal,
        })
      : await fetch('/api/topics', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: raw }),
          signal: inFlight.signal,
        });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok === false) {
      const message = (data && data.error) || `Lookup failed (HTTP ${res.status}).`;
      if (data && data.code === 'RATE_LIMITED') return showAlert(message, 'soft');
      if (data && (data.code === 'FETCH_FAILED' || data.code === 'PAGE_UNREADABLE')) {
        return showAlert(`${message} A hosted preview may have no outbound internet — try the offline samples.`);
      }
      return showAlert(message);
    }

    lastReport = data;
    render(data);
    if (!data.sample && raw) addHistory({ ...data, input: raw });
  } catch (err) {
    if (err.name === 'AbortError') return;
    showAlert("Couldn't reach the server. Is it running?");
  } finally {
    setLoading(false);
    inFlight = null;
  }
}

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */
function render(report) {
  const tier = report.accuracy.tier;
  const card = el('div', { class: 'card' + (tier === 'inferred' ? ' tier-inferred' : '') });

  card.append(videoRow(report));
  if (report.sample) card.append(sampleNote(report.sample));
  card.append(accuracyBanner(report));
  card.append(sourcesRow(report));

  if (report.topics.length) {
    card.append(topicsSection(report));
  } else {
    card.append(
      el('div', { class: 'empty-state' },
        el('strong', { text: 'No topics could be derived' }),
        'This video has no chapters and no usable captions. Nothing is shown rather than guessing times.'
      )
    );
  }

  if (report.warnings && report.warnings.length) {
    card.append(
      el('div', { class: 'warn-box' },
        el('ul', {}, report.warnings.map((w) => el('li', { text: w })))
      )
    );
  }

  resultEl.replaceChildren(card);
  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function videoRow(report) {
  const v = report.video;
  const thumb = el('div', { class: 'thumb' }, 'no preview');
  const img = new Image();
  img.alt = '';
  img.loading = 'lazy';
  img.onload = () => { thumb.replaceChildren(img); };
  img.src = v.thumbnail;

  return el(
    'div',
    { class: 'video-row' },
    thumb,
    el(
      'div',
      { class: 'video-meta' },
      el('h2', { class: 'video-title', text: v.title || 'Untitled video' }),
      el(
        'div',
        { class: 'video-sub' },
        v.channel ? el('span', { text: v.channel }) : null,
        v.durationLabel ? el('span', { class: 'sep', text: '·' }) : null,
        v.durationLabel ? el('span', { text: v.durationLabel }) : null,
        el('span', { class: 'sep', text: '·' }),
        el('span', { text: `${report.topicCount} topic${report.topicCount === 1 ? '' : 's'}` }),
        el('span', { class: 'sep', text: '·' }),
        el('a', {
          class: 'btn ghost',
          href: v.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: 'padding:2px 6px;font-size:11.5px',
        }, 'Open on YouTube', el('span', { html: ICON.open }))
      )
    )
  );
}

function sampleNote(sample) {
  return el(
    'div',
    { class: 'banner tier-inferred', style: 'background:rgba(91,140,255,0.07);color:#c7d8ff' },
    el('span', { class: 'banner-icon', html: ICON.shield }),
    el('div', {},
      el('strong', { text: `Offline sample — ${sample.name}. ` }),
      sample.note
    )
  );
}

function accuracyBanner(report) {
  const { tier, statement } = report.accuracy;
  const map = {
    verified: { cls: 'tier-verified', icon: ICON.shield, badge: 'verified', label: 'Verified' },
    inferred: { cls: 'tier-inferred', icon: ICON.clock, badge: 'inferred', label: 'Inferred · approximate' },
    none: { cls: 'tier-none', icon: ICON.alert, badge: 'none', label: 'Unavailable' },
  }[tier] || { cls: 'tier-none', icon: ICON.alert, badge: 'none', label: 'Unknown' };

  return el(
    'div',
    { class: `banner ${map.cls}` },
    el('span', { class: 'banner-icon', html: map.icon }),
    el('div', {},
      el('span', { class: `badge ${map.badge}`, text: map.label }),
      ' ',
      statement
    )
  );
}

function sourcesRow(report) {
  const s = report.sources;
  const chips = [];

  chips.push(
    s.youtubeChapters.available
      ? el('span', { class: 'chip yes', text: `Chapters: ${s.youtubeChapters.count}` })
      : el('span', { class: 'chip no', text: 'No chapters' })
  );

  if (s.descriptionTimestamps.available) {
    chips.push(
      el('span', {
        class: `chip ${s.descriptionTimestamps.confidence >= 0.75 ? 'yes' : 'warn'}`,
        text: `Description timestamps: ${s.descriptionTimestamps.count}`,
        title: s.descriptionTimestamps.reason,
      })
    );
  }

  if (s.captions.available) {
    const name = s.captions.used || s.captions.language || 'present';
    const alreadyMarked = /auto/i.test(name);
    chips.push(
      el('span', {
        class: `chip ${s.captions.isAsr ? 'warn' : 'yes'}`,
        text: `Captions: ${name}${s.captions.isAsr && !alreadyMarked ? ' (auto)' : ''}`,
      })
    );
  } else {
    chips.push(el('span', { class: 'chip no', text: 'No captions' }));
  }

  chips.push(
    el('span', {
      class: 'chip',
      text: `${(report.elapsedMs / 1000).toFixed(1)}s`,
    })
  );

  return el('div', { class: 'sources' }, chips);
}

function topicsSection(report) {
  const inferred = report.accuracy.tier === 'inferred';
  const list = el('ul', { class: 'topic-list' });

  report.topics.forEach((topic, i) => {
    const timeEl = el(
      'a',
      {
        class: 'topic-time',
        href: timeUrl(report.video.url, topic.startMs),
        target: '_blank',
        rel: 'noopener noreferrer',
        title: `Open YouTube at ${fmt(topic.startMs)}`,
      },
      fmt(topic.startMs),
      inferred ? el('span', { class: 'approx', text: '≈' }) : null
    );

    const body = el('div', { class: 'topic-body' });
    body.append(
      el('div', { class: 'topic-label' },
        el('span', { class: 'topic-index', text: String(i + 1).padStart(2, '0') }),
        topic.label
      )
    );

    if (inferred && typeof topic.confidence === 'number') {
      const pct = Math.round(topic.confidence * 100);
      body.append(
        el('div', { class: 'conf' },
          el('span', { class: 'conf-bar' }, el('i', { style: `width:${pct}%` })),
          el('span', { class: 'conf-text', text: `${pct}% confident` })
        )
      );
    }

    if (inferred && topic.evidence) {
      body.append(
        el('details', { class: 'why' },
          el('summary', { text: 'Why here?' }),
          el('p', { class: 'evidence', text: `“${topic.evidence}”` })
        )
      );
    }

    list.append(
      el('li', { class: 'topic', id: `t-${Math.floor(topic.startMs / 1000)}` },
        timeEl,
        body,
        el('span', { class: `badge ${topic.tier} topic-tag`, text: topic.tier === 'verified' ? 'verified' : 'approx' })
      )
    );
  });

  const copyBtn = el('button', {
    class: 'btn', type: 'button',
    onclick: (e) => copyText(chaptersText(report), e.currentTarget),
  }, el('span', { class: 'btn-icon', html: ICON.copy }), el('span', { class: 'btn-label', text: 'Copy list' }));

  const copyLinksBtn = el('button', {
    class: 'btn ghost', type: 'button',
    onclick: (e) => copyText(timeListText(report), e.currentTarget),
    title: 'Timestamp, topic and a link that jumps to that second',
  }, el('span', { class: 'btn-icon', html: ICON.copy }), el('span', { class: 'btn-label', text: 'Copy with links' }));

  const downloadBtn = el('button', {
    class: 'btn ghost', type: 'button',
    onclick: () => {
      const text = chaptersText(report) + '\n';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `${slug(report.video.title)}-timestamps.txt` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    },
  }, el('span', { class: 'btn-icon', html: ICON.download }), el('span', { class: 'btn-label', text: '.txt' }));

  return el(
    'div',
    {},
    el('div', { class: 'topics-head' },
      el('h2', { text: inferred ? 'Topics detected (approximate starts)' : 'Topics and exact start times' }),
      el('div', { class: 'topic-actions' }, copyBtn, copyLinksBtn, downloadBtn)
    ),
    list
  );
}

function slug(text) {
  return String(text || 'timestamps').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'timestamps';
}

/* ------------------------------------------------------------------ *
 * samples
 * ------------------------------------------------------------------ */
demoToggle.addEventListener('click', () => {
  samplesPanel.hidden = !samplesPanel.hidden;
  if (!samplesPanel.hidden && !sampleGrid.childElementCount) loadSamples();
});

async function loadSamples() {
  try {
    const res = await fetch('/api/samples');
    const data = await res.json();
    for (const sample of data.samples || []) {
      sampleGrid.append(
        el('button', {
          class: 'sample-btn', type: 'button',
          onclick: () => run(null, { sample: sample.key }),
        },
          el('strong', { text: sample.name }),
          el('small', { text: sample.blurb })
        )
      );
    }
  } catch {
    sampleGrid.append(el('small', { class: 'hint', text: 'Samples unavailable.' }));
  }
}

/* ------------------------------------------------------------------ *
 * history
 * ------------------------------------------------------------------ */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function addHistory(report) {
  const items = loadHistory().filter((h) => h.id !== report.video.id);
  items.unshift({
    id: report.video.id,
    title: report.video.title,
    tier: report.accuracy.tier,
    topics: report.topicCount,
    at: Date.now(),
  });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY))); } catch {}
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */
input.focus();
