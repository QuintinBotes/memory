import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, run, commit, sessionStart, tokens } from './helpers.mjs';

// Slice 15 (#17): items name the tests that prove them, found through the code anchor provider's `tests` op during the anchor refresh.
const PROVIDER = join(dirname(fileURLToPath(import.meta.url)), 'fake-provider.mjs');
const lines = (...ls) => `${ls.join('\n')}\n`;
const sym = (key, start, end) => ({ key, kind: 'function', signature: `${key.split('#')[1]}()`, start, end, hash: `H-${key.split('#')[1]}` });
const FILE = lines(...['core', 'untested', 'viaRef', 'viaCall', 'viaTransitive', 'viaDispatch', 'viaObserved', 'viaStatic'].flatMap((n) => [`export function ${n}() {`, `  return '${n}';`, '}']));
const NAMES = ['core', 'untested', 'viaRef', 'viaCall', 'viaTransitive', 'viaDispatch', 'viaObserved', 'viaStatic'];
const key = (name) => `src/a.ts#${name}#function`;
const SYMBOLS = NAMES.map((n, i) => sym(key(n), i * 3 + 1, i * 3 + 3));
const test_ = (name, evidence, line = 7) => ({ key: `test/${name}.test.ts#${name}#test`, evidence, line });

const stateFile = (s) => join(s.base, 'provider-state.json');
const logFile = (s) => join(s.base, 'provider.log');
const requests = (s) => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : []);
const ops = (s, op) => requests(s).filter((r) => r.op === op);
const head = (s) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.acmeApi, encoding: 'utf8' }).trim();
const provide = (s, patch) => {
  const was = existsSync(stateFile(s)) ? JSON.parse(readFileSync(stateFile(s), 'utf8')) : { repository: 'acme/api', snapshots: {} };
  const snapshots = Object.fromEntries(Object.entries(patch.snapshots ?? {}).map(([id, v]) => [id, { ...v, commit: head(s) }]));
  writeFileSync(stateFile(s), JSON.stringify({ ...was, ...patch, snapshots: { ...was.snapshots, ...snapshots } }));
};
const exec = (s, args) => run(args, { cwd: s.acmeApi, data: s.data, config: s.configA });
const sql = (s, text, ...args) => {
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.exec('PRAGMA busy_timeout = 30000');
  try {
    return db.prepare(text).all(...args);
  } finally {
    db.close();
  }
};
const anchorOf = (s, id) => JSON.parse(sql(s, 'SELECT anchors_json FROM items WHERE id = ?', id)[0].anchors_json)[0];

/** acme/api with src/a.ts, a provider at s1 holding `tests`, and one hazard anchored to each symbol of `names`. */
function world({ tests, names = ['core', 'untested'], provider = true }) {
  const s = setup();
  commit(s.acmeApi, { 'src/a.ts': FILE });
  provide(s, { current: 's1', snapshots: { s1: { symbols: SYMBOLS } }, tests });
  writeFileSync(logFile(s), '');
  if (provider) {
    const cfg = join(s.data, 'config.json');
    writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), impactProvider: { command: [process.execPath, PROVIDER, stateFile(s), logFile(s)] } }));
  }
  s.ids = {};
  for (const n of names) {
    const r = exec(s, ['remember', '--scope', 'repository', '--type', 'hazard', '--anchor', key(n), '--', `${n} must keep its contract`]);
    assert.equal(r.status, 0, r.stderr);
    s.ids[n] = /remembered (m-[0-9a-f]+)/.exec(r.stdout)[1];
  }
  writeFileSync(logFile(s), '');
  return s;
}
const refresh = (s) => {
  const r = exec(s, ['anchors', 'refresh']);
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const CORE_TESTS = [test_('mentionsCore', 'reference', 3), test_('importsCore', 'import', 1), test_('serviceDoubles', 'call', 12)];

test('US1.1 a hazard on core records serviceDoubles with its path and line, never a test that only references or imports it', () => {
  const s = world({ tests: { [key('core')]: CORE_TESTS } });
  refresh(s);
  assert.deepEqual(anchorOf(s, s.ids.core).test, { name: 'serviceDoubles', path: 'test/serviceDoubles.test.ts', line: 12 });
  assert.deepEqual(ops(s, 'tests').map((r) => r.key).sort(), [key('core'), key('untested')]);
});

test('US1.2 a symbol reached only by an import records no test (the lookup was made: core, in the same run, records one)', () => {
  const s = world({ tests: { [key('core')]: CORE_TESTS, [key('untested')]: [test_('importsUntested', 'import', 1)] } });
  refresh(s);
  assert.equal(anchorOf(s, s.ids.untested).test, undefined);
  assert.ok(ops(s, 'tests').some((r) => r.key === key('untested')), 'the provider was asked about untested');
  assert.equal(anchorOf(s, s.ids.core).test?.name, 'serviceDoubles');
});

test('edge: call, transitive_call, dispatch and observed count; reference, import and an unknown kind never do', () => {
  const kinds = { viaRef: 'reference', viaCall: 'call', viaTransitive: 'transitive_call', viaDispatch: 'dispatch', viaObserved: 'observed', viaStatic: 'static' };
  const s = world({ names: Object.keys(kinds), tests: Object.fromEntries(Object.entries(kinds).map(([n, e]) => [key(n), [test_(`t_${n}`, e)]])) });
  refresh(s);
  const got = Object.fromEntries(Object.keys(kinds).map((n) => [n, anchorOf(s, s.ids[n]).test?.name]));
  assert.deepEqual(got, { viaRef: undefined, viaCall: 't_viaCall', viaTransitive: 't_viaTransitive', viaDispatch: 't_viaDispatch', viaObserved: 't_viaObserved', viaStatic: undefined });
});

test('edge: the nearest executing test wins: a direct call beats a transitive one listed before it', () => {
  const s = world({ tests: { [key('core')]: [test_('far', 'transitive_call', 4), test_('near', 'call', 9)] } });
  refresh(s);
  assert.equal(anchorOf(s, s.ids.core).test.name, 'near');
});

test('US1.3 a recalled item with a test ends its row with test: name path:line, within 60 estimated tokens, even when the statement is long', () => {
  const s = world({ tests: { [key('core')]: CORE_TESTS } });
  refresh(s);
  const long = `${'x'.repeat(400)} long statement`;
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare('UPDATE items SET statement = ? WHERE id = ?').run(long, s.ids.core);
  db.close();
  commit(s.acmeApi, { 'src/a.ts': `${FILE}// edited\n` });
  const related = exec(s, ['recall', '--diff', 'HEAD~1..HEAD']).stdout.split('\n');
  const withTest = related.find((l) => l.includes(s.ids.core));
  assert.ok(withTest.endsWith(' · test: serviceDoubles test/serviceDoubles.test.ts:12'), withTest);
  assert.ok(tokens(withTest) <= 60, `${tokens(withTest)} tokens`);
  const without = related.find((l) => l.includes(s.ids.untested));
  assert.doesNotMatch(without, /test:/, 'an item with no test shows none');
});

test('FR-001 the lookup is made once per snapshot, not on every refresh, and again when the snapshot moves', () => {
  const s = world({ tests: { [key('core')]: CORE_TESTS } });
  refresh(s);
  assert.equal(ops(s, 'tests').length, 2);
  writeFileSync(logFile(s), '');
  refresh(s);
  assert.equal(ops(s, 'tests').length, 0, 'nothing changed: no lookups');
  provide(s, { current: 's2', snapshots: { s2: { symbols: SYMBOLS } }, tests: { [key('core')]: [test_('newTest', 'call', 2)] } });
  refresh(s);
  assert.equal(anchorOf(s, s.ids.core).test.name, 'newTest');
  assert.equal(anchorOf(s, s.ids.core).testsAt, 's2');
});

test('edge: tests are never looked up inside a hook; the detached job asks once the provider answers', async () => {
  const s = world({ tests: { [key('core')]: CORE_TESTS } });
  provide(s, { mode: 'gate', gate: join(s.base, 'gate') });
  const r = sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(r.status, 0, r.stderr);
  // The provider answers nothing until the gate opens, so the job cannot have got as far as the tests op: any request now is the hook's.
  assert.equal(ops(s, 'tests').length, 0);
  writeFileSync(join(s.base, 'gate'), '');
  for (const end = Date.now() + 120_000; anchorOf(s, s.ids.core).test === undefined && Date.now() < end;) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(anchorOf(s, s.ids.core).test?.name, 'serviceDoubles', 'the job recorded the test');
  assert.ok(ops(s, 'tests').length > 0);
});

test('SC-002 memory report counts the code items that name an executing test', () => {
  const s = world({ tests: { [key('core')]: CORE_TESTS } });
  refresh(s);
  const out = exec(s, ['report', '--tenant', 'acme']).stdout;
  assert.match(out, /Code items naming an executing test: 1 of 2/);
});

test('edge: with no provider configured memory keeps working and says so', () => {
  const s = world({ tests: {}, provider: false });
  const r = exec(s, ['report', '--tenant', 'acme']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Code items naming an executing test: none, no code anchor provider is configured/);
  assert.equal(anchorOf(s, s.ids.core).test, undefined);
});
