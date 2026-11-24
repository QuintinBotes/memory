import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, remember, sessionStart, runAsync, commit } from './helpers.mjs';

// Gap 4 (#24), edge case: background jobs take a separate lock, so two anchor refreshes never run at once and a
// refresh never holds up the session-start slice or a writer.
const HAZARD = 'The ledger consumes one unit per call';
const lines = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`);

function stale() {
  const s = setup();
  commit(s.acmeApi, { 'src/ledger.ts': `${lines.join('\n')}\n` });
  const r = remember(s.acmeApi, s.data, s.configA, HAZARD, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/ledger.ts:10-12');
  assert.equal(r.status, 0, r.stderr);
  commit(s.acmeApi, { 'src/ledger.ts': null }); // the citation is gone: a refresh makes the item stale
  s.lock = join(s.data, 'tenants', 'acme.sqlite.refresh.lock');
  return s;
}

const state = (s) => {
  const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'), { readOnly: true });
  try {
    return {
      status: db.prepare('SELECT status FROM items').get().status,
      stales: db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'item_stale'").get().n,
    };
  } finally {
    db.close();
  }
};
const recheck = (s) => runAsync(['recheck'], { cwd: s.acmeApi, data: s.data, config: s.configA });

test('a held refresh lock does not hold up the session-start slice, which prints and leaves the item untouched', async () => {
  const s = stale();
  writeFileSync(s.lock, '1');
  const r = sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(HAZARD), 'the slice is rendered without waiting for the refresh');
  assert.deepEqual(state(s), { status: 'active', stales: 0 }, 'the refresh belongs to the lock holder');
  assert.ok(existsSync(s.lock), 'the hook never removes a live lock');
});

test('memory recheck with the refresh lock held skips, exits 0 and changes nothing', async () => {
  const s = stale();
  writeFileSync(s.lock, '1');
  const r = await recheck(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"skipped"/);
  assert.deepEqual(state(s), { status: 'active', stales: 0 });
});

test('two refreshes at once apply the change once, and the lock is released', async () => {
  const s = stale();
  const both = await Promise.all([recheck(s), recheck(s)]);
  for (const r of both) assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(state(s), { status: 'stale', stales: 1 });
  assert.equal(existsSync(s.lock), false);
});

test('a lock left by a dead process is taken over once it is old', async () => {
  const s = stale();
  writeFileSync(s.lock, '1');
  const old = new Date(Date.now() - 120_000);
  utimesSync(s.lock, old, old);
  const r = await recheck(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(state(s), { status: 'stale', stales: 1 });
  assert.equal(existsSync(s.lock), false);
});
