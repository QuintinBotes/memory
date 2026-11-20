import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { setup, remember, sessionStart, run, commit } from './helpers.mjs';

const HAZARD = 'The ledger consumes one unit per call';
const NOTE = 'Ledger changes need a migration note';
/** Thirty distinct lines; the anchor cites lines 10 to 12. */
const file = (lines = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`)) => `${lines.join('\n')}\n`;
const base = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`);

function anchored() {
  const s = setup();
  commit(s.acmeApi, { 'src/ledger.ts': file() });
  const r = remember(s.acmeApi, s.data, s.configA, HAZARD, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/ledger.ts:10-12');
  assert.equal(r.status, 0, r.stderr);
  s.id = /remembered (m-[0-9a-f]+)/.exec(r.stdout)[1];
  assert.equal(remember(s.acmeApi, s.data, s.configA, NOTE, '--scope', 'repository').status, 0);
  return s;
}

function item(s) {
  const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'), { readOnly: true });
  const row = db.prepare('SELECT status, status_reason, anchors_json FROM items WHERE id = ?').get(s.id);
  const audits = db.prepare("SELECT action FROM audit_events WHERE subject_id = ? AND action IN ('item_stale', 'item_restored')").all(s.id).map((r) => r.action);
  db.close();
  return { ...row, anchor: JSON.parse(row.anchors_json)[0], audits };
}

const recheck = (s, ...args) => run(['recheck', ...args], { cwd: s.acmeApi, data: s.data, config: s.configA });

test('an item whose cited file is deleted at HEAD is stale and leaves the slice', () => {
  const s = anchored();
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, new RegExp(HAZARD));
  commit(s.acmeApi, { 'src/ledger.ts': null });
  const out = sessionStart(s.acmeApi, s.data, s.configA).stdout;
  assert.doesNotMatch(out, new RegExp(HAZARD));
  assert.match(out, new RegExp(NOTE), 'an item with no anchor is never made stale');
  const it = item(s);
  assert.equal(it.status, 'stale');
  assert.equal(it.status_reason, 'path gone');
  assert.deepEqual(it.audits, ['item_stale']);
});

test('an item whose cited lines change at HEAD is stale', () => {
  const s = anchored();
  const changed = [...base];
  changed[10] = 'const line11 = 1100;';
  commit(s.acmeApi, { 'src/ledger.ts': file(changed) });
  assert.doesNotMatch(sessionStart(s.acmeApi, s.data, s.configA).stdout, new RegExp(HAZARD));
  assert.equal(item(s).status_reason, 'cited text gone');
});

test('cited lines that moved stay active and the anchor follows them', () => {
  const s = anchored();
  commit(s.acmeApi, { 'src/ledger.ts': file([...Array.from({ length: 5 }, (_, i) => `// added ${i}`), ...base]) });
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /src\/ledger\.ts:15-17/);
  const it = item(s);
  assert.equal(it.status, 'active');
  assert.deepEqual([it.anchor.start, it.anchor.end], [15, 17]);
});

test('the nearest copy of the cited lines wins', () => {
  const s = anchored();
  const block = base.slice(9, 12);
  commit(s.acmeApi, { 'src/ledger.ts': file(['// a', '// b', ...base, ...block]) });
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.deepEqual([item(s).anchor.start, item(s).anchor.end], [12, 14]);
});

test('cited lines that moved more than 50 lines are stale', () => {
  const s = anchored();
  commit(s.acmeApi, { 'src/ledger.ts': file([...Array.from({ length: 60 }, (_, i) => `// pad ${i}`), ...base]) });
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(item(s).status, 'stale');
});

test('an uncommitted change does not make an item stale', () => {
  const s = anchored();
  rmSync(join(s.acmeApi, 'src', 'ledger.ts'));
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, new RegExp(HAZARD));
  assert.equal(item(s).status, 'active');
});

test('memory recheck restores a stale item once its citation holds again', () => {
  const s = anchored();
  commit(s.acmeApi, { 'src/ledger.ts': null });
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(item(s).status, 'stale');
  commit(s.acmeApi, { 'src/ledger.ts': file() });
  const r = recheck(s, s.id);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"restored": 1/);
  assert.equal(item(s).status, 'active');
  assert.deepEqual(item(s).audits, ['item_stale', 'item_restored']);
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, new RegExp(HAZARD));
});

test('memory recheck with no id checks every anchored item here', () => {
  const s = anchored();
  commit(s.acmeApi, { 'src/ledger.ts': null });
  const r = recheck(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"stale": 1/);
  assert.equal(item(s).status, 'stale');
});

test('a whole-file anchor goes stale when the file changes', () => {
  const s = setup();
  const r = remember(s.acmeApi, s.data, s.configA, 'The readme names the service', '--scope', 'repository', '--anchor', 'README.md');
  assert.equal(r.status, 0, r.stderr);
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /The readme names the service \(README\.md\)/);
  commit(s.acmeApi, { 'README.md': '# renamed\n' });
  assert.doesNotMatch(sessionStart(s.acmeApi, s.data, s.configA).stdout, /The readme names the service/);
});

test('recheck needs a tenant and an existing id', () => {
  const s = anchored();
  assert.equal(run(['recheck'], { cwd: s.loose, data: s.data, config: s.configA }).status, 1);
  assert.equal(recheck(s, 'm-0000000000').status, 1);
});
