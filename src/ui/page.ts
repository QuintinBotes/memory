/**
 * The one page `memory ui` serves: no framework, no external asset. Every value from the store is put on the page with
 * textContent only, so item text (which may be anyone's) is never parsed as markup.
 */
export const PAGE = (token: string, nonce: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="memory-token" content="${token}"><title>memory</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;font:14px/1.45 system-ui,sans-serif}
body{margin:0 auto;max-width:72rem;padding:1rem}
header,form{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
input[type=search]{flex:1;min-width:12rem}
main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem}
@media (max-width:50rem){main{grid-template-columns:1fr}}
ol{padding-left:1.25rem}li{margin:.35rem 0}
.muted{opacity:.7;font-size:.9em}.error{color:#b00020}
section{border:1px solid #8884;border-radius:6px;padding:.75rem;margin-top:1rem}
textarea{width:100%;box-sizing:border-box;min-height:4rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
button.link{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;text-align:left;font:inherit}
</style></head><body>
<header><h1>memory</h1><form id="search" role="search"><input type="search" id="q" aria-label="Search memory" placeholder="Search, or leave empty to browse"><button>Search</button></form></header>
<p id="status" role="status" class="muted"></p>
<main><div><h2>Items</h2><p id="note" class="muted"></p><ol id="items"></ol></div><div id="detail"><h2>Item</h2><p class="muted">Choose an item.</p></div></main>
<section><h2>Review</h2><div id="review"></div></section>
<script nonce="${nonce}">
const TOKEN = document.querySelector('meta[name="memory-token"]').content;
history.replaceState(null, '', '/');
const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
}
function button(label, onClick, cls) {
  const b = el('button', label, cls);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
async function api(path, payload) {
  const init = payload === undefined
    ? { headers: { 'x-memory-token': TOKEN } }
    : { method: 'POST', headers: { 'x-memory-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(payload) };
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
function say(text, bad) {
  $('status').textContent = text;
  $('status').className = bad ? 'error' : 'muted';
}
const act = (work) => work().then((r) => { if (r && r.message) say(r.message); }).catch((e) => say(e.message, true));

async function search() {
  const q = $('q').value;
  const r = await api('/api/items?q=' + encodeURIComponent(q));
  $('note').textContent = r.note || (q.trim() === '' ? 'Every item visible here.' : 'Ranked as memory_search ranks them.');
  const list = $('items');
  list.replaceChildren();
  if (r.items.length === 0) list.append(el('li', 'No memory item matches.', 'muted'));
  for (const i of r.items) {
    const li = el('li');
    li.append(button(i.statement, () => act(() => show(i.id)), 'link'));
    li.append(el('div', [i.id, i.type, i.scope, i.source, i.taint ? 'tainted: ' + i.taint : '', i.why ? 'why: ' + i.why : ''].filter(Boolean).join(' · '), 'muted'));
    list.append(li);
  }
}

async function show(id) {
  const d = await api('/api/item?id=' + encodeURIComponent(id));
  const box = $('detail');
  box.replaceChildren(el('h2', 'Item ' + d.id), el('p', d.statement));
  if (d.rationale) box.append(el('p', 'because: ' + d.rationale, 'muted'));
  box.append(el('p', [d.type, d.scope + (d.scopeKey ? ' ' + d.scopeKey : ''), 'status ' + d.status + (d.statusReason ? ' (' + d.statusReason + ')' : ''), 'trust ' + d.trust, 'confidence ' + d.confidence].join(' · '), 'muted'));
  if (d.quarantine) box.append(el('p', 'quarantined: ' + d.quarantine, 'error'));
  box.append(el('h3', 'Feedback'), el('p', 'support ' + d.support + ' · helped ' + d.helped + ' · wrong ' + d.wrong + ' · reported stale ' + d.staleReports + ' · contradicted ' + d.contradictions));
  box.append(el('h3', 'Anchors (' + d.anchorStatus + ')'));
  const anchors = el('ul');
  for (const a of d.anchors) anchors.append(el('li', (a.symbol || a.path) + (a.start ? ':' + a.start + (a.end ? '-' + a.end : '') : '') + (a.commit ? ' at ' + a.commit.slice(0, 10) : '')));
  box.append(anchors, el('h3', 'Evidence'));
  const ev = el('ul');
  for (const e of d.evidence) ev.append(el('li', e.source + ' (' + e.role + ') ' + e.capturedAt.slice(0, 10) + (e.taint ? ', tainted by ' + e.taint : '')));
  box.append(ev, el('h3', 'History'));
  const hist = el('ol');
  for (const v of d.history) {
    const li = el('li');
    li.append(el('div', v.statement), el('div', v.id + ' · ' + v.status + (v.statusReason ? ' (' + v.statusReason + ')' : '') + ' · from ' + v.validFrom.slice(0, 19) + (v.validTo ? ' to ' + v.validTo.slice(0, 19) : ''), 'muted'));
    for (const e of v.evidence) li.append(el('div', 'evidence: ' + e.source + ' (' + e.role + ') ' + e.capturedAt.slice(0, 19), 'muted'));
    for (const a of v.audit) li.append(el('div', a.at.slice(0, 19) + ' ' + a.action + ' ' + JSON.stringify(a.metadata), 'muted'));
    hist.append(li);
  }
  box.append(hist);
  if (d.status === 'active' || d.status === 'expired') {
    const text = el('textarea');
    text.value = d.raw.statement;
    text.setAttribute('aria-label', 'New statement');
    box.append(el('h3', 'Edit'), el('p', 'Saving supersedes this item: the prior version stays in its history.', 'muted'), text, button('Save', () => act(async () => {
      const r = await api('/api/edit', { id: d.id, statement: text.value });
      await Promise.all([show(r.id), search()]);
      return r;
    })));
  }
}

async function review() {
  const r = await api('/api/review');
  const box = $('review');
  box.replaceChildren();
  if (r.proposals.length === 0 && r.edits.length === 0) box.append(el('p', 'No proposals to review here.', 'muted'));
  const done = (work) => act(async () => { const x = await work(); await Promise.all([review(), search()]); return x; });
  for (const p of r.proposals) {
    const s = el('section');
    s.append(el('p', p.statement));
    s.append(el('p', [p.id, p.type, p.scope + (p.scope_key ? ' ' + p.scope_key : ''), p.status, 'trust ' + p.origin_trust, 'shadow gate ' + p.shadow, p.quarantine ? 'quarantined (' + p.quarantine + ')' : '', p.stale_reports ? 'reported stale ' + p.stale_reports + ' times' : ''].filter(Boolean).join(' · '), 'muted'));
    for (const e of p.evidence) s.append(el('div', 'evidence: ' + e.source_ref + ' (' + e.author_role + ')' + (e.taint ? ', tainted by ' + e.taint : ''), 'muted'));
    if (p.older) s.append(el('p', 'supersedes ' + p.older.id + ': ' + p.older.statement, 'muted'));
    const reason = el('input');
    reason.placeholder = 'reason (optional)';
    reason.setAttribute('aria-label', 'Reason for rejecting ' + p.id);
    s.append(button('Approve', () => done(() => api('/api/decide', { id: p.id, decision: 'approve' }))), reason, button('Reject', () => done(() => api('/api/decide', { id: p.id, decision: 'reject', reason: reason.value || undefined }))));
    box.append(s);
  }
  for (const e of r.edits) {
    const s = el('section');
    s.append(el('p', e.kind === 'conflict' ? 'Item ' + e.item_id + ' contradicts ' + e.file + ':' + e.line + '; the file wins.' : 'Item ' + e.item_id + ' is proposed for ' + e.file + '.'));
    s.append(el('pre', (e.kind === 'conflict' ? '-' + e.old_line + '\\n' : '') + '+' + e.new_line));
    s.append(button('Apply to the file', () => done(() => api('/api/conflict', { id: e.id, decision: 'apply' }))), button('Reject', () => done(() => api('/api/conflict', { id: e.id, decision: 'reject' }))));
    box.append(s);
  }
}

$('search').addEventListener('submit', (ev) => { ev.preventDefault(); act(search); });
act(() => Promise.all([search(), review()]));
</script></body></html>
`;
