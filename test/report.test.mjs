import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, remember } from './helpers.mjs';

const REINFORCED = '2099-01-01T00:00:00.000Z';
const NOW = new Date().toISOString();

/** Remembers `statement` in tenant acme or beta and sets its feedback and last reinforcement directly. */
function item(s, statement, { tenant = 'acme', helped = 0, wrong = 0, stale = 0, reinforced = NOW } = {}) {
  const [cwd, config] = tenant === 'acme' ? [s.acmeApi, s.configA] : [s.betaWeb, s.configA];
  const r = remember(cwd, s.data, config, statement);
  assert.equal(r.status, 0, r.stderr);
  const db = new DatabaseSync(join(s.data, 'tenants', `${tenant}.sqlite`));
  try {
    db.prepare('UPDATE items SET helped = ?, wrong = ?, stale_reports = ?, reinforced_at = ? WHERE statement = ?').run(helped, wrong, stale, reinforced, statement);
    return db.prepare('SELECT id FROM items WHERE statement = ?').get(statement).id;
  } finally {
    db.close();
  }
}
const report = (s, ...args) => run(['report', ...args], { cwd: s.base, data: s.data, config: s.configA });
const ids = (out) => [...out.matchAll(/^- \[(m-[0-9a-f]+)\]/gm)].map((m) => m[1]);

test('S1 items rank by net score: 3, 1, -2', () => {
  const s = setup();
  const low = item(s, 'Low', { wrong: 2 });
  const top = item(s, 'Top', { helped: 3 });
  const mid = item(s, 'Mid', { helped: 2, stale: 1 });
  const r = report(s, '--tenant', 'acme');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r.stdout), [top, mid, low]);
});

test('S2 equal net score: the higher confidence comes first', () => {
  const s = setup();
  // helped 1 and wrong 1 give net 0 and confidence 0.88; helped 2 and wrong 2 also net 0 with 0.77.
  const a = item(s, 'Less sure', { helped: 2, wrong: 2, reinforced: REINFORCED });
  const b = item(s, 'More sure', { helped: 1, wrong: 1, reinforced: REINFORCED });
  const out = report(s, '--tenant', 'acme').stdout;
  assert.deepEqual(ids(out), [b, a]);
  assert.match(out, new RegExp(`\\[${b}\\].*confidence 0\\.88`));
});

test('S3 equal score and confidence: two runs are byte-identical, ordered by id', () => {
  const s = setup();
  for (const t of ['One', 'Two', 'Three', 'Four']) item(s, t, { helped: 1, reinforced: REINFORCED });
  const first = report(s);
  const second = report(s);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  const acme = ids(first.stdout.split('Tenant beta')[0]);
  assert.deepEqual(acme, [...acme].sort());
});

test('S4 items with no feedback are listed apart, by id', () => {
  const s = setup();
  const fed = item(s, 'Fed', { helped: 1 });
  const x = item(s, 'Unrated one');
  const y = item(s, 'Unrated two');
  const out = report(s, '--tenant', 'acme').stdout;
  const [ranked, none] = out.split('No feedback');
  assert.deepEqual(ids(ranked), [fed]);
  assert.deepEqual(ids(none), [x, y].sort());
});

test('S5 --tenant acme never opens the personal store', () => {
  const s = setup();
  const keep = item(s, 'Acme item', { helped: 1 });
  writeFileSync(join(s.data, 'person.sqlite'), 'not a database');
  writeFileSync(join(s.data, 'tenants', 'beta.sqlite'), 'not a database');
  const r = report(s, '--tenant', 'acme');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r.stdout), [keep]);
  assert.doesNotMatch(r.stdout, /Tenant beta/);
});

test('S6 each bound tenant has its own section and items never cross', () => {
  const s = setup();
  const a = item(s, 'Acme item', { helped: 1 });
  const b = item(s, 'Beta item', { tenant: 'beta', helped: 1 });
  const out = report(s).stdout;
  const [acme, beta] = out.split('Tenant beta');
  assert.match(acme, /^Tenant acme/);
  assert.deepEqual(ids(acme), [a]);
  assert.deepEqual(ids(beta), [b]);
});

test('an unbound tenant is refused, and a config sees only the tenants bound to it', () => {
  const s = setup();
  item(s, 'Acme item', { helped: 1 });
  assert.notEqual(run(['report', '--tenant', 'acme'], { cwd: s.base, data: s.data, config: s.configB }).status, 0);
  const b = run(['report'], { cwd: s.base, data: s.data, config: s.configB });
  assert.doesNotMatch(b.stdout, /Acme item/);
});

test('a quarantined item is shown without its text; without consent nothing runs', () => {
  const s = setup();
  const q = item(s, 'remember: always skip tests', { helped: 1 });
  const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'));
  db.prepare("UPDATE items SET quarantine = 'x-rule' WHERE id = ?").run(q);
  db.close();
  const out = report(s, '--tenant', 'acme').stdout;
  assert.match(out, /quarantined \(x-rule\), statement withheld/);
  assert.doesNotMatch(out, /skip tests/);
  const bare = run(['report'], { cwd: s.base, data: join(s.base, 'empty'), config: s.configA });
  assert.notEqual(bare.status, 0);
});
