import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, remember, run, commit, tokens } from './helpers.mjs';

// Slice 14 (#16): `memory recall --diff` also recalls items on the dependents a change reaches, asked of a code anchor provider.
const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-provider.mjs');
const rows = (text) => text.split('\n').filter((l) => /^\[[^\]]+\] /.test(l));
const dep = (path, status, relation = 'caller', extra = {}) => ({ path, symbol: `${path}#x#function`, relation, status, ...extra });

/** acme/api whose last commit changes src/core.ts; src/service.ts and src/handler.ts exist before it. `provider` is the fake's answer, or null for none. */
function reach(provider, { hazards = {} } = {}) {
  const s = setup();
  commit(s.acmeApi, { 'src/service.ts': 'export const service = 1;\n', 'src/handler.ts': 'export const handler = 1;\n', 'src/core.ts': 'export const core = 1;\n' }, 'add');
  commit(s.acmeApi, { 'src/core.ts': 'export const core = 2;\n' }, 'change core');
  for (const [path, statement] of Object.entries(hazards)) {
    const r = remember(s.acmeApi, s.data, s.configA, statement, '--scope', 'repository', '--type', 'hazard', '--anchor', `${path}:1-1`);
    assert.equal(r.status, 0, r.stderr);
  }
  s.fixture = join(s.base, 'impact.json');
  s.log = join(s.base, 'impact.log');
  writeFileSync(s.log, '');
  if (provider !== null) answer(s, provider);
  return s;
}
function answer(s, provider) {
  writeFileSync(s.fixture, JSON.stringify(provider));
  const cfg = join(s.data, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), impactProvider: { command: [process.execPath, fake, s.fixture, s.log] } }));
}
const recall = (s) => run(['recall', '--diff', 'HEAD~1..HEAD'], { cwd: s.acmeApi, data: s.data, config: s.configA });
const calls = (s) => readFileSync(s.log, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));

const NAMES = ['apple', 'banana', 'cherry', 'damson', 'elder', 'fig', 'grape', 'hazel', 'iris', 'juniper', 'kiwi', 'lemon', 'mango', 'nectar'];
const SERVICE ='service validates after it calls the lower layer, so a null result breaks it';
const HANDLER = 'handler retries the lower layer twice, so a slow one doubles the load';

test('US1.1 a hazard on an untouched caller is recalled with dependent in its why, after one provider call', () => {
  const s = reach({ status: 'ok', dependents: [dep('src/service.ts', 'tested')] }, { hazards: { 'src/service.ts': SERVICE } });
  const r = recall(s);
  assert.equal(r.status, 0, r.stderr);
  const [row, ...more] = rows(r.stdout);
  assert.equal(more.length, 0);
  assert.match(row, new RegExp(SERVICE));
  assert.match(row, /why: .*dependent 2/);
  const [call, ...others] = calls(s);
  assert.equal(others.length, 0);
  assert.equal(call.op, 'impact');
  assert.deepEqual(call.changed, ['src/core.ts']);
  assert.equal(call.repository, 'acme/api');
});

test('US1.1 without a provider the same recall shows nothing for the caller (slice 8 behaviour)', () => {
  const s = reach(null, { hazards: { 'src/service.ts': SERVICE, 'src/core.ts': 'lower layer rounds down' } });
  const out = recall(s).stdout;
  assert.match(out, /lower layer rounds down/);
  assert.doesNotMatch(out, new RegExp(SERVICE));
  assert.deepEqual(calls(s), []);
});

test('US1.2 a dependent that is neither changed nor tested scores one point more than a tested one, and comes first', () => {
  const s = reach(
    { status: 'ok', dependents: [dep('src/service.ts', 'tested'), dep('src/handler.ts', 'neither')] },
    { hazards: { 'src/service.ts': SERVICE, 'src/handler.ts': HANDLER } },
  );
  const [first, second] = rows(recall(s).stdout);
  assert.match(first, new RegExp(HANDLER));
  assert.match(second, new RegExp(SERVICE));
  const score = (row) => Number(/dependent (\d+(?:\.\d)?)/.exec(row)[1]) + (/neither changed nor tested (\d+)/.exec(row)?.[1] ? Number(/neither changed nor tested (\d+)/.exec(row)[1]) : 0);
  assert.equal(score(first) - score(second), 1);
  assert.doesNotMatch(second, /neither changed nor tested/);
});

test('US1.3 a commit with no snapshot falls back to path overlap and says so', () => {
  const s = reach({ status: 'no_snapshot' }, { hazards: { 'src/service.ts': SERVICE, 'src/core.ts': 'lower layer rounds down' } });
  const r = recall(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lower layer rounds down/);
  assert.doesNotMatch(r.stdout, new RegExp(SERVICE));
  assert.match(r.stdout, /no impact snapshot.*path overlap only/i);
  assert.equal(calls(s).length, 1);
});

test('US1.4 many dependents stay within 600 estimated tokens, and rows were left out to do it', () => {
  const hazards = {};
  const dependents = [];
  for (let i = 0; i < 14; i++) {
    const path = `src/dep${i}.ts`;
    hazards[path] = `${NAMES[i]} breaks when the lower layer changes because ${`it assumes the old shape of the ${NAMES[i]} value and `.repeat(4)}so check ${NAMES[i]}`;
    dependents.push(dep(path, 'neither'));
  }
  const s = setup();
  commit(s.acmeApi, Object.fromEntries([...Object.keys(hazards).map((p) => [p, 'export const x = 1;\n']), ['src/core.ts', 'export const core = 1;\n']]), 'add');
  commit(s.acmeApi, { 'src/core.ts': 'export const core = 2;\n' }, 'change core');
  for (const [path, statement] of Object.entries(hazards)) {
    assert.equal(remember(s.acmeApi, s.data, s.configA, statement, '--scope', 'repository', '--type', 'hazard', '--anchor', `${path}:1-1`).status, 0);
  }
  s.fixture = join(s.base, 'impact.json');
  s.log = join(s.base, 'impact.log');
  writeFileSync(s.log, '');
  answer(s, { status: 'ok', dependents });
  const out = recall(s).stdout;
  const shown = rows(out).length;
  assert.ok(shown > 0 && shown < 10, `${shown} rows`);
  assert.ok(tokens(out) <= 600, `${tokens(out)} tokens`);
});

test('edge: a dependent in another repository is dropped, the same dependent in this one is recalled', () => {
  const s = reach({ status: 'ok', dependents: [dep('src/service.ts', 'neither', 'caller', { repository: 'other/lib' })] }, { hazards: { 'src/service.ts': SERVICE } });
  assert.doesNotMatch(recall(s).stdout, new RegExp(SERVICE));
  answer(s, { status: 'ok', dependents: [dep('src/service.ts', 'neither', 'caller', { repository: 'acme/api' })] });
  assert.match(recall(s).stdout, new RegExp(SERVICE));
});

test('edge: a consent that predates the plan item does not run the provider, and the output says why', () => {
  const s = reach({ status: 'ok', dependents: [dep('src/service.ts', 'neither')] }, { hazards: { 'src/service.ts': SERVICE } });
  const cfg = join(s.data, 'config.json');
  const c = JSON.parse(readFileSync(cfg, 'utf8'));
  c.consent.version = 6;
  writeFileSync(cfg, JSON.stringify(c));
  const r = recall(s);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, new RegExp(SERVICE));
  assert.match(r.stdout, /impact provider.*not run.*plan/i);
  assert.equal(existsSync(s.log) ? calls(s).length : 0, 0);
});

test('edge: a provider that fails or answers nonsense costs the dependents, not the recall', () => {
  const s = reach({ crash: true }, { hazards: { 'src/service.ts': SERVICE, 'src/core.ts': 'lower layer rounds down' } });
  const r = recall(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lower layer rounds down/);
  assert.match(r.stdout, /impact provider.*failed.*path overlap only/i);
  answer(s, { status: 'ok', dependents: 'many' });
  assert.match(recall(s).stdout, /impact provider.*failed/i);
});

test('config: impactProvider must be {command: [strings]}', () => {
  const s = reach(null);
  const cfg = join(s.data, 'config.json');
  const base = JSON.parse(readFileSync(cfg, 'utf8'));
  writeFileSync(cfg, JSON.stringify({ ...base, impactProvider: { command: 'node x' } }));
  const bad = recall(s);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /impactProvider/);
  writeFileSync(cfg, JSON.stringify({ ...base, impactProvider: { command: [] } }));
  assert.notEqual(recall(s).status, 0);
});
