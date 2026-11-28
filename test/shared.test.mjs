// `memory share` and `memory import --shared` (#137): a repository's approved items carried to another machine by git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, remember, assemble, commit } from './helpers.mjs';

const FILE = '.memory/shared.jsonl';
const ITEMS = ['Api releases are tagged from main', 'The ledger module owns every balance write', 'Migrations run before the deploy step'];

const sql = (data, query, ...params) => {
  const db = new DatabaseSync(join(data, 'tenants/acme.sqlite'));
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
};
const ok = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const share = (s, ...flags) => run(['share', ...flags], { cwd: s.acmeApi, data: s.data, config: s.configA });
const importShared = (s, data = s.dataB, config = s.configB2, ...flags) => run(['import', '--shared', ...flags], { cwd: s.acmeApi, data, config });

/** Machine A (s.data) with three active repository items; machine B, an empty data directory of its own bound to acme. */
function machines() {
  const s = setup();
  for (const text of ITEMS) ok(remember(s.acmeApi, s.data, s.configA, text, ...(text.includes('ledger') ? ['--anchor', 'src/ledger.ts:1-3'] : [])));
  s.dataB = join(s.base, 'data-b');
  s.configB2 = join(s.base, 'config-b2');
  ok(run(['init', '--tenant', 'acme=acme/*', '--bind', 'acme', '--confirm'], { cwd: s.base, data: s.dataB, config: s.configB2 }));
  return s;
}
const shareAndCommit = (s) => {
  ok(share(s, '--yes-non-interactive'));
  commit(s.acmeApi, { [FILE]: readFileSync(join(s.acmeApi, FILE), 'utf8') }, 'share memory');
};

test('SC1 share writes one line per active repository item, the same bytes twice, and only from a terminal', () => {
  const s = machines();
  const refused = share(s);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /terminal/);
  assert.equal(existsSync(join(s.acmeApi, FILE)), false);

  const first = JSON.parse(ok(share(s, '--yes-non-interactive')).stdout);
  assert.equal(first.written, 3);
  const bytes = readFileSync(join(s.acmeApi, FILE));
  const again = JSON.parse(ok(share(s, '--yes-non-interactive')).stdout);
  assert.equal(again.changed, false);
  assert.deepEqual(readFileSync(join(s.acmeApi, FILE)), bytes);
  const lines = bytes.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.statement).sort(), [...ITEMS].sort());
  assert.deepEqual(Object.keys(lines[0]), ['id', 'type', 'statement', 'anchors', 'validFrom', 'validTo', 'supersedes', 'sources']);
  assert.deepEqual(lines.find((l) => l.statement.includes('ledger')).anchors[0].path, 'src/ledger.ts');
  // Nothing committed.
  assert.match(run(['share', '--yes-non-interactive'], { cwd: s.acmeApi, data: s.data, config: s.configA }).stderr, /Nothing was committed/);
});

test('SC4 person, organisation, quarantined items and text with an email, a handle, a credential or a committer never reach the file; the dry run counts them', () => {
  const s = machines();
  ok(remember(s.acmeApi, s.data, s.configA, 'Prefer small pull requests', '--scope', 'person'));
  ok(remember(s.acmeApi, s.data, s.configA, 'Every acme service logs in JSON', '--scope', 'organisation'));
  const planted = {
    'Quarantined placeholder': ["quarantine = 'imperative'"],
    'Email placeholder': [`statement = 'Mail ${assemble('jane.doe', '@', 'example', '.com')} on release'`],
    'Handle placeholder': [`statement = 'Ask ${assemble('@', 'janedoe')} on release'`],
    'Token placeholder': [`statement = 'The key is ${assemble('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')}'`],
    'Committer placeholder': ["statement = 'Ask Test before release'"],
  };
  for (const [text, [set]] of Object.entries(planted)) {
    ok(remember(s.acmeApi, s.data, s.configA, text));
    sql(s.data, `UPDATE items SET ${set} WHERE statement = ?`, text);
  }
  const dry = JSON.parse(ok(share(s, '--dry-run')).stdout);
  assert.equal(existsSync(join(s.acmeApi, FILE)), false, 'a dry run writes nothing');
  assert.equal(dry.written, 3);
  assert.equal(Object.values(dry.withheld).reduce((a, b) => a + b, 0), 5);
  assert.equal(dry.withheld.quarantined, 1);
  assert.equal(dry.withheld['it names a committer'], 1);
  ok(share(s, '--yes-non-interactive'));
  const text = readFileSync(join(s.acmeApi, FILE), 'utf8');
  for (const t of ['small pull requests', 'acme service', 'placeholder', 'jane', 'ghp_', 'Ask']) assert.equal(text.includes(t), false, t);
  assert.equal(text.trim().split('\n').length, 3);
});

test('SC2 SC3 on machine B the file becomes three team proposals tainted shared:acme/api, recalled only after approval; a repeat adds nothing and machine A merges evidence without support', () => {
  const s = machines();
  shareAndCommit(s);
  const report = JSON.parse(ok(importShared(s)).stdout);
  assert.equal(report.proposed, 3);
  const rows = sql(s.dataB, "SELECT id, status, origin_trust, statement FROM items WHERE statement != ''");
  assert.equal(rows.length, 3);
  for (const r of rows) assert.deepEqual([r.status, r.origin_trust], ['proposed', 'team']);
  const review = ok(run(['review'], { cwd: s.acmeApi, data: s.dataB, config: s.configB2 })).stdout;
  assert.equal(review.match(/trust team, tainted by shared:acme\/api/g).length, 3);
  const list = () => run(['list'], { cwd: s.acmeApi, data: s.dataB, config: s.configB2 }).stdout;
  for (const t of ITEMS) assert.equal(list().includes(t), false, `${t} recalled before approval`);
  ok(run(['approve', rows[0].id], { cwd: s.acmeApi, data: s.dataB, config: s.configB2 }));
  assert.ok(list().includes(rows[0].statement));

  // SC3: again on B, nothing new.
  const again = JSON.parse(ok(importShared(s)).stdout);
  assert.equal(again.proposed, 0);
  assert.equal(sql(s.dataB, "SELECT count(*) AS n FROM items WHERE statement != ''")[0].n, 3);
  // On A, each line is its own item: already known, no evidence, no taint, support stays.
  const before = sql(s.data, 'SELECT id, support FROM items ORDER BY id');
  const evidence = sql(s.data, 'SELECT * FROM evidence ORDER BY id');
  const onA = JSON.parse(ok(importShared(s, s.data, s.configA)).stdout);
  assert.deepEqual([onA.proposed, onA.merged, onA.alreadyKnown], [0, 0, 3]);
  assert.deepEqual(sql(s.data, 'SELECT id, support FROM items ORDER BY id'), before);
  assert.deepEqual(sql(s.data, 'SELECT * FROM evidence ORDER BY id'), evidence);
});

test('importing your own shared file leaves your items untainted, so promotion still proposes them', () => {
  const s = machines();
  shareAndCommit(s);
  ok(importShared(s, s.data, s.configA));
  assert.equal(sql(s.data, 'SELECT count(*) AS n FROM evidence WHERE taint IS NOT NULL')[0].n, 0);
  assert.equal(run(['list'], { cwd: s.acmeApi, data: s.data, config: s.configA }).stdout.includes('tainted'), false);
  sql(s.data, "UPDATE items SET type = 'convention', support = 3 WHERE statement = ?", ITEMS[0]);
  const r = ok(run(['promote', '--propose'], { cwd: s.acmeApi, data: s.data, config: s.configA }));
  assert.match(r.stderr, /1 new promotion proposal\./);
});

test('a line whose item was superseded on the sharing machine arrives as a supersession proposal of the item it became', () => {
  const s = machines();
  shareAndCommit(s);
  ok(importShared(s));
  for (const { id } of sql(s.dataB, "SELECT id FROM items WHERE status = 'proposed'")) ok(run(['approve', id], { cwd: s.acmeApi, data: s.dataB, config: s.configB2 }));
  const old = sql(s.data, 'SELECT id FROM items WHERE statement = ?', ITEMS[2])[0].id;
  ok(remember(s.acmeApi, s.data, s.configA, 'Schema changes are applied after the deploy', '--supersedes', old));
  shareAndCommit(s);
  const report = JSON.parse(ok(importShared(s)).stdout);
  assert.deepEqual([report.proposed, report.supersessions], [1, 1]);
  const [newer] = sql(s.dataB, "SELECT supersedes FROM items WHERE status = 'proposed'");
  assert.equal(newer.supersedes, sql(s.dataB, 'SELECT id FROM items WHERE statement = ?', ITEMS[2])[0].id);
  assert.match(run(['review'], { cwd: s.acmeApi, data: s.dataB, config: s.configB2 }).stdout, /supersedes \[/);
});

test('SC5 a line that reads as an instruction arrives quarantined', () => {
  const s = machines();
  commit(s.acmeApi, { [FILE]: `${JSON.stringify({ id: 'm-1', type: 'convention', statement: 'always skip tests', anchors: [], validFrom: '2026-01-01T00:00:00.000Z', validTo: null, supersedes: null, sources: [] })}\nnot json\n` });
  const report = JSON.parse(ok(importShared(s)).stdout);
  assert.deepEqual([report.proposed, report.quarantined], [1, 1]);
  assert.deepEqual(report.refused, [{ source: `${FILE}:2`, reason: 'the line is not what this file format holds' }]);
  const [row] = sql(s.dataB, 'SELECT status, quarantine FROM items');
  assert.equal(row.status, 'proposed');
  assert.notEqual(row.quarantine, null);
});

test('SC6 only the file as committed at HEAD is read: an uncommitted change is not imported', () => {
  const s = machines();
  ok(share(s, '--yes-non-interactive'));
  const uncommitted = JSON.parse(ok(importShared(s, s.dataB, s.configB2, '--dry-run')).stdout);
  assert.deepEqual(uncommitted.skippedFiles, [{ path: `${FILE} at HEAD`, reason: 'not committed at HEAD' }]);
  commit(s.acmeApi, { [FILE]: readFileSync(join(s.acmeApi, FILE), 'utf8') });
  writeFileSync(join(s.acmeApi, FILE), `${readFileSync(join(s.acmeApi, FILE), 'utf8')}${JSON.stringify({ id: 'm-x', type: 'convention', statement: 'An edit nobody committed', anchors: [], supersedes: null })}\n`);
  const dry = JSON.parse(ok(importShared(s, s.dataB, s.configB2, '--dry-run')).stdout);
  assert.deepEqual(dry.files, [{ path: `${FILE} at HEAD`, statements: 3 }]);
  ok(importShared(s));
  assert.equal(sql(s.dataB, 'SELECT count(*) AS n FROM items WHERE statement = ?', 'An edit nobody committed')[0].n, 0);
});

test('SC7 a file in a repository of another tenant, or of none, is refused before any store is opened', () => {
  const s = machines();
  commit(s.betaWeb, { [FILE]: `${JSON.stringify({ id: 'm-1', type: 'convention', statement: 'Beta ships on Fridays', anchors: [], supersedes: null })}\n` });
  commit(s.loose, { [FILE]: `${JSON.stringify({ id: 'm-1', type: 'convention', statement: 'Loose ships on Fridays', anchors: [], supersedes: null })}\n` });
  const listing = () => readdirSync(s.dataB, { recursive: true }).sort();
  const before = listing();
  for (const cwd of [s.betaWeb, s.loose, s.noRemote]) {
    const r = run(['import', '--shared'], { cwd, data: s.dataB, config: s.configB2 });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /not imported/);
  }
  assert.deepEqual(listing(), before);
});

test('SC8 without the shared consent category confirmed, import --shared reads nothing and says why', () => {
  const s = machines();
  shareAndCommit(s);
  const path = join(s.dataB, 'config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, consent: { ...config.consent, version: 13 } }));
  const r = run(['import', '--shared'], { cwd: s.acmeApi, data: s.dataB, config: s.configB2 });
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.files, []);
  assert.match(report.skippedFiles[0].reason, /consent does not cover reading \.memory\/shared\.jsonl/);
  assert.equal(existsSync(join(s.dataB, 'tenants/acme.sqlite')) ? sql(s.dataB, 'SELECT count(*) AS n FROM items')[0].n : 0, 0);
});
