'use strict';

const $ = (sel) => document.querySelector(sel);
const form = $('#form');
const input = $('#url');
const go = $('#go');
const alertBox = $('#alert');
const resultEl = $('#result');
const historyWrap = $('#history-wrap');
const historyList = $('#history');
const clearHistoryBtn = $('#clear-history');

const HISTORY_KEY = 'li.history.v1';
const MAX_HISTORY = 8;

/* ---------------- tiny DOM helper (keeps user data out of innerHTML) ------ */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only ever used with static markup
    else if (k === 'dataset') Object.assign(node.dataset, v);
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
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0012.5 3H6a2.5 2.5 0 00-2.5 2.5V13A2.5 2.5 0 006 15.5"/></svg>',
  open: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8"/><path d="M18 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h5"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
};

/* ---------------- ui state ---------------- */
function setLoading(on) {
  go.classList.toggle('loading', on);
  go.disabled = on;
  go.querySelector('.label').textContent = on ? 'Resolving' : 'Resolve';
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

/* ---------------- textarea autogrow ---------------- */
function autogrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
input.addEventListener('input', autogrow);

/* ---------------- submit ---------------- */
form.addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});

$('#demo').addEventListener('click', () => run(null, { demo: true }));

input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run();
  }
});

let inFlight = null;

async function run(rawValue, { demo = false } = {}) {
  const value = rawValue ?? input.value;
  if (!demo && !value.trim()) {
    showAlert('Paste a link first.');
    input.focus();
    return;
  }
  if (!demo && rawValue != null) {
    input.value = rawValue;
    autogrow();
  }

  clearAlert();
  setLoading(true);
  resultEl.hidden = true;

  if (inFlight) inFlight.abort();
  inFlight = new AbortController();

  try {
    const res = await fetch(demo ? '/api/demo' : '/api/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: demo ? '{}' : JSON.stringify({ url: value }),
      signal: inFlight.signal,
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok === false) {
      let msg = (data && data.error) || `Lookup failed (HTTP ${res.status}).`;
      if (data && data.code === 'RATE_LIMITED') {
        showAlert(msg, 'soft');
        return;
      }
      if (data && data.code === 'FETCH_FAILED') {
        msg += ' If this is a hosted preview, it may have no outbound internet access.';
      }
      showAlert(msg);
      return;
    }

    render(data);
    if (!data.demo) addHistory(data);
  } catch (err) {
    if (err.name === 'AbortError') return;
    showAlert("Couldn't reach the resolver. Is the server running?");
  } finally {
    setLoading(false);
    inFlight = null;
  }
}

/* ---------------- copy ---------------- */
async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // clipboard API needs https / localhost — fall back to a temp field
    const ta = el('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
  }
  if (!ok) return;
  const label = btn.querySelector('.btn-label');
  const icon = btn.querySelector('.btn-icon');
  if (!label) return;
  const prev = label.textContent;
  if (icon) icon.innerHTML = ICON.check;
  label.textContent = 'Copied';
  setTimeout(() => {
    label.textContent = prev;
    if (icon) icon.innerHTML = ICON.copy;
  }, 1600);
}

/* ---------------- render ---------------- */
function render(data) {
  const blocked = Boolean(data.blocked);
  const hasFinal = Boolean(data.finalUrl);
  const isSelf = data.finalUrl === data.entryUrl && !data.hopCount;

  const statusPill = blocked
    ? el('span', { class: 'pill warn' }, el('span', { class: 'pip' }), 'Gated')
    : el('span', { class: 'pill good' }, el('span', { class: 'pip' }), hasFinal ? 'Resolved' : 'Partial');

  const top = el(
    'div',
    { class: 'result-top' },
    statusPill,
    el('span', { class: 'timing', text: `${data.hopCount} redirect${data.hopCount === 1 ? '' : 's'} · ${(data.elapsedMs / 1000).toFixed(1)}s` })
  );

  const finalUrl = data.finalUrl || '';

  const copyBtn = el('button', { class: 'btn', type: 'button', onclick: (e) => copyText(finalUrl, e.currentTarget) },
    el('span', { class: 'btn-icon', html: ICON.copy }),
    el('span', { class: 'btn-label', text: 'Copy link' })
  );

  const openBtn = el('a', { class: 'btn primary', href: finalUrl, target: '_blank', rel: 'noopener noreferrer' },
    el('span', { class: 'btn-icon', html: ICON.open }),
    el('span', { class: 'btn-label', text: 'Open destination' })
  );

  const finalBlock = el(
    'div',
    { class: 'final-block' },
    el('div', { class: 'final-label', text: blocked ? 'Last reachable URL' : 'Final destination' }),
    el('div', { class: 'final-url', text: finalUrl || '—' }),
    el('div', { class: 'actions' }, copyBtn, hasFinal ? openBtn : null)
  );

  const facts = el(
    'dl',
    { class: 'facts' },
    fact('Destination host', data.finalHost || '—', 'mono'),
    fact('Type', data.finalFileType || 'Unknown'),
    fact('HTTP status', data.finalStatus == null ? '—' : String(data.finalStatus)),
    data.finalTitle ? fact('Page title', data.finalTitle) : null
  );

  const card = el('div', { class: 'result-card' }, top, finalBlock, facts);

  // ---- chain ----
  if (data.hops.length || data.finalUrl) {
    const chain = el('div', { class: 'chain' }, el('h3', { text: 'Redirect chain' }));

    const steps = [];
    steps.push({
      url: data.entryUrl,
      kind: 'entry',
      note: 'Short link',
      status: null,
    });
    for (const h of data.hops) {
      steps.push({ url: h.next || h.url, kind: h.kind, note: h.note, status: h.status });
    }
    if (data.finalUrl && (!steps.length || steps[steps.length - 1].url !== data.finalUrl)) {
      steps.push({ url: data.finalUrl, kind: 'final', note: 'Landed here', status: data.finalStatus });
    }

    steps.forEach((s, i) => {
      const isFinal = i === steps.length - 1;
      const prevKindLabel = {
        entry: 'Start',
        'http-redirect': 'HTTP redirect',
        'meta-refresh': 'Meta refresh',
        'js-redirect': 'Script redirect',
        'json-field': 'JSON URL',
        base64: 'Base64 link',
        'text-url': 'Text URL',
        'js-variable': 'Script variable',
        final: 'Destination',
      }[s.kind] || s.kind;

      const meta = [el('span', { class: 'tag k-' + s.kind, text: isFinal ? 'Destination' : prevKindLabel })];
      if (isFinal && prevKindLabel !== 'Destination') {
        meta.push(el('span', { class: 'tag k-' + s.kind, text: prevKindLabel }));
      }
      if (s.status) meta.push(el('span', { class: 'tag', text: 'HTTP ' + s.status }));
      if (s.note && !s.note.startsWith('HTTP')) meta.push(el('span', { class: 'tag', text: s.note }));

      chain.append(
        el(
          'div',
          { class: 'hop' + (isFinal ? ' final' : '') },
          el('div', { class: 'node', text: String(i + 1) }),
          el(
            'div',
            { class: 'hop-body' },
            el('div', { class: 'hop-url', text: s.url }),
            el('div', { class: 'hop-meta' }, ...meta)
          )
        )
      );
    });

    card.append(chain);
  }

  // ---- blocked note ----
  if (blocked) {
    card.append(
      el('div', { class: 'note' },
        el('strong', { text: data.blocked.label + ' — ' }),
        data.blocked.message
      )
    );
  }

  // ---- links found on the page ----
  if (data.anchors && data.anchors.length) {
    const anchors = el('div', { class: 'anchors' },
      el('h3', { text: `Links found on this page (${data.anchors.length})` })
    );
    const list = el('div', { class: 'anchor-list' });
    for (const a of data.anchors) {
      list.append(
        el('a', { class: 'anchor-item', href: a.url, target: '_blank', rel: 'noopener noreferrer' },
          a.host ? el('span', { class: 'ahost', text: a.host }) : null,
          el('span', { class: 'aurl', text: a.label || a.url })
        )
      );
    }
    anchors.append(list);
    card.append(anchors);
  }

  // ---- warnings / embedded destinations ----
  if (data.embedded && data.embedded.length) {
    const list = el('ul');
    for (const e of data.embedded) {
      list.append(el('li', {}, `?${e.from}= → `,
        el('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer', style: 'color:#a5b4fc', text: e.url })));
    }
    card.append(el('div', { class: 'note info' }, el('strong', { text: 'This link carries a destination inside it' }), list));
  }

  if (data.warnings && data.warnings.length && !blocked) {
    const list = el('ul');
    for (const w of data.warnings) list.append(el('li', { text: w }));
    card.append(el('div', { class: 'note info' }, el('strong', { text: 'Heads up' }), list));
  }

  // ---- demo banner ----
  if (data.demo) {
    resultEl.replaceChildren(
      el('div', { class: 'note info', style: 'margin:0 0 12px' },
        el('strong', { text: 'Demo chain — ' }),
        'This chain is served by the app itself (HTTP redirect → meta refresh → script jump). Paste a real short link above to resolve a live one.'
      ),
      card
    );
  } else {
    resultEl.replaceChildren(card);
  }

  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function fact(label, value, cls = '') {
  return el('div', { class: 'fact' },
    el('dt', { text: label }),
    el('dd', { class: cls, text: value })
  );
}

/* ---------------- history ---------------- */
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function addHistory(data) {
  const items = loadHistory().filter((h) => h.in !== data.entryUrl);
  items.unshift({ in: data.entryUrl, out: data.finalUrl, host: data.finalHost, at: Date.now() });
  const trimmed = items.slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch {}
  renderHistory(trimmed);
}

function renderHistory(items = loadHistory()) {
  historyList.replaceChildren();
  if (!items.length) {
    historyWrap.hidden = true;
    return;
  }
  historyWrap.hidden = false;
  for (const item of items) {
    historyList.append(
      el('li', {},
        el('button', { type: 'button', onclick: () => run(item.in) },
          el('span', { class: 'h-in', text: shorten(item.in, 46) }),
          el('span', { class: 'h-arrow', text: '→' }),
          el('span', { class: 'h-out', text: shorten(item.out || 'unresolved', 52) })
        )
      )
    );
  }
}

function shorten(str, max) {
  if (!str) return '';
  const s = str.replace(/^https?:\/\//, '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

clearHistoryBtn.addEventListener('click', () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
  renderHistory([]);
});

/* ---------------- boot ---------------- */
renderHistory();
autogrow();
input.focus();
