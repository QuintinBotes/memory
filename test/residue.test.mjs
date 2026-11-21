import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, remember, commit, storeBytes } from './helpers.mjs';

const acme = (s) => join(s.data, 'tenants', 'acme.sqlite');
const logFile = (s) => join(s.data, 'logs', 'injections.jsonl');
const purge = (s, cwd, ...args) => run(['purge', ...args], { cwd, data: s.data, config: s.configA });
const subagent = (s, cwd) =>
  run(['subagent-start'], { cwd, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', agent_id: 'a1', agent_type: 'general-purpose', cwd }) });
const idOf = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return /remembered (m-[0-9a-f]+)/.exec(r.stdout)[1];
};
const withDb = (file, fn) => {
  const db = new DatabaseSync(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
/** `n` filler items, written as memory writes, with secure deletion on, so a page split leaves no stale copy. */
const fill = (file, n) =>
  withDb(file, (db) => {
    db.exec('PRAGMA secure_delete = ON; BEGIN');
    const ins = db.prepare(
      `INSERT INTO items (id, tenant, scope, scope_key, type, statement, statement_key, status, origin_trust, valid_from, created_at)
       VALUES (?, 'acme', 'repository', 'acme/api', 'convention', ?, ?, 'active', 'owner', '2026-01-01', '2026-01-01')`,
    );
    for (let i = 0; i < n; i++) ins.run(`m-f${i}`, `Filler convention ${i} about modules and services`, `k${i}`);
    db.exec('COMMIT');
  });

/**
 * An anchored item whose statement, cited file name and source all hold a fresh canary, shown to a subagent so the
 * injection log names it too, in a tenant of 500 items.
 */
function canaried() {
  const s = setup();
  const canary = `cnry${randomBytes(8).toString('hex')}`;
  commit(s.acmeApi, { [`src/${canary}.ts`]: 'export const a = 1;\n' });
  const id = idOf(remember(s.acmeApi, s.data, s.configA, `The ${canary} module holds the run lock`, '--type', 'hazard',
    '--anchor', `src/${canary}.ts:1`, '--source', `https://github.com/acme/api/pull/${canary}`));
  fill(acme(s), 500);
  assert.match(subagent(s, s.acmeApi).stdout, new RegExp(canary));
  assert.ok(storeBytes(s.data).includes(canary), 'the canary is on disk before the purge');
  return { ...s, canary, id };
}

const MODES = [
  ['--item', (s) => ['--item', s.id]],
  ['--repo', () => ['--repo', 'acme/api']],
  ['--tenant', () => ['--tenant', 'acme']],
  ['--all', () => ['--all']],
  ['--source --with-derived', (s) => ['--source', `https://github.com/acme/api/pull/${s.canary}`, '--with-derived']],
];

for (const [name, args] of MODES) {
  test(`purge ${name} leaves no byte of the purged item in any file of the data directory`, () => {
    const s = canaried();
    const r = purge(s, s.acmeApi, ...args(s), '--confirm');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(storeBytes(s.data).includes(s.canary), false, `the canary survives ${name}`);
    if (existsSync(acme(s))) {
      withDb(acme(s), (db) => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items_fts WHERE items_fts MATCH ?').get(s.canary).n, 0));
    }
  });
}

test('the same delete with secure deletion off leaves the canary on disk, so the test above proves the setting', () => {
  const s = setup();
  idOf(remember(s.acmeApi, s.data, s.configA, 'Releases are tagged'));
  const canary = `cnry${randomBytes(8).toString('hex')}`;
  withDb(acme(s), (db) => db.prepare(`INSERT INTO items (id, tenant, scope, scope_key, type, statement, status, origin_trust, valid_from, created_at)
    VALUES ('m-canary', 'acme', 'repository', 'acme/api', 'hazard', ?, 'active', 'owner', '2026-01-01', '2026-01-01')`).run(`The ${canary} module`));
  fill(acme(s), 200);
  withDb(acme(s), (db) => db.exec("PRAGMA secure_delete = OFF; INSERT INTO items_fts (items_fts, rank) VALUES ('secure-delete', 0); DELETE FROM items WHERE id = 'm-canary'"));
  assert.ok(storeBytes(s.data).includes(canary));
});

test('a store written before secure deletion is rewritten once on its next open, so text deleted before is gone', () => {
  const s = setup();
  idOf(remember(s.acmeApi, s.data, s.configA, 'Releases are tagged'));
  const canary = `cnry${randomBytes(8).toString('hex')}`;
  // A row deleted from the middle of a page leaves its bytes there unless secure deletion is on.
  withDb(acme(s), (db) => db.prepare(`INSERT INTO items (id, tenant, scope, scope_key, type, statement, status, origin_trust, valid_from, created_at)
    VALUES ('m-canary', 'acme', 'repository', 'acme/api', 'hazard', ?, 'active', 'owner', '2026-01-01', '2026-01-01')`).run(`The ${canary} module`));
  fill(acme(s), 200);
  // Schema version 5, as every store written before this change is.
  withDb(acme(s), (db) => db.exec("PRAGMA secure_delete = OFF; DELETE FROM items WHERE id = 'm-canary'; PRAGMA user_version = 5"));
  assert.ok(storeBytes(s.data).includes(canary));
  assert.equal(run(['list'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.equal(storeBytes(s.data).includes(canary), false);
  assert.match(run(['list'], { cwd: s.acmeApi, data: s.data, config: s.configA }).stdout, /Releases are tagged/);
});

/** Item A rests only on pull request 12, item B on 12 and 13, and A was promoted to a check; beta holds the same source. */
function sourced() {
  const s = setup();
  const pr12 = 'https://github.com/acme/api/pull/12';
  const a = idOf(remember(s.acmeApi, s.data, s.configA, 'Retries use exponential backoff', '--source', pr12));
  const b = idOf(remember(s.acmeApi, s.data, s.configA, 'Handlers validate input first', '--source', pr12));
  const beta = idOf(remember(s.betaWeb, s.data, s.configA, 'Beta deploys on Thursdays', '--source', pr12));
  withDb(acme(s), (db) => {
    db.prepare(`INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor)
      VALUES ('e-b13', ?, 'https://github.com/acme/api/pull/13', 'owner', 'h', '2026-01-02', 'deterministic')`).run(b);
    db.prepare('UPDATE items SET support = 2 WHERE id = ?').run(b);
    db.prepare("UPDATE items SET promoted_to = 'checks/backoff.yml' WHERE id = ?").run(a);
  });
  return { ...s, pr12, a, b, beta };
}
const itemRow = (s, id) => withDb(acme(s), (db) => db.prepare('SELECT status, support, (SELECT COUNT(*) FROM evidence WHERE item_id = items.id) AS evidence FROM items WHERE id = ?').get(id));

test('purge --source previews the evidence, items and checks it affects, and changes nothing without --confirm', () => {
  const s = sourced();
  const before = storeBytes(s.data);
  const r = purge(s, s.acmeApi, '--source', s.pr12);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.evidence, 2);
  assert.equal(out.returnedToProposed, 1);
  assert.deepEqual(out.checks, ['checks/backoff.yml']);
  assert.deepEqual(storeBytes(s.data), before);
});

test('purge --source removes its evidence, returns an item resting only on it to proposed, and never reaches another tenant', () => {
  const s = sourced();
  const r = purge(s, s.acmeApi, '--source', s.pr12, '--confirm');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).checks, ['checks/backoff.yml'], 'the check is listed for the owner, not edited');
  assert.deepEqual({ ...itemRow(s, s.a) }, { status: 'proposed', support: 1, evidence: 0 });
  assert.deepEqual({ ...itemRow(s, s.b) }, { status: 'active', support: 1, evidence: 1 });
  withDb(acme(s), (db) => assert.equal(db.prepare('SELECT promoted_to FROM items WHERE id = ?').get(s.a).promoted_to, 'checks/backoff.yml'));
  withDb(join(s.data, 'tenants', 'beta.sqlite'), (db) => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE item_id = ?').get(s.beta).n, 1));
});

test('purge --source --with-derived deletes an item resting only on that source', () => {
  const s = sourced();
  assert.equal(purge(s, s.acmeApi, '--source', s.pr12, '--with-derived', '--confirm').status, 0);
  assert.equal(itemRow(s, s.a), undefined);
  assert.deepEqual({ ...itemRow(s, s.b) }, { status: 'active', support: 1, evidence: 1 });
  assert.equal(storeBytes(s.data).includes('exponential backoff'), false);
});

test('a source that matches nothing reports zero and exits 0; --with-derived needs --source', () => {
  const s = sourced();
  const r = purge(s, s.acmeApi, '--source', 'https://github.com/acme/api/pull/999', '--confirm');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).evidence, 0);
  assert.equal(purge(s, s.acmeApi, '--tenant', 'acme', '--with-derived').status, 2);
});

test('the audit entry records the scope and counts, never the purged text or the source itself', () => {
  const s = sourced();
  assert.equal(purge(s, s.acmeApi, '--source', s.pr12, '--confirm').status, 0);
  withDb(acme(s), (db) => {
    const meta = db.prepare("SELECT metadata_json FROM audit_events WHERE action = 'purge'").get().metadata_json;
    assert.doesNotMatch(meta, /pull\/12|exponential/);
    assert.match(meta, /"evidence":2/);
  });
});

test('a purge that fails half way leaves the store unchanged, with no purge audit entry', () => {
  const s = sourced();
  withDb(acme(s), (db) => db.exec("CREATE TRIGGER fail AFTER DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'interrupted'); END;"));
  assert.notEqual(purge(s, s.acmeApi, '--source', s.pr12, '--confirm').status, 0);
  assert.deepEqual({ ...itemRow(s, s.a) }, { status: 'active', support: 1, evidence: 1 });
  withDb(acme(s), (db) => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'purge'").get().n, 0));
});

test('the injection log keeps no line of a purged item; --older-than drops lines older than the cut-off, and --all the file', () => {
  const s = setup();
  const keep = idOf(remember(s.acmeApi, s.data, s.configA, 'Releases are tagged'));
  const gone = idOf(remember(s.acmeApi, s.data, s.configA, 'Retries use backoff'));
  subagent(s, s.acmeApi);
  const items = () => readFileSync(logFile(s), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l).item);
  assert.deepEqual(items().sort(), [keep, gone].sort());
  assert.equal(purge(s, s.acmeApi, '--item', gone, '--confirm').status, 0);
  assert.deepEqual(items(), [keep]);
  // A line from before lines carried a time counts as older than any cut-off.
  writeFileSync(logFile(s), `${readFileSync(logFile(s), 'utf8')}${JSON.stringify({ event: 'injected', session: 's0', agent: 'a0', item: keep, via: 'subagent-start', anchors: [], tokens: 5 })}\n`);
  assert.equal(purge(s, s.acmeApi, '--older-than', '1', '--confirm').status, 0);
  assert.deepEqual(items(), [keep]);
  assert.equal(purge(s, s.acmeApi, '--older-than', '0', '--confirm').status, 0);
  assert.deepEqual(items(), []);
  subagent(s, s.acmeApi);
  assert.equal(purge(s, s.acmeApi, '--all', '--confirm').status, 0);
  assert.equal(existsSync(logFile(s)), false);
});

test('purging one item from a 10,000-item tenant takes under 2 seconds', () => {
  const s = setup();
  const id = idOf(remember(s.acmeApi, s.data, s.configA, 'Releases are tagged'));
  fill(acme(s), 10_000);
  const start = Date.now();
  assert.equal(purge(s, s.acmeApi, '--item', id, '--confirm').status, 0);
  assert.ok(Date.now() - start < 2000, `${Date.now() - start} ms`);
});
