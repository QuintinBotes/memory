import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setup, run, runAsync, remember, sessionStart, storeBytes } from './helpers.mjs';

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

/** A child process holding a read snapshot of `file` until killed: it pins the write-ahead log. */
async function holdReader(file) {
  const script = `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(file)}); d.exec('BEGIN'); d.prepare('SELECT count(*) FROM items').get(); console.log('reading'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => child.stdout.once('data', ok));
  return child;
}

const SECRET = 'Zebrafish quokka marker xylophone7731 must never survive purge';

test('purge with a reader holding a snapshot never reports success while the purged text is still in the write-ahead log', async () => {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, SECRET, '--scope', 'repository', '--type', 'hazard').status, 0);
  const file = join(s.data, 'tenants', 'acme.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const { id } = db.prepare('SELECT id FROM items').get();
  db.close();
  const reader = await holdReader(file);
  const blocked = run(['purge', '--item', id, '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  const leaked = storeBytes(s.data).includes('xylophone7731');
  assert.ok(blocked.status !== 0 || !leaked, 'a purge that exits 0 leaves no recoverable bytes');
  assert.notEqual(blocked.status, 0, blocked.stdout);
  assert.match(blocked.stderr, /write-ahead log|still hold|reader/i);
  reader.kill();
  await new Promise((ok) => reader.once('exit', ok));
  // Run again with the reader gone: the checkpoint completes and nothing is recoverable.
  const again = run(['purge', '--item', id, '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(storeBytes(s.data).includes('xylophone7731'), false);
  const wal = `${file}-wal`;
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, 'the write-ahead log is empty');
});

test('purge waits out a reader that lets go soon, then leaves no recoverable bytes', async () => {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, SECRET, '--scope', 'repository', '--type', 'hazard').status, 0);
  const file = join(s.data, 'tenants', 'acme.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const { id } = db.prepare('SELECT id FROM items').get();
  db.close();
  const reader = await holdReader(file);
  setTimeout(() => reader.kill(), 1000);
  const r = await runAsync(['purge', '--item', id, '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(storeBytes(s.data).includes('xylophone7731'), false);
});
