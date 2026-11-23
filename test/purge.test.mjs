import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { setup, run, remember, sessionStart } from './helpers.mjs';

function seeded() {
  const s = setup();
  for (const [dir, config, text, scope] of [
    ['acmeApi', 'configA', 'Api releases are tagged', 'repository'],
    ['acmeWeb', 'configA', 'Web uses server rendering', 'repository'],
    ['betaWeb', 'configB', 'Beta deploys need a second approver', 'repository'],
    ['loose', 'configA', 'Prefer small pull requests', 'person'],
  ]) {
    const r = remember(s[dir], s.data, s[config], text, '--scope', scope);
    assert.equal(r.status, 0, r.stderr);
  }
  return s;
}

const purge = (s, ...args) => run(['purge', ...args], { cwd: s.base, data: s.data, config: s.configA });
const audit = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT action FROM audit_events WHERE action = 'purge'").all();
  db.close();
  return rows.length;
};

test('purge previews first, and deletes only with --confirm', () => {
  const s = seeded();
  const preview = purge(s, '--repo', 'acme/api');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /"items": 1/);
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /Api releases are tagged/);

  assert.equal(purge(s, '--repo', 'acme/api', '--confirm').status, 0);
  assert.doesNotMatch(sessionStart(s.acmeApi, s.data, s.configA).stdout, /Api releases are tagged/);
  assert.match(sessionStart(s.acmeWeb, s.data, s.configA).stdout, /Web uses server rendering/);
  assert.equal(audit(join(s.data, 'tenants', 'acme.sqlite')), 1);
});

test('purge by repository finds items stored under an earlier allowlist', () => {
  const s = seeded();
  const narrowed = run(['init', '--tenant', 'acme=acme/web', '--bind', 'acme,beta', '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(narrowed.status, 0, narrowed.stderr);
  assert.equal(purge(s, '--repo', 'acme/api', '--confirm').status, 0);
  const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE scope_key = 'acme/api'").get().n, 0);
  db.close();
});

test('purge by tenant touches only that tenant', () => {
  const s = seeded();
  assert.equal(purge(s, '--tenant', 'beta', '--confirm').status, 0);
  assert.doesNotMatch(sessionStart(s.betaWeb, s.data, s.configB).stdout, /second approver/);
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /Api releases are tagged/);
  assert.equal(audit(join(s.data, 'tenants', 'beta.sqlite')), 1);
});

test('purging evidence returns its items to proposed, so they leave the slice', () => {
  const s = seeded();
  assert.equal(purge(s, '--older-than', '0', '--confirm').status, 0);
  assert.equal(sessionStart(s.acmeApi, s.data, s.configA).stdout, '');
  const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'), { readOnly: true });
  assert.deepEqual(db.prepare('SELECT DISTINCT status FROM items').all().map((r) => r.status), ['proposed']);
  db.close();
});

test('purge --all empties every store and keeps the audit entry', () => {
  const s = seeded();
  assert.equal(purge(s, '--all', '--confirm').status, 0);
  for (const [dir, config] of [['acmeApi', 'configA'], ['betaWeb', 'configB'], ['loose', 'configA']]) {
    assert.equal(sessionStart(s[dir], s.data, s[config]).stdout, '');
  }
  assert.equal(audit(join(s.data, 'person.sqlite')), 1);
});

test('purge without a scope is a usage error', () => {
  const s = seeded();
  assert.equal(purge(s).status, 2);
  assert.equal(purge(s, '--older-than', 'soon').status, 2);
});

test('purge deletes an item\'s vector with it, from the same file', () => {
  const s = seeded();
  const cfgPath = join(s.data, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf8')), embeddings: { provider: 'fake' } }));
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Api rate limits are per key', '--scope', 'repository').status, 0);
  const count = () => {
    const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'), { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM item_vectors').get().n;
    db.close();
    return n;
  };
  assert.equal(count(), 3, 'the new item and the two stored before it, which a write embeds as well');
  assert.equal(purge(s, '--repo', 'acme/api', '--confirm').status, 0);
  assert.equal(count(), 1, 'only the acme/web item keeps its vector');
});
