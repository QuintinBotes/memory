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

// Review of #75: bounded lookups, a failing tests op never costs an anchor its move, validated entries, bounded rows.
const logEvents = (s) => (existsSync(join(s.data, 'logs/anchors.jsonl')) ? readFileSync(join(s.data, 'logs/anchors.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : []);
const FIVE = ['core', 'untested', 'viaRef', 'viaCall', 'viaTransitive'];

test('review 1: a run makes at most MEMORY_TESTS_PER_RUN lookups and the next run continues (120 anchors on a new snapshot, cap 50)', () => {
  const s = setup();
  const names = Array.from({ length: 120 }, (_, i) => `f${String(i).padStart(3, '0')}`);
  commit(s.acmeApi, { 'src/b.ts': lines(...names.flatMap((n) => [`export function ${n}() {`, `  return '${n}';`, '}'])) });
  const syms = names.map((n, i) => ({ key: `src/b.ts#${n}#function`, kind: 'function', signature: `${n}()`, start: i * 3 + 1, end: i * 3 + 3, hash: `H${n}` }));
  provide(s, { current: 's1', snapshots: { s1: { symbols: syms } }, tests: Object.fromEntries(syms.map((x) => [x.key, [test_('t', 'call', 3)]])) });
  const cfg = join(s.data, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), impactProvider: { command: [process.execPath, PROVIDER, stateFile(s), logFile(s)] } }));
  for (const x of syms) {
    const r = exec(s, ['remember', '--scope', 'repository', '--type', 'hazard', '--anchor', x.key, '--', `${x.key} is fragile`]);
    assert.equal(r.status, 0, r.stderr);
  }
  provide(s, { current: 's2', snapshots: { s2: { symbols: syms } } });
  writeFileSync(logFile(s), '');
  const named = () => sql(s, "SELECT anchors_json FROM items WHERE anchors_json LIKE '%\"test\"%'").length;
  const env = { MEMORY_TESTS_PER_RUN: '50' };
  const go = () => run(['anchors', 'refresh'], { cwd: s.acmeApi, data: s.data, config: s.configA, env });
  assert.equal(go().status, 0);
  assert.equal(ops(s, 'tests').length, 50);
  assert.equal(named(), 50);
  assert.ok(logEvents(s).some((e) => e.event === 'capped' && e.testsLeft === 70), 'the cap is logged with what is left');
  go();
  go();
  assert.equal(ops(s, 'tests').length, 120, 'each anchor was asked once over the three runs');
  assert.equal(named(), 120);
});

test('review 2 and 3: the first tests failure stops lookups for the run, and a refused, garbage, no_snapshot or hung tests op leaves the other anchors moves applied', () => {
  for (const testsMode of ['refuse', 'garbage', 'no_snapshot']) {
    const s = world({ names: FIVE, tests: { [key('core')]: CORE_TESTS } });
    provide(s, { testsMode });
    refresh(s);
    assert.equal(ops(s, 'tests').length, 1, `${testsMode}: one failed lookup ends the lookups`);
    assert.ok(logEvents(s).some((e) => e.event === 'tests_skipped'), testsMode);
    assert.equal(logEvents(s).some((e) => e.event === 'provider_failed'), false, `${testsMode}: the provider did not fail`);
    assert.equal(anchorOf(s, s.ids.core).test, undefined);
  }
});

test('review 3: a tests failure on one anchor does not undo a move applied in the same run (control: without the failure the test is recorded)', () => {
  const renamed = (s, mode) => {
    const moved = `export function movedCore() {\n  return 'core';\n}\n`;
    commit(s.acmeApi, { 'src/a.ts': FILE.replace(/^export function core\(\) \{\n  return 'core';\n\}\n/, moved) });
    const symbols = SYMBOLS.map((x) => (x.key === key('core') ? { ...x, key: 'src/a.ts#movedCore#function', signature: 'movedCore()', hash: x.hash } : x));
    provide(s, { current: 's2', snapshots: { s2: { symbols } }, testsMode: mode, tests: { 'src/a.ts#movedCore#function': CORE_TESTS } });
  };
  for (const mode of [null, 'refuse', 'garbage', 'no_snapshot', 'hang']) {
    const s = world({ names: ['core', 'untested'], tests: {} });
    renamed(s, mode ?? undefined);
    refresh(s);
    const a = anchorOf(s, s.ids.core);
    assert.equal(a.symbol, 'src/a.ts#movedCore#function', `${mode}: the move was applied`);
    assert.equal(sql(s, "SELECT status FROM items WHERE id = ?", s.ids.core)[0].status, 'active');
    assert.equal(a.test?.name, mode === null ? 'serviceDoubles' : undefined, `${mode}`);
  }
});

test('review 4: invalid tests entries are dropped, valid ones next to them still count', () => {
  const bad = [
    { key: 'only#two', evidence: 'call' },
    { key: 'a#b#c#d', evidence: 'call' },
    { key: '/abs/x.test.ts#t#test', evidence: 'call' },
    { key: '../x.test.ts#t#test', evidence: 'call' },
    { key: 'a/../x.test.ts#t#test', evidence: 'call' },
    { key: './x.test.ts#t#test', evidence: 'call' },
    { key: 'a//x.test.ts#t#test', evidence: 'call' },
    { key: `${'p'.repeat(201)}#t#test`, evidence: 'call' },
    { key: `x.test.ts#${'n'.repeat(201)}#test`, evidence: 'call' },
    { key: 'x.test.ts#t#test', evidence: 'call', line: 0 },
    { key: 'x.test.ts#t#test', evidence: 'call', line: 1.5 },
    { key: 'x.test.ts#t#test', evidence: 'call', line: 10_000_001 },
    { key: 'x.test.ts#t#test', evidence: 'call', line: '7' },
    { key: 'x.test.ts#t#test' },
    { evidence: 'call' },
    null,
    'text',
  ];
  const s = world({ tests: { [key('core')]: [...bad, test_('good', 'call', 1e7)] } });
  refresh(s);
  assert.deepEqual(anchorOf(s, s.ids.core).test, { name: 'good', path: 'test/good.test.ts', line: 1e7 });
  // Control: every bad entry alone records nothing, so each rule is what dropped it.
  for (const [i, entry] of bad.entries()) {
    const one = world({ names: ['core'], tests: { [key('core')]: [entry] } });
    refresh(one);
    assert.equal(anchorOf(one, one.ids.core).test, undefined, `entry ${i} ${JSON.stringify(entry)}`);
  }
});

test('review 5: a row stays within 60 tokens with a long test name, a long taint and a long why', () => {
  const s = world({ tests: { [key('core')]: [test_('n'.repeat(150), 'call', 12)] } });
  refresh(s);
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare('UPDATE items SET statement = ? WHERE id = ?').run('y'.repeat(300), s.ids.core);
  db.prepare('UPDATE evidence SET taint = ? WHERE item_id = ?').run('t'.repeat(110), s.ids.core);
  db.close();
  commit(s.acmeApi, { 'src/a.ts': `${FILE}// edited\n` });
  const row = exec(s, ['recall', '--diff', 'HEAD~1..HEAD']).stdout.split('\n').find((l) => l.includes(s.ids.core));
  assert.ok(row, 'the item is recalled');
  assert.ok(tokens(row) <= 60, `${tokens(row)} tokens: ${row}`);
  assert.match(row, /test: /);
});
