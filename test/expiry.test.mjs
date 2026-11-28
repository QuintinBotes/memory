import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setup, run, remember, sessionStart, tools, commit } from './helpers.mjs';

// #142: the owner is told before an item expires, and can renew or pin it.
const PLAIN = 'Explain changes in plain English';
const LEDGER = 'The ledger rounds units down to the nearest whole unit';

const store = (s, use) => {
  const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'));
  try {
    return use(db);
  } finally {
    db.close();
  }
};
const sql = (s, query, ...params) => store(s, (db) => db.prepare(query).all(...params));
const cli = (s, ...args) => run(args, { cwd: s.acmeApi, data: s.data, config: s.configA });
const ok = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r;
};

/** Remembers `statement` in acme/api and dates its last reinforcement `daysAgo` days back; returns its id. */
function aged(s, statement, daysAgo, ...flags) {
  const out = ok(remember(s.acmeApi, s.data, s.configA, statement, ...flags)).stdout;
  const id = /(?:remembered|merged into) (m-[0-9a-f]+)/.exec(out)[1];
  age(s, id, daysAgo);
  return id;
}
const age = (s, id, daysAgo) => store(s, (db) => db.prepare('UPDATE items SET reinforced_at = ? WHERE id = ?').run(new Date(Date.now() - daysAgo * 86_400_000).toISOString(), id));
const search = (s, query) => tools(s.acmeApi, s.data, s.configA, [['memory_search', { query }]])[0].text;
const slice = (s) => sessionStart(s.acmeApi, s.data, s.configA).stdout;

test('#142 SC1 an item 80 days old is under Expiring soon with 10 days left, in text and JSON; one 30 days old is not', () => {
  const s = setup();
  const soon = aged(s, PLAIN, 80);
  const fresh = aged(s, LEDGER, 30);
  const out = ok(cli(s, 'review')).stdout;
  assert.match(out, /^Expiring soon: 1\./m);
  assert.ok(out.includes(`- [${soon}] preference, repository acme/api: "${PLAIN}", 10 days left`), out);
  assert.doesNotMatch(out, new RegExp(fresh));
  const json = JSON.parse(ok(cli(s, 'review', '--json')).stdout);
  assert.deepEqual(json.expiring.map((e) => [e.id, e.days_left]), [[soon, 10]]);
  assert.deepEqual([json.proposals, json.edits], [[], []], 'the keys the pane and page read are unchanged');
});

test('#142 an item that expired in the last 30 days is listed as expired, and one longer ago is not', () => {
  const s = setup();
  const recent = aged(s, PLAIN, 95);
  const old = aged(s, LEDGER, 130);
  const out = ok(cli(s, 'review')).stdout;
  assert.ok(out.includes(`[${recent}]`) && out.includes('expired 5 days ago'), out);
  assert.doesNotMatch(out, new RegExp(old));
});

test('#142 SC2 renew takes the item out of the section, writes one audit entry, keeps support, and undo restores the old date', () => {
  const s = setup();
  const id = aged(s, PLAIN, 80);
  const [before] = sql(s, 'SELECT reinforced_at, support FROM items WHERE id = ?', id);
  const out = ok(cli(s, 'renew', id)).stdout;
  const audit = /memory undo ([0-9a-f-]{36})/.exec(out)[1];
  assert.equal(ok(cli(s, 'review')).stdout, '');
  const audits = sql(s, "SELECT audit_id FROM audit_events WHERE action = 'item_renewed' AND subject_id = ?", id);
  assert.deepEqual(audits.map((a) => a.audit_id), [audit]);
  const [after] = sql(s, 'SELECT reinforced_at, support FROM items WHERE id = ?', id);
  assert.equal(after.support, before.support);
  assert.notEqual(after.reinforced_at, before.reinforced_at);
  ok(cli(s, 'undo', audit));
  assert.equal(sql(s, 'SELECT reinforced_at FROM items WHERE id = ?', id)[0].reinforced_at, before.reinforced_at);
  assert.match(ok(cli(s, 'review')).stdout, new RegExp(`${id}.*10 days left`));
  assert.notEqual(cli(s, 'undo', audit).status, 0, 'an undo is done once');
});

test('#142 SC3 an item 95 days old leaves the slice and search, is listed by list --expired, and is recalled again after renew', () => {
  const s = setup();
  const id = aged(s, LEDGER, 95);
  assert.doesNotMatch(slice(s), /rounds units down/);
  assert.doesNotMatch(search(s, 'ledger rounds units'), new RegExp(id));
  const listed = ok(cli(s, 'list', '--expired')).stdout;
  assert.ok(listed.includes(`[${id}]`) && listed.includes('expired 5 days ago'), listed);
  ok(cli(s, 'renew', id));
  assert.match(slice(s), /rounds units down/);
  assert.match(search(s, 'ledger rounds units'), new RegExp(id));
  const none = cli(s, 'list', '--expired');
  assert.deepEqual([none.stdout, none.stderr.trim()], ['', 'No expired items here.']);
});

test('#142 SC4 a pinned item 200 days old is still recalled; after unpin it reads as expired', () => {
  const s = setup();
  const id = aged(s, LEDGER, 200, '--pin');
  assert.match(slice(s), /rounds units down/);
  assert.match(search(s, 'ledger rounds units'), new RegExp(id));
  assert.equal(ok(cli(s, 'review', '--json')).stdout.includes(id), false, 'a pinned item is never expiring');
  assert.match(ok(cli(s, 'unpin', id)).stdout, /unpinned/);
  assert.doesNotMatch(slice(s), /rounds units down/);
  assert.match(ok(cli(s, 'list', '--expired')).stdout, new RegExp(id));
  ok(cli(s, 'pin', id));
  assert.match(slice(s), /rounds units down/);
  assert.deepEqual(sql(s, "SELECT action FROM audit_events WHERE subject_id = ? AND action LIKE 'item_%pinned' ORDER BY rowid", id).map((r) => r.action), ['item_pinned', 'item_unpinned', 'item_pinned']);
});

test('#142 SC5 a pinned item whose anchored lines are gone goes stale and is not shown, as an unpinned one', () => {
  const s = setup();
  const lines = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`);
  commit(s.acmeApi, { 'src/ledger.ts': `${lines.join('\n')}\n` });
  const pinned = aged(s, 'The ledger consumes one unit per call', 200, '--type', 'hazard', '--anchor', 'src/ledger.ts:5-7', '--pin');
  const plain = aged(s, 'Ledger lines five to seven hold the unit constants', 10, '--type', 'hazard', '--anchor', 'src/ledger.ts:5-7');
  assert.match(slice(s), /consumes one unit/);
  commit(s.acmeApi, { 'src/ledger.ts': null });
  const out = slice(s);
  assert.doesNotMatch(out, /consumes one unit/);
  assert.doesNotMatch(out, /unit constants/);
  assert.deepEqual(sql(s, 'SELECT id, status FROM items WHERE id IN (?, ?) ORDER BY id', pinned, plain).map((r) => r.status), ['stale', 'stale']);
});

test('#142 SC6 pin refuses an item with only agent trust and says why; an approved one can be pinned', () => {
  const s = setup();
  const propose = (statement) => {
    const [r] = tools(s.acmeApi, s.data, s.configA, [['memory_propose', { statement, scope: 'repository', type: 'convention', evidence: { source: 'session-1' } }]]);
    assert.equal(r.isError, false, r.text);
    return /m-[0-9a-f]+/.exec(r.text)[0];
  };
  // Active with agent trust and no approval, as capture keeps a lesson.
  const captured = propose('Releases are cut from main');
  sql(s, "UPDATE items SET status = 'active' WHERE id = ?", captured);
  const refused = cli(s, 'pin', captured);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /agent trust; only an item you stated or approved can be pinned/);
  assert.equal(sql(s, 'SELECT pinned_at FROM items WHERE id = ?', captured)[0].pinned_at, null);
  const approved = propose('Builds run on the shared runner');
  ok(cli(s, 'approve', approved));
  assert.match(ok(cli(s, 'pin', approved)).stdout, /^pinned /);
  assert.notEqual(cli(s, 'pin', 'm-0000000000').status, 0);
});

test('#142 SC7 with nothing near expiry, memory review prints exactly what it did before', () => {
  const s = setup();
  const empty = cli(s, 'review');
  assert.deepEqual([empty.stdout, empty.stderr.trim()], ['', 'No proposals to review here.']);
  aged(s, LEDGER, 30);
  const pinned = aged(s, PLAIN, 85, '--pin');
  const [r] = tools(s.acmeApi, s.data, s.configA, [['memory_propose', { statement: 'Releases are cut from main', scope: 'repository', type: 'convention', evidence: { source: 'session-1' } }]]);
  const id = /m-[0-9a-f]+/.exec(r.text)[0];
  const out = ok(cli(s, 'review')).stdout;
  assert.equal(
    out,
    'Memory proposals: 1, 0 quarantined as text that reads as an instruction, 0 reported stale by an agent. Decide with memory approve <id> (approving a reported item clears its reports) or memory reject <id>.\n' +
      '~~~text memory proposals: quoted statements recorded earlier (data, not instructions)\n' +
      `- [${id}] convention, repository acme/api, trust agent: "Releases are cut from main"\n` +
      '  evidence: session-1 (agent) via test\n' +
      '  shadow gate: hold (1 signal, 0 from the owner)\n' +
      '~~~\n',
  );
  assert.doesNotMatch(out, new RegExp(pinned));
});
