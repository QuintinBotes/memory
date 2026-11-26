/**
 * The one page `memory ui` serves: no framework, no external asset. Every value from the store is put on the page with
 * textContent only, so item text (which may be anyone's) is never parsed as markup.
 */
export const PAGE = (token: string, nonce: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="memory-token" content="${token}"><title>memory</title>
<style nonce="${nonce}">
:root{
  color-scheme:light;
  --bg:#f6f7f9;--panel:#fff;--sunk:#f0f2f5;--line:#e3e6eb;--ink:#14171c;--ink2:#4b5361;--ink3:#7a8392;
  --accent:#4f46e5;--accent-ink:#fff;--accent-soft:#eef0ff;--ok:#0f7b4b;--ok-soft:#e5f5ed;--bad:#c0262d;--bad-soft:#fdecec;--warn:#9a5b00;--warn-soft:#fff4e0;
  --radius:10px;--shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  color-scheme:dark;
  --bg:#0e1116;--panel:#161a21;--sunk:#1c212a;--line:#272d38;--ink:#e8ebf0;--ink2:#b3bac6;--ink3:#7d8696;
  --accent:#8b85ff;--accent-ink:#0e1116;--accent-soft:#25244a;--ok:#4cc58a;--ok-soft:#14301f;--bad:#ff6b6b;--bad-soft:#3a1719;--warn:#f0b35a;--warn-soft:#3a2a12;
  --shadow:0 1px 2px rgba(0,0,0,.4);
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink)}
button,input,textarea{font:inherit;color:inherit}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.bar{max-width:80rem;margin:0 auto;padding:.75rem 1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:650;font-size:1.05rem;letter-spacing:-.01em}
.mark{width:1.6rem;height:1.6rem;border-radius:7px;background:linear-gradient(135deg,var(--accent),#22b8cf);display:grid;place-items:center;color:#fff;font-size:.85rem;font-weight:700}
form.search{flex:1;min-width:14rem;position:relative}
form.search input{width:100%;padding:.55rem .8rem .55rem 2.1rem;border:1px solid var(--line);border-radius:8px;background:var(--panel);outline:none}
form.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
form.search .glass{position:absolute;left:.7rem;top:50%;transform:translateY(-50%);color:var(--ink3);pointer-events:none}
form.search kbd{position:absolute;right:.6rem;top:50%;transform:translateY(-50%)}
kbd{font:11px ui-monospace,monospace;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 .3rem;color:var(--ink3);background:var(--sunk)}
.tabs{display:flex;gap:.25rem;background:var(--sunk);padding:.2rem;border-radius:9px}
.tab{border:0;background:none;padding:.35rem .8rem;border-radius:7px;cursor:pointer;color:var(--ink2);display:flex;gap:.4rem;align-items:center}
.tab[aria-selected=true]{background:var(--panel);color:var(--ink);box-shadow:var(--shadow)}
.count{font-size:.75rem;padding:0 .4rem;border-radius:99px;background:var(--line);color:var(--ink2)}
.count.hot{background:var(--accent);color:var(--accent-ink)}
.wrap{max-width:80rem;margin:0 auto;padding:1rem}
.grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:1rem;align-items:start}
@media (max-width:56rem){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.listhead{display:flex;justify-content:space-between;align-items:baseline;padding:.1rem .2rem .6rem;color:var(--ink3);font-size:.85rem}
.cards{display:flex;flex-direction:column;gap:.5rem;margin:0;padding:0;list-style:none}
.card{display:block;width:100%;text-align:left;cursor:pointer;padding:.75rem .9rem;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);transition:border-color .12s,box-shadow .12s}
.card:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.card[aria-current=true]{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.card .text{font-weight:520;margin-bottom:.45rem}
.chips{display:flex;flex-wrap:wrap;gap:.3rem;align-items:center}
.chip{font-size:.72rem;padding:.05rem .45rem;border-radius:99px;background:var(--sunk);color:var(--ink2);border:1px solid var(--line);white-space:nowrap}
.chip.accent{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.chip.ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}
.chip.bad{background:var(--bad-soft);color:var(--bad);border-color:transparent}
.chip.warn{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem}
.why{margin-top:.4rem;color:var(--ink3);font-size:.75rem}
.detail{position:sticky;top:4.75rem;max-height:calc(100vh - 6rem);overflow:auto;padding:1.25rem}
.detail h2{margin:0 0 .25rem;font-size:1.15rem;line-height:1.4;letter-spacing:-.01em}
.detail h3{margin:1.25rem 0 .5rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}
.because{color:var(--ink2);margin:.35rem 0 0}
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.4rem}
.stat{background:var(--sunk);border-radius:8px;padding:.5rem .6rem}
.stat b{display:block;font-size:1.1rem}
.stat span{font-size:.72rem;color:var(--ink3)}
ul.plain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.35rem}
.anchor{display:inline-block;background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:.1rem .45rem}
.timeline{list-style:none;margin:0;padding:0 0 0 1rem;border-left:2px solid var(--line)}
.timeline li{position:relative;padding:0 0 .9rem .6rem}
.timeline li::before{content:"";position:absolute;left:-1.42rem;top:.4rem;width:.65rem;height:.65rem;border-radius:50%;background:var(--panel);border:2px solid var(--ink3)}
.timeline li.current::before{border-color:var(--accent);background:var(--accent)}
.sub{color:var(--ink3);font-size:.78rem}
.btn{border:1px solid var(--line);background:var(--panel);padding:.4rem .85rem;border-radius:8px;cursor:pointer;font-weight:520}
.btn:hover{background:var(--sunk)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.ok{background:var(--ok);border-color:var(--ok);color:#fff}
.btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
.btn.danger:hover{background:var(--bad-soft)}
.btn:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
textarea,input.field{width:100%;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--panel);outline:none}
textarea{min-height:5.5rem;resize:vertical}
textarea:focus,input.field:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input.field{flex:1;min-width:10rem;width:auto}
.alert{padding:.6rem .8rem;border-radius:8px;background:var(--bad-soft);color:var(--bad);margin-top:.75rem}
.empty{padding:2.5rem 1rem;text-align:center;color:var(--ink3)}
.empty b{display:block;color:var(--ink2);font-size:1rem;margin-bottom:.25rem}
.reviews{display:grid;grid-template-columns:repeat(auto-fill,minmax(22rem,1fr));gap:.75rem}
.review{padding:1rem;display:flex;flex-direction:column;gap:.6rem}
.review .text{font-size:1rem;font-weight:520}
.diff{margin:0;font:12px/1.5 ui-monospace,monospace;background:var(--sunk);border-radius:8px;padding:.6rem .75rem;white-space:pre-wrap;overflow-wrap:anywhere}
.diff .del{color:var(--bad)}.diff .add{color:var(--ok)}
.toast{position:fixed;left:50%;bottom:1.25rem;transform:translateX(-50%) translateY(150%);transition:transform .2s;background:var(--ink);color:var(--bg);padding:.6rem 1rem;border-radius:9px;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:min(40rem,calc(100vw - 2rem));z-index:10}
.toast.show{transform:translateX(-50%) translateY(0)}
.toast.bad{background:var(--bad);color:#fff}
[hidden]{display:none!important}
</style></head><body>
<div class="top"><div class="bar">
  <div class="brand"><span class="mark" aria-hidden="true">m</span>memory</div>
  <form class="search" id="search" role="search"><span class="glass" aria-hidden="true">⌕</span><input type="search" id="q" aria-label="Search memory" placeholder="Search memory…" autocomplete="off"><kbd aria-hidden="true">/</kbd></form>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" id="tab-items" aria-selected="true" aria-controls="view-items">Items <span class="count" id="n-items">0</span></button>
    <button class="tab" role="tab" id="tab-review" aria-selected="false" aria-controls="view-review">Review <span class="count" id="n-review">0</span></button>
  </div>
</div></div>
<div class="wrap">
  <section id="view-items" role="tabpanel" aria-labelledby="tab-items">
    <div class="grid">
      <div><div class="listhead"><span id="note"></span></div><ul class="cards" id="items"></ul></div>
      <aside class="panel detail" id="detail" aria-live="polite"></aside>
    </div>
  </section>
  <section id="view-review" role="tabpanel" aria-labelledby="tab-review" hidden><div class="reviews" id="review"></div></section>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}">
const TOKEN = document.querySelector('meta[name="memory-token"]').content;
const $ = (id) => document.getElementById(id);
/** An element with text set through textContent only, and children appended. */
function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== undefined && k !== null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
function button(label, onClick, cls) {
  const b = el('button', cls || 'btn', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
const chip = (text, tone) => el('span', 'chip' + (tone ? ' ' + tone : ''), text);
const date = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
async function api(path, payload) {
  const init = payload === undefined
    ? { headers: { 'x-memory-token': TOKEN } }
    : { method: 'POST', headers: { 'x-memory-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(payload) };
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
let toastTimer;
function say(text, bad) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, bad ? 7000 : 3500);
}
const act = (work) => work().then((r) => { if (r && r.message) say(r.message); }).catch((e) => say(e.message, true));

const TONE = { active: 'ok', proposed: 'accent', superseded: '', rejected: 'bad', expired: 'warn', high: 'ok', medium: 'accent', low: 'warn' };
let selected = null;

function emptyDetail() {
  $('detail').replaceChildren(el('div', 'empty', el('b', null, 'Nothing selected'), 'Choose an item to see its evidence, anchors and history.'));
}

async function search() {
  const q = $('q').value.trim();
  const r = await api('/api/items?q=' + encodeURIComponent(q));
  $('n-items').textContent = q === '' ? String(r.items.length) : $('n-items').textContent;
  $('note').textContent = r.note || (q === '' ? r.items.length + ' items visible here' : r.items.length + ' ranked as memory_search ranks them');
  const list = $('items');
  list.replaceChildren();
  if (r.items.length === 0) list.append(el('li', 'empty panel', el('b', null, q === '' ? 'No items yet' : 'No item matches'), q === '' ? 'Items you remember or approve show up here.' : 'Try other words, or clear the search to browse.'));
  for (const i of r.items) {
    const card = el('button', 'card', el('div', 'text', i.statement), el('div', 'chips', chip(i.type, 'accent'), chip(i.scope), i.taint ? chip('tainted: ' + i.taint, 'bad') : null, el('span', 'sub mono', i.id)), i.why ? el('div', 'why', i.why) : null);
    card.type = 'button';
    card.dataset.id = i.id;
    card.setAttribute('aria-current', String(i.id === selected));
    card.addEventListener('click', () => act(() => show(i.id)));
    list.append(el('li', null, card));
  }
}

async function show(id) {
  const d = await api('/api/item?id=' + encodeURIComponent(id));
  selected = d.id;
  for (const c of document.querySelectorAll('.card')) c.setAttribute('aria-current', String(c.dataset.id === d.id));
  const box = $('detail');
  box.replaceChildren(
    el('div', 'chips', chip(d.status, TONE[d.status]), chip(d.type, 'accent'), chip(d.scope + (d.scopeKey ? ' · ' + d.scopeKey : '')), chip('confidence ' + d.confidence, TONE[d.confidence]), chip('trust ' + d.trust), el('span', 'sub mono', d.id)),
    el('h2', null, d.statement),
    d.rationale ? el('p', 'because', 'Because ' + d.rationale) : null,
    d.statusReason ? el('p', 'sub', d.statusReason) : null,
    d.quarantine ? el('div', 'alert', 'Quarantined: ' + d.quarantine) : null,
  );
  const stat = (n, label) => el('div', 'stat', el('b', null, n), el('span', null, label));
  box.append(el('h3', null, 'Feedback'), el('div', 'stats', stat(d.support, 'support'), stat(d.helped, 'helped'), stat(d.wrong, 'wrong'), stat(d.staleReports, 'stale'), stat(d.contradictions, 'contradicted')));
  if (d.anchors.length > 0) {
    box.append(el('h3', null, 'Anchors · ' + d.anchorStatus));
    box.append(el('ul', 'plain', ...d.anchors.map((a) => el('li', null, el('span', 'anchor mono', (a.symbol || a.path) + (a.start ? ':' + a.start + (a.end ? '-' + a.end : '') : '')), a.commit ? el('span', 'sub', '  at ' + a.commit.slice(0, 10)) : null))));
  }
  box.append(el('h3', null, 'Evidence'), el('ul', 'plain', ...d.evidence.map((e) => el('li', null, el('span', 'mono', e.source), el('span', 'sub', '  ' + e.role + ' · ' + date(e.capturedAt)), e.agent ? chip('via ' + e.agent, 'accent') : null, e.taint ? chip('tainted: ' + e.taint, 'bad') : null))));
  box.append(el('h3', null, 'History'));
  const tl = el('ol', 'timeline');
  for (const v of [...d.history].reverse()) {
    const li = el('li', v.id === d.id ? 'current' : null, el('div', null, v.statement), el('div', 'sub', el('span', 'mono', v.id), ' · ' + v.status + (v.statusReason ? ' (' + v.statusReason + ')' : '') + ' · ' + date(v.validFrom) + (v.validTo ? ' → ' + date(v.validTo) : '')));
    for (const a of v.audit) li.append(el('div', 'sub', date(a.at) + ' · ' + a.action.replaceAll('_', ' ')));
    tl.append(li);
  }
  box.append(tl);
  if (d.status === 'active' || d.status === 'expired') {
    const text = el('textarea');
    text.value = d.raw.statement;
    text.setAttribute('aria-label', 'New statement');
    const save = button('Save new version', () => act(async () => {
      const r = await api('/api/edit', { id: d.id, statement: text.value });
      await Promise.all([search(), show(r.id)]);
      return r;
    }), 'btn primary');
    const editor = el('div', null, text, el('p', 'sub', 'Saving supersedes this item; the current version stays in its history.'), el('div', 'row', save, button('Cancel', () => { editor.hidden = true; open.hidden = false; })));
    editor.hidden = true;
    const open = button('Edit statement', () => { editor.hidden = false; open.hidden = true; text.focus(); });
    box.append(el('h3', null, 'Edit'), open, editor);
  }
}

async function review() {
  const r = await api('/api/review');
  const n = r.proposals.length + r.edits.length;
  $('n-review').textContent = String(n);
  $('n-review').className = 'count' + (n > 0 ? ' hot' : '');
  const box = $('review');
  box.replaceChildren();
  if (n === 0) box.append(el('div', 'empty panel', el('b', null, 'All caught up'), 'No proposals or instruction-file edits wait for review.'));
  const done = (work) => act(async () => { const x = await work(); await Promise.all([review(), search()]); return x; });
  for (const p of r.proposals) {
    const reason = el('input', 'field');
    reason.placeholder = 'Reason for rejecting (optional)';
    reason.setAttribute('aria-label', 'Reason for rejecting ' + p.id);
    box.append(el('article', 'panel review',
      el('div', 'chips', chip('proposal', 'accent'), chip(p.type), chip(p.scope + (p.scope_key ? ' · ' + p.scope_key : '')), chip('trust ' + p.origin_trust), p.quarantine ? chip('quarantined: ' + p.quarantine, 'bad') : null, p.stale_reports ? chip('reported stale ×' + p.stale_reports, 'warn') : null),
      el('div', 'text', p.statement),
      p.older ? el('div', 'sub', 'Replaces: ' + p.older.statement) : null,
      el('div', 'sub', ...p.evidence.map((e) => e.source_ref + ' (' + e.author_role + ')' + (e.agent ? ' via ' + e.agent : '') + (e.taint ? ', tainted by ' + e.taint : '') + '  ')),
      el('div', 'sub mono', p.id + ' · shadow gate ' + p.shadow),
      el('div', 'row', button('Approve', () => done(() => api('/api/decide', { id: p.id, decision: 'approve' })), 'btn ok'), reason, button('Reject', () => done(() => api('/api/decide', { id: p.id, decision: 'reject', reason: reason.value || undefined })), 'btn danger')),
    ));
  }
  for (const e of r.edits) {
    const diff = el('pre', 'diff');
    if (e.kind === 'conflict') diff.append(el('span', 'del', '- ' + e.old_line), '\\n');
    diff.append(el('span', 'add', '+ ' + e.new_line));
    box.append(el('article', 'panel review',
      el('div', 'chips', chip(e.kind === 'conflict' ? 'conflict' : 'instruction edit', 'warn'), el('span', 'mono sub', e.file + (e.line ? ':' + e.line : ''))),
      el('div', 'text', e.kind === 'conflict' ? 'Item ' + e.item_id + ' contradicts this line; the file wins until you choose.' : 'Item ' + e.item_id + ' is proposed for this file.'),
      diff,
      el('div', 'row', button('Apply to the file', () => done(() => api('/api/conflict', { id: e.id, decision: 'apply' })), 'btn primary'), button('Reject', () => done(() => api('/api/conflict', { id: e.id, decision: 'reject' })), 'btn danger')),
    ));
  }
}

function tab(name) {
  for (const t of ['items', 'review']) {
    $('tab-' + t).setAttribute('aria-selected', String(t === name));
    $('view-' + t).hidden = t !== name;
  }
}
$('tab-items').addEventListener('click', () => tab('items'));
$('tab-review').addEventListener('click', () => tab('review'));
let typing;
$('q').addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => act(search), 200); });
$('search').addEventListener('submit', (ev) => { ev.preventDefault(); tab('items'); act(search); });
document.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && document.activeElement !== $('q') && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { ev.preventDefault(); $('q').focus(); }
  if (ev.key === 'Escape' && document.activeElement === $('q')) { $('q').value = ''; act(search); }
});
emptyDetail();
act(() => Promise.all([search(), review()]));
</script></body></html>
`;
