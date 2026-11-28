import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remember, run, setup } from './helpers.mjs';

// A key is set so capture's line does not depend on whether this machine has claude on PATH.
const doctor = (s, cwd, { config = s.configA, env = { ANTHROPIC_API_KEY: 'unused' }, path, json = false } = {}) =>
  run(['doctor', ...(json ? ['--json'] : [])], { cwd, data: s.data, config, env, path });
const line = (stdout, id) => stdout.split('\n').find((l) => l.split(/\s+/)[1] === id) ?? '';
const fixOf = (stdout, id) => {
  const lines = stdout.split('\n');
  const next = lines[lines.indexOf(line(stdout, id)) + 1] ?? '';
  return next.trim().startsWith('fix: ') ? next.trim().slice(5) : '';
};
const editConfig = (s, change) => {
  const file = join(s.data, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  change(config);
  writeFileSync(file, JSON.stringify(config));
};

test('SC1: a consented, bound repository with everything working exits 0 with every line ok or off', () => {
  const s = setup();
  const r = doctor(s, s.acmeApi);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const statuses = r.stdout.split('\n').filter((l) => /^\S/.test(l)).map((l) => l.split(/\s+/)[0]);
  assert.ok(statuses.length >= 10);
  assert.deepEqual([...new Set(statuses)].filter((st) => st !== 'ok' && st !== 'off'), []);
  assert.match(line(r.stdout, 'tenant'), /^ok\s+tenant\s+acme\/api is tenant acme/);
  assert.match(line(r.stdout, 'binding'), /^ok/);
  assert.match(line(r.stdout, 'mcp'), /^ok .*answers initialize/);
});

test('SC2: a remote that matches no tenant fails the tenant line, naming the remote and the init that would match it', () => {
  const s = setup();
  const r = doctor(s, s.loose);
  assert.equal(r.status, 1);
  assert.match(line(r.stdout, 'tenant'), /^fail\s+tenant\s+loose\/tool \(remote https:\/\/github\.com\/loose\/tool\.git\) matches no tenant/);
  // --bind replaces the config's list, so the fix keeps the tenants already bound.
  assert.equal(fixOf(r.stdout, 'tenant'), 'memory init --tenant loose=loose/* --bind acme,beta,loose --confirm');
});

test('a config not bound to the tenant fails the binding line; no remote is off, not a failure', () => {
  const s = setup();
  const b = doctor(s, s.acmeApi, { config: s.configB });
  assert.equal(b.status, 1);
  assert.match(line(b.stdout, 'binding'), /^fail .* is not bound to acme/);
  assert.equal(fixOf(b.stdout, 'binding'), 'memory init --bind beta,acme --confirm');
  const n = doctor(s, s.noRemote);
  assert.equal(n.status, 0, n.stdout);
  assert.match(line(n.stdout, 'tenant'), /^off .*no github\.com origin remote here/);
});

test('SC3: a consent one plan version behind names each category not yet agreed and memory init --confirm', () => {
  const s = setup();
  editConfig(s, (c) => (c.consent.version = 12));
  const r = doctor(s, s.acmeApi);
  assert.equal(r.status, 1);
  assert.match(line(r.stdout, 'consent'), /^fail .*agreed to plan version 12 of 13; not yet agreed: embeddings$/);
  assert.equal(fixOf(r.stdout, 'consent'), 'memory init --confirm');
});

test('SC4: no key and no claude on PATH fails capture with that reason; capture disabled in config.json is off', () => {
  const s = setup();
  const bin = join(s.base, 'bin');
  mkdirSync(bin);
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
  const r = doctor(s, s.acmeApi, { env: {}, path: bin });
  assert.equal(r.status, 1);
  assert.match(line(r.stdout, 'capture'), /^fail\s+capture\s+no ANTHROPIC_API_KEY and no claude on PATH/);
  editConfig(s, (c) => (c.capture = { enabled: false }));
  const o = doctor(s, s.acmeApi, { env: {}, path: bin });
  assert.equal(o.status, 0, o.stdout);
  assert.match(line(o.stdout, 'capture'), /^off\s+capture\s+capture\.enabled is false in config\.json/);
});

test('SC5: recall turned off by two reverts says so and names memory init --recall on', () => {
  const s = setup();
  editConfig(s, (c) => (c.recallOff = { reason: 'two memory-linked reverts within seven days', at: '2026-11-01T00:00:00.000Z' }));
  const r = doctor(s, s.acmeApi);
  assert.equal(r.status, 1);
  assert.match(line(r.stdout, 'recall'), /^fail\s+recall\s+off since 2026-11-01T00:00:00\.000Z: two memory-linked reverts within seven days/);
  assert.match(fixOf(r.stdout, 'recall'), /^memory init --recall on/);
});

test('SC6: the last capture run is shown from logs/capture.jsonl: kept n, or skipped with its reason', () => {
  const s = setup();
  mkdirSync(join(s.data, 'logs'));
  const log = join(s.data, 'logs', 'capture.jsonl');
  const kept = { at: '2026-11-02T10:00:00.000Z', session: 's1', agent: 'claude-code', model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 40, candidates: 3, saved: 2, merged: 1 };
  const skipped = { at: '2026-11-02T11:00:00.000Z', session: 's1', agent: 'claude-code', skipped: 'shorter than 4000 characters', saved: 0 };
  writeFileSync(log, `${JSON.stringify(skipped)}\n${JSON.stringify(kept)}\n`);
  assert.match(line(doctor(s, s.acmeApi).stdout, 'capture'), /last run 2026-11-02T10:00:00\.000Z: kept 2, merged 1$/);
  writeFileSync(log, `${JSON.stringify(kept)}\n${JSON.stringify(skipped)}\n`);
  assert.match(line(doctor(s, s.acmeApi).stdout, 'capture'), /last run 2026-11-02T11:00:00\.000Z: skipped, shorter than 4000 characters$/);
});

test('SC7: --json prints one object per check with id, status and fix, the same bytes for the same state', () => {
  const s = setup();
  const a = doctor(s, s.loose, { json: true });
  const b = doctor(s, s.loose, { json: true });
  assert.equal(a.status, 1);
  assert.equal(a.stdout, b.stdout);
  const checks = a.stdout.trim().split('\n').map((l) => JSON.parse(l));
  for (const c of checks) {
    assert.equal(typeof c.id, 'string');
    assert.ok(['ok', 'off', 'fail'].includes(c.status));
    assert.ok(c.fix === null || typeof c.fix === 'string');
  }
  assert.equal(checks.find((c) => c.id === 'tenant').status, 'fail');
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length);
});

test('SC8: doctor changes no file, opens only the tenant bound here and the person file, and prints no statement', () => {
  const s = setup();
  const statement = 'Releases are cut from the main branch only';
  assert.equal(remember(s.acmeApi, s.data, s.configA, statement).status, 0);
  assert.equal(remember(s.betaWeb, s.data, s.configA, 'Deploys wait for the staging soak').status, 0);
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Prefers short commit titles', '--scope', 'person').status, 0);
  const snapshot = () => {
    const out = {};
    for (const name of readdirSync(s.data, { recursive: true })) {
      const p = join(s.data, name);
      try {
        out[name] = readFileSync(p).toString('base64');
      } catch {
        out[name] = 'dir';
      }
    }
    return out;
  };
  const before = snapshot();
  const opens = join(s.base, 'opens.log');
  writeFileSync(opens, '');
  const r = run(['doctor'], { cwd: s.acmeApi, data: s.data, config: s.configA, env: { ANTHROPIC_API_KEY: 'unused', OPEN_LOG: opens } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(snapshot(), before);
  assert.match(line(r.stdout, 'items'), /acme\/api: 1 active, 0 proposed, 0 stale, 0 expired; person file: 1 active/);
  if (typeof DatabaseSync.prototype.location === 'function') {
    const opened = readFileSync(opens, 'utf8').trim().split('\n').map((p) => realpathSync(p));
    assert.deepEqual(opened.sort(), [join(s.data, 'person.sqlite'), join(s.data, 'tenants', 'acme.sqlite')].map((p) => realpathSync(p)).sort());
  }
  for (const text of [statement, 'staging soak', 'short commit titles']) assert.ok(!r.stdout.includes(text) && !r.stderr.includes(text));
});
