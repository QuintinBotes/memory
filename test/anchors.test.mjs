import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, remember, run, runAsync, commit, sessionStart } from './helpers.mjs';

// Slice 9 (#10): symbol anchors that follow the code, through a fake code anchor provider (test/fake-provider.mjs).
const here = dirname(fileURLToPath(import.meta.url));
const PROVIDER = join(here, 'fake-provider.mjs');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const KEY = 'src/a.ts#Ledger.consume#method';
const lines = (...ls) => `${ls.join('\n')}\n`;
const A = ['// header', 'export class Ledger {', '  consume(n: number): number {', '    return n - 1;', '  }', '}'];
const sym = (key, kind, signature, start, end, hash) => ({ key, kind, signature, start, end, hash });
const CLASS = sym('src/a.ts#Ledger#class', 'class', 'class Ledger', 2, 6, 'C1');
const CONSUME = sym(KEY, 'method', 'consume(n: number): number', 3, 5, 'H1');
const HAZARD = 'The ledger consumes one unit per call';

const dbOf = (s) => new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
function sql(s, text, ...args) {
  const db = dbOf(s);
  try {
    return db.prepare(text).all(...args);
  } finally {
    db.close();
  }
}
const stateFile = (s) => join(s.base, 'provider-state.json');
const logFile = (s) => join(s.base, 'provider.log');
const requests = (s) => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : []);
/** Forgets the requests so far: what a test counts is what the step under test asked. */
const reset = (s) => writeFileSync(logFile(s), '');
const ops = (s, op) => requests(s).filter((r) => r.op === op);
const head = (s) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.acmeApi, encoding: 'utf8' }).trim();
/** Merges `patch` into the provider's state. A snapshot is indexed at HEAD unless it names its commit or has `noCommit`. */
function provide(s, patch) {
  const was = existsSync(stateFile(s)) ? JSON.parse(readFileSync(stateFile(s), 'utf8')) : { repository: 'acme/api', snapshots: {} };
  const snapshots = Object.fromEntries(Object.entries(patch.snapshots ?? {}).map(([id, v]) => [id, v.commit === undefined && v.noCommit !== true ? { ...v, commit: head(s) } : v]));
  writeFileSync(stateFile(s), JSON.stringify({ ...was, ...patch, snapshots: { ...was.snapshots, ...snapshots } }));
}
const exec = (s, args, extra = {}) => run(args, { cwd: s.acmeApi, data: s.data, config: s.configA, ...extra });
const execAsync = (s, args, extra = {}) => runAsync(args, { cwd: s.acmeApi, data: s.data, config: s.configA, ...extra });
const refresh = (s, ...flags) => exec(s, ['anchors', 'refresh', ...flags]);
/** The provider is the shared impactProvider command (slice 14's): the fake reads its fixture and log from its arguments. */
const configure = (s) => {
  const cfg = join(s.data, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), impactProvider: { command: [process.execPath, PROVIDER, stateFile(s), logFile(s)] } }));
};

/** An acme/api checkout with src/a.ts, a provider at snapshot s1 and one item anchored to the method. */
function world({ files = { 'src/a.ts': lines(...A) }, symbols = [CLASS, CONSUME], statement = HAZARD, key = KEY } = {}) {
  const s = setup();
  commit(s.acmeApi, files);
  provide(s, { current: 's1', snapshots: { s1: { symbols } } });
  writeFileSync(logFile(s), '');
  configure(s);
  const r = exec(s, ['remember', '--scope', 'repository', '--type', 'hazard', '--anchor', key, '--', statement]);
  assert.equal(r.status, 0, r.stderr);
  s.id = /remembered (m-[0-9a-f]+)/.exec(r.stdout)[1];
  reset(s);
  return s;
}
const item = (s, id = s.id) => {
  const row = sql(s, 'SELECT status, status_reason, origin_trust, anchors_json FROM items WHERE id = ?', id)[0];
  return { ...row, anchor: JSON.parse(row.anchors_json)[0] };
};
const moves = (s, id = s.id) => sql(s, "SELECT audit_id, metadata_json FROM audit_events WHERE action = 'anchor_moved' AND subject_id = ? ORDER BY created_at", id).map((r) => ({ id: r.audit_id, ...JSON.parse(r.metadata_json) }));

test('FR-003 remembering at a symbol key stores the provider facts, the cited-text hash, the file hash and the snapshot', () => {
  const s = world();
  const { anchor } = item(s);
  assert.deepEqual(
    { path: anchor.path, symbol: anchor.symbol, signature: anchor.signature, start: anchor.start, end: anchor.end, contentHash: anchor.contentHash, snapshot: anchor.snapshot },
    { path: 'src/a.ts', symbol: KEY, signature: 'consume(n: number): number', start: 3, end: 5, contentHash: 'H1', snapshot: 's1' },
  );
  assert.equal(anchor.citedHash, sha(A.slice(2, 5).join('\n')));
  assert.equal(anchor.fileHash, sha(lines(...A)));
  assert.match(anchor.commit, /^[0-9a-f]{40}$/);
});

test('US1.1 the key unchanged and the cited text present: the item stays current and its lines are updated', () => {
  const s = world();
  commit(s.acmeApi, { 'src/a.ts': lines('// one', '// two', ...A) });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [{ ...CLASS, start: 4, end: 8 }, { ...CONSUME, start: 5, end: 7 }] } } });
  const r = refresh(s);
  assert.equal(r.status, 0, r.stderr);
  const it = item(s);
  assert.equal(it.status, 'active');
  assert.deepEqual([it.anchor.start, it.anchor.end, it.anchor.snapshot, it.anchor.symbol], [5, 7, 's2', KEY]);
  assert.equal(it.anchor.fileHash, sha(lines('// one', '// two', ...A)));
  assert.equal(moves(s).length, 0, 'a line shift of the same key is not a move');
});

test('US1.2 a changed signature makes the item stale with that reason', () => {
  const s = world();
  const changed = [...A];
  changed[2] = '  consume(n: number, by: number): number {';
  commit(s.acmeApi, { 'src/a.ts': lines(...changed) });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [CLASS, { ...CONSUME, signature: 'consume(n: number, by: number): number', hash: 'H2' }] } } });
  assert.equal(refresh(s).status, 0);
  assert.deepEqual([item(s).status, item(s).status_reason], ['stale', 'signature changed']);
});

test('US1.2 the cited text gone makes the item stale with that reason', () => {
  const s = world();
  const changed = [...A];
  changed[3] = '    return n - 2;';
  commit(s.acmeApi, { 'src/a.ts': lines(...changed) });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [CLASS, { ...CONSUME, hash: 'H2' }] } } });
  assert.equal(refresh(s).status, 0);
  assert.deepEqual([item(s).status, item(s).status_reason], ['stale', 'cited text gone']);
  // Positive control for the two stale tests above: the same refresh leaves an unchanged symbol current.
  const t = world();
  provide(t, { current: 's2', snapshots: { s2: { symbols: [CLASS, CONSUME] } } });
  refresh(t);
  assert.equal(item(t).status, 'active');
});

/** The method renamed to `spend`, its declaration lines identical but for the name. */
function renamed(s, { extra = [], after = A.map((l) => l.replace('consume', 'spend')) } = {}) {
  commit(s.acmeApi, { 'src/a.ts': lines(...after) });
  const spend = sym('src/a.ts#Ledger.spend#method', 'method', 'spend(n: number): number', 3, 5, 'H1');
  provide(s, { current: 's2', snapshots: { s2: { symbols: [CLASS, spend, ...extra] } } });
  return spend;
}

test('US1.3 the key gone and one added symbol of the same kind with the same hash: the anchor moves, status and authority stay, and the move is logged', () => {
  const s = world();
  const before = item(s);
  const spend = renamed(s);
  assert.equal(refresh(s).status, 0);
  const it = item(s);
  assert.equal(it.status, 'active');
  assert.equal(it.origin_trust, before.origin_trust);
  assert.deepEqual([it.anchor.symbol, it.anchor.signature, it.anchor.snapshot, it.anchor.contentHash], [spend.key, spend.signature, 's2', 'H1']);
  assert.equal(it.anchor.citedHash, sha(A.slice(2, 5).join('\n').replace('consume', 'spend')), 'the cited text hash is of the declaration as it is now');
  const [move] = moves(s);
  assert.equal(moves(s).length, 1);
  assert.deepEqual([move.from.symbol, move.to.symbol, move.from.contentHash, move.to.contentHash, move.from.snapshot, move.to.snapshot], [KEY, spend.key, 'H1', 'H1', 's1', 's2']);
});

test('US1.3 a file moved with its symbol follows it to the new path', () => {
  const s = world();
  commit(s.acmeApi, { 'src/a.ts': null, 'src/b.ts': lines(...A) });
  provide(s, { current: 's2', snapshots: { s2: { symbols: ['Ledger#class', 'Ledger.consume#method'].map((k, i) => ({ ...[CLASS, CONSUME][i], key: `src/b.ts#${k}` })) } } });
  assert.equal(refresh(s).status, 0);
  const it = item(s);
  assert.deepEqual([it.status, it.anchor.path, it.anchor.symbol], ['active', 'src/b.ts', 'src/b.ts#Ledger.consume#method']);
  assert.deepEqual(sql(s, 'SELECT path FROM item_anchors WHERE item_id = ?', s.id).map((r) => r.path), ['src/b.ts'], 'the anchor-path index follows the move');
});

test('US1.4 memory anchors undo restores the exact previous anchor and logs the undo; a second undo is refused', () => {
  const s = world();
  const before = item(s).anchor;
  renamed(s);
  refresh(s);
  const [move] = moves(s);
  const r = exec(s, ['anchors', 'undo', move.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(item(s).anchor, before);
  assert.deepEqual(sql(s, "SELECT metadata_json FROM audit_events WHERE action = 'undone' AND subject_id = ?", move.id).map((x) => JSON.parse(x.metadata_json)), [{ action: 'anchor_moved', item: s.id }]);
  assert.notEqual(exec(s, ['anchors', 'undo', move.id]).status, 0);
  assert.notEqual(exec(s, ['anchors', 'undo', 'no-such-move']).status, 0);
  // The owner said no to that move: the next refresh does not make it again.
  refresh(s);
  assert.equal(moves(s).length, 1);
  assert.deepEqual([item(s).status, item(s).status_reason], ['stale', 'key gone']);
});

const review = (s) => exec(s, ['review']).stdout;

test('US1.5 the key gone and the only candidate of the same name with another hash: stale, and a re-anchor proposal waits in memory review', () => {
  const s = world();
  // Same qualified name, new kind of declaration text: a different hash.
  const swapped = sym('src/a.ts#Ledger.consume#function', 'function', 'function consume(n: number): number', 3, 5, 'H9');
  commit(s.acmeApi, { 'src/a.ts': lines('// header', 'export class Ledger {', '  static consume = (n: number) => n - 1;', '}') });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [CLASS, swapped] } } });
  assert.equal(refresh(s).status, 0);
  assert.deepEqual([item(s).status, item(s).status_reason], ['stale', 'key gone']);
  assert.equal(moves(s).length, 0);
  const out = review(s);
  assert.match(out, new RegExp(s.id));
  assert.match(out, /re-anchor/);
  assert.ok(out.includes(swapped.key), out);
  // Positive control for "no proposal": a candidate of another name, same hash, is not offered.
  const t = world();
  const other = sym('src/a.ts#Ledger.other#function', 'function', 'function other()', 3, 5, 'H9');
  provide(t, { current: 's2', snapshots: { s2: { symbols: [CLASS, other] } } });
  refresh(t);
  assert.equal(item(t).status, 'stale');
  assert.doesNotMatch(review(t), /re-anchor/);
});

test('edge: two added symbols with the same hash never move the anchor; the item is stale and the proposal lists both', () => {
  const s = world();
  const a = sym('src/a.ts#Ledger.spend#method', 'method', 'spend(n: number): number', 3, 5, 'H1');
  const b = sym('src/a.ts#Ledger.burn#method', 'method', 'burn(n: number): number', 7, 9, 'H1');
  commit(s.acmeApi, { 'src/a.ts': lines(...A.map((l) => l.replace('consume', 'spend'))) });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [CLASS, a, b] } } });
  refresh(s);
  assert.deepEqual([item(s).status, item(s).anchor.symbol], ['stale', KEY]);
  assert.equal(moves(s).length, 0);
  const out = review(s);
  assert.ok(out.includes(a.key) && out.includes(b.key), out);
});

test('US1.6 a provider answer about a repository outside the tenant is dropped before any lookup', () => {
  const s = world();
  const before = item(s).anchors_json;
  renamed(s);
  provide(s, { answerRepository: 'beta/web' });
  const r = refresh(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(item(s).anchors_json, before);
  assert.equal(ops(s, 'changes').length, 1, 'the changes were asked for');
  assert.equal(ops(s, 'key').length, 0, 'and nothing was looked up from the dropped answer');
  assert.match(r.stderr + r.stdout, /beta\/web/);
  // Positive control: the same world with the right repository does look up and move.
  provide(s, { answerRepository: null });
  refresh(s);
  assert.ok(ops(s, 'key').length > 0);
  assert.notEqual(item(s).anchors_json, before);
});

test('edge: only anchors in files the provider says changed are re-resolved', () => {
  const s = world({ files: { 'src/a.ts': lines(...A), 'src/b.ts': lines('export const b = 1;'), 'src/c.ts': lines('export const c = 1;') } });
  const bSym = sym('src/b.ts#b#const', 'const', 'const b', 1, 1, 'B1');
  const cSym = sym('src/c.ts#c#const', 'const', 'const c', 1, 1, 'C1');
  provide(s, { current: 's1', snapshots: { s1: { symbols: [CLASS, CONSUME, bSym, cSym] } } });
  for (const [key, text] of [[bSym.key, 'Module b is frozen'], [cSym.key, 'Module c is frozen']]) {
    assert.equal(exec(s, ['remember', '--scope', 'repository', '--anchor', key, '--', text]).status, 0);
  }
  reset(s);
  commit(s.acmeApi, { 'src/b.ts': lines('// note', 'export const b = 1;') });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [CLASS, CONSUME, { ...bSym, start: 2, end: 2 }, cSym] } } });
  refresh(s);
  assert.deepEqual(ops(s, 'key').map((r) => r.key), [bSym.key], 'one file changed, one lookup');
  assert.equal(ops(s, 'changes').length, 1, 'one changes request per last-anchored snapshot');
});

test('edge: an older snapshot the provider no longer has: every anchor is re-resolved', () => {
  const s = world({ files: { 'src/a.ts': lines(...A), 'src/b.ts': lines('export const b = 1;') } });
  const bSym = sym('src/b.ts#b#const', 'const', 'const b', 1, 1, 'B1');
  provide(s, { current: 's1', snapshots: { s1: { symbols: [CLASS, CONSUME, bSym] } } });
  assert.equal(exec(s, ['remember', '--scope', 'repository', '--anchor', bSym.key, '--', 'Module b is frozen']).status, 0);
  reset(s);
  // s1 is gone from the provider; s3 is current and holds both symbols as they were.
  provide(s, { current: 's3', snapshots: { s3: { symbols: [CLASS, CONSUME, bSym] } } });
  const was = JSON.parse(readFileSync(stateFile(s), 'utf8'));
  delete was.snapshots.s1;
  writeFileSync(stateFile(s), JSON.stringify(was));
  refresh(s);
  assert.deepEqual(ops(s, 'key').map((r) => r.key).sort(), [bSym.key, KEY].sort());
  assert.equal(item(s).anchor.snapshot, 's3');
});

test('edge: no provider configured: the path-and-hash check applies, and remember says it anchored to the file', () => {
  const s = setup();
  commit(s.acmeApi, { 'src/a.ts': lines(...A) });
  const r = remember(s.acmeApi, s.data, s.configA, HAZARD, '--scope', 'repository', '--anchor', KEY);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no code anchor provider/);
  const id = /remembered (m-[0-9a-f]+)/.exec(r.stdout)[1];
  assert.deepEqual([item(s, id).anchor.path, item(s, id).anchor.symbol], ['src/a.ts', undefined]);
  commit(s.acmeApi, { 'src/a.ts': lines('// changed', ...A) });
  assert.doesNotMatch(sessionStart(s.acmeApi, s.data, s.configA).stdout, /no such thing/);
  // The file's hash changed, so the path check retires the item, as it did before this slice.
  assert.equal(item(s, id).status, 'stale');
  assert.equal(sql(s, "SELECT count(*) AS n FROM audit_events WHERE action = 'item_stale'")[0].n, 1);
  assert.equal(requests(s).length, 0, 'no provider was asked');
  // The refresh with no provider says so and changes nothing.
  assert.match(exec(s, ['anchors', 'refresh']).stderr, /no code anchor provider/);
});

for (const mode of ['crash', 'garbage', 'hang']) {
  test(`edge: a provider that ${mode === 'crash' ? 'fails' : mode === 'hang' ? 'times out' : 'answers with garbage'} leaves every anchor as it was, logs the failure and says memory falls back to path anchors`, () => {
    const s = world();
    const before = item(s).anchors_json;
    renamed(s);
    provide(s, { mode });
    const r = refresh(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(item(s).anchors_json, before);
    assert.equal(item(s).status, 'active');
    assert.match(r.stderr, /path anchors/);
    const log = readFileSync(join(s.data, 'logs/anchors.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).event, 'provider_failed');
    // The fallback is real: with the provider down, the path check retires an item whose file moved on.
    assert.equal(exec(s, ['list']).status, 0);
    assert.deepEqual([item(s).status, item(s).status_reason], ['stale', 'cited text gone']);
  });
}

test('while the provider answers, the hooks leave its anchors to the refresh job; before its first refresh, or once it fails, they are checked by path', () => {
  const s = world();
  // No state file: nothing says the provider has answered yet, so the hooks check by path.
  const t = world();
  commit(t.acmeApi, { 'src/a.ts': lines('// header', 'export class Ledger {', '  consume(n: number): number {', '    return n - 9;', '  }', '}') });
  assert.equal(exec(t, ['list']).status, 0);
  assert.equal(item(t).status, 'stale', 'no successful refresh yet: checked by path');
  assert.equal(refresh(s).status, 0);
  reset(s);
  commit(s.acmeApi, { 'src/a.ts': lines('// header', 'export class Ledger {', '  consume(n: number): number {', '    return n - 9;', '  }', '}') });
  provide(s, { current: 's1' });
  assert.equal(exec(s, ['list']).status, 0);
  assert.equal(item(s).status, 'active', 'the path check did not run on an anchor the provider owns');
  assert.equal(requests(s).length, 0, 'the hook asked the provider nothing');
});

test('FR-005 the refresh never runs inside a hook: session start returns while the provider has not answered, and the detached job lands after', async () => {
  const s = world();
  renamed(s);
  provide(s, { mode: 'gate', gate: join(s.base, 'gate') });
  const r = run(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: s.acmeApi }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(item(s).anchor.symbol, KEY, 'the hook returned before any move');
  writeFileSync(join(s.base, 'gate'), '');
  for (let i = 0; i < 500 && moves(s).length === 0; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(moves(s).length, 1, 'the detached job made the move');
});

test('FR-001 impact and tests are answered by the provider in the impact provider\'s shape, and dropped when they name another repository', () => {
  const s = world();
  const caller = { path: 'src/c.ts', symbol: 'src/c.ts#Caller#function', relation: 'caller', status: 'neither' };
  provide(s, { dependents: [caller, { ...caller, path: 'other/x.ts', repository: 'beta/web' }], tests: { [KEY]: [{ key: 'test/a.test.ts#consumes#test', evidence: 'static' }] } });
  const impact = exec(s, ['anchors', 'impact', KEY]);
  assert.equal(impact.status, 0, impact.stderr);
  assert.deepEqual(JSON.parse(impact.stdout).dependents, [caller], 'a dependent of another repository is dropped');
  const tests = exec(s, ['anchors', 'tests', KEY]);
  assert.deepEqual(JSON.parse(tests.stdout).tests, [{ key: 'test/a.test.ts#consumes#test', evidence: 'static' }]);
  provide(s, { answerRepository: 'beta/web' });
  assert.notEqual(exec(s, ['anchors', 'impact', KEY]).status, 0);
  // The request was one JSON object, naming the repository; the provider was run without a shell and with PATH and HOME only.
  assert.deepEqual(ops(s, 'symbol_impact')[0], { op: 'symbol_impact', repository: 'acme/api', keys: [KEY] });
});

test('FR-001 symbol_at answers the symbol enclosing a path and line', () => {
  const s = world();
  const r = exec(s, ['anchors', 'at', 'src/a.ts:4']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).symbol.key, KEY, 'the innermost symbol, not the class around it');
});

test('SC-001 in a rename-and-move suite at least 95% of anchors survive and none is re-anchored to the wrong symbol', () => {
  const names = ['amber', 'basalt', 'cobalt', 'dune', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'jasper', 'kelp', 'lagoon', 'mesa', 'nectar', 'onyx', 'prism', 'quartz', 'raven', 'saffron', 'tundra'];
  const decoys = ['umber', 'velvet', 'willow', 'xenon', 'yarrow'];
  const fileOf = (n) => `src/${n}.ts`;
  const decl = (n, body = 'return 1;') => [`export function ${n}() {`, `  ${body}`, '}'];
  const files = Object.fromEntries([...names, ...decoys].map((n) => [fileOf(n), lines(...decl(n))]));
  const at = (n, i, hash) => sym(`${fileOf(n)}#${n}#function`, 'function', `function ${n}()`, 1, 3, hash ?? `hash-${i}`);
  const s = world({ files, symbols: [at(names[0], 0)], statement: 'Hazard zero is real', key: at(names[0], 0).key });
  const all = [...names, ...decoys].map((n, i) => at(n, i));
  provide(s, { current: 's1', snapshots: { s1: { symbols: all } } });
  const ids = new Map([[names[0], s.id]]);
  const words = ['trellis', 'cormorant', 'abacus', 'wicker', 'lantern', 'mosaic', 'pewter', 'quince', 'sundial', 'tapestry', 'umbra', 'vellum', 'zephyr', 'bramble', 'cinder', 'dolmen', 'eclipse', 'fresco', 'gossamer', 'hearth', 'iris', 'juniper', 'kestrel', 'loom', 'marble'];
  [...names, ...decoys].slice(1).forEach((n, i) => {
    const r = exec(s, ['remember', '--scope', 'repository', '--type', 'hazard', '--anchor', at(n, i + 1).key, '--', `The ${words[i]} of ${n} cannot be reordered`]);
    assert.equal(r.status, 0, r.stderr);
    ids.set(n, /remembered (m-[0-9a-f]+)/.exec(r.stdout)[1]);
  });
  // Ten renames in place, ten moves to a new file; five decoys have their bodies edited and must not be re-anchored.
  const next = [];
  const change = {};
  names.forEach((n, i) => {
    const base = at(n, i);
    if (i < 10) {
      const to = `${n}2`;
      change[fileOf(n)] = lines(...decl(to));
      next.push({ ...base, key: `${fileOf(n)}#${to}#function`, signature: `function ${to}()` });
    } else {
      change[fileOf(n)] = null;
      change[`lib/${n}.ts`] = lines(...decl(n));
      next.push({ ...base, key: `lib/${n}.ts#${n}#function` });
    }
  });
  decoys.forEach((n, i) => {
    change[fileOf(n)] = lines(...decl(n, 'return 2;'));
    next.push(at(n, names.length + i, `changed-${i}`));
  });
  commit(s.acmeApi, change);
  provide(s, { current: 's2', snapshots: { s2: { symbols: next } } });
  assert.equal(refresh(s).status, 0);
  const expected = new Map(names.map((n, i) => [n, next[i].key]));
  let survived = 0;
  for (const [n, id] of ids) {
    if (!expected.has(n)) continue;
    const it = item(s, id);
    if (it.status === 'active' && it.anchor.symbol === expected.get(n)) survived++;
    assert.ok(it.status !== 'active' || it.anchor.symbol === expected.get(n), `${n} was re-anchored to ${it.anchor.symbol}`);
  }
  assert.ok(survived / names.length >= 0.95, `${survived} of ${names.length} survived`);
  for (const n of decoys) {
    const it = item(s, ids.get(n));
    assert.equal(it.status, 'stale', `${n}: its body changed`);
    assert.equal(it.anchor.symbol, `${fileOf(n)}#${n}#function`, `${n} stays on its old key`);
  }
});

// ---- Review round: findings 5 to 16 ----
const flags = (s) => JSON.parse(readFileSync(join(s.data, 'anchors-state.json'), 'utf8'));
const setStatus = (s, status, reason) => {
  const db = dbOf(s);
  db.prepare('UPDATE items SET status = ?, status_reason = ? WHERE id = ?').run(status, reason, s.id);
  db.close();
};

test('finding 5 a move does not revive a stale item: status, reason and trust stay as they were', () => {
  const s = world();
  const before = item(s);
  setStatus(s, 'stale', 'key gone');
  const spend = renamed(s);
  assert.equal(refresh(s).status, 0);
  const it = item(s);
  assert.equal(it.anchor.symbol, spend.key, 'the anchor did move');
  assert.deepEqual([it.status, it.status_reason, it.origin_trust], ['stale', 'key gone', before.origin_trust]);
});

test('finding 6 a body below the minimum size is never moved onto: getX deleted, getY added with the same body', () => {
  const X = 'src/g.ts#Box.getX#method';
  const Y = 'src/g.ts#Box.getY#method';
  const s = world({ files: { 'src/g.ts': 'getX(){return this.x}\n' }, symbols: [sym(X, 'method', 'getX()', 1, 1, 'HG')], key: X });
  commit(s.acmeApi, { 'src/g.ts': 'getY(){return this.x}\n' });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [sym(Y, 'method', 'getY()', 1, 1, 'HG')] } } });
  assert.equal(refresh(s).status, 0);
  assert.deepEqual([item(s).status, item(s).status_reason, item(s).anchor.symbol], ['stale', 'key gone', X]);
  assert.equal(moves(s).length, 0);
});

test('finding 7 a snapshot that is not at HEAD, or does not say where it is, is never moved onto', () => {
  for (const lag of ['behind', 'unknown']) {
    const s = world();
    const spend = renamed(s);
    if (lag === 'unknown') provide(s, { snapshots: { s2: { noCommit: true, symbols: [CLASS, spend] } } });
    else commit(s.acmeApi, { 'src/other.ts': 'export const o = 1;\n' }); // HEAD moves on after the snapshot
    assert.equal(refresh(s).status, 0);
    assert.equal(moves(s).length, 0, lag);
    assert.equal(item(s).anchor.symbol, KEY, lag);
    assert.deepEqual([item(s).status, item(s).status_reason], ['stale', 'snapshot not at HEAD'], lag);
  }
});

/** An item stale on its symbol with two same-hash candidates, ready for `adopt`. */
function proposed() {
  const s = world();
  const a = sym('src/a.ts#Ledger.spend#method', 'method', 'spend(n: number): number', 3, 5, 'H1');
  const b = sym('src/a.ts#Ledger.burn#method', 'method', 'burn(n: number): number', 7, 9, 'H1');
  commit(s.acmeApi, { 'src/a.ts': lines(...A.map((l) => l.replace('consume', 'spend'))) });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [CLASS, a, b] } } });
  refresh(s);
  assert.equal(item(s).status, 'stale');
  return { s, a, b };
}

test('finding 8 adopt moves the anchor to a candidate and brings the item back; a key that is not a candidate is refused; approve is refused', () => {
  const { s, a } = proposed();
  const approve = exec(s, ['approve', s.id]);
  assert.notEqual(approve.status, 0);
  assert.match(approve.stderr, /anchors adopt/);
  assert.equal(item(s).status, 'stale', 'approve changed nothing');
  assert.notEqual(exec(s, ['anchors', 'adopt', s.id, 'src/a.ts#Nope#method']).status, 0);
  const r = exec(s, ['anchors', 'adopt', s.id, a.key]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([item(s).status, item(s).anchor.symbol, item(s).anchor.candidates], ['active', a.key, undefined]);
  assert.equal(moves(s).length, 1);
  assert.equal(exec(s, ['anchors', 'undo', moves(s)[0].id]).status, 0, 'an adoption can be undone like a move');
});

test('finding 8 adopt compares and sets: an item changed while the provider was answering is left alone', async () => {
  const { s, a } = proposed();
  provide(s, { mode: 'gate', gate: join(s.base, 'gate') });
  reset(s);
  const pending = execAsync(s, ['anchors', 'adopt', s.id, a.key]);
  for (let i = 0; i < 500 && requests(s).length === 0; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(requests(s).length, 1, 'the adopt is waiting on the provider');
  const db = dbOf(s);
  db.prepare("UPDATE items SET anchors_json = REPLACE(anchors_json, 'consume', 'changed') WHERE id = ?").run(s.id);
  db.close();
  const changed = item(s).anchors_json;
  writeFileSync(join(s.base, 'gate'), '');
  const r = await pending;
  assert.notEqual(r.status, 0);
  assert.equal(item(s).anchors_json, changed);
  assert.equal(item(s).status, 'stale');
});

test('finding 8 adopt does not force an item active while another of its anchors is stale', () => {
  const { s, a } = proposed();
  const db = dbOf(s);
  const anchors = JSON.parse(db.prepare('SELECT anchors_json FROM items WHERE id = ?').get(s.id).anchors_json);
  anchors.push({ path: 'src/a.ts', start: 1, end: 1, commit: anchors[0].commit, citedHash: 'not-the-hash' });
  db.prepare('UPDATE items SET anchors_json = ? WHERE id = ?').run(JSON.stringify(anchors), s.id);
  db.close();
  assert.equal(exec(s, ['anchors', 'adopt', s.id, a.key]).status, 0);
  assert.equal(JSON.parse(item(s).anchors_json)[0].symbol, a.key);
  assert.equal(item(s).status, 'stale');
});

test('finding 10 one job at a time: a second job exits at once and asks nothing; a lock left by a dead process is taken over', async () => {
  const s = world();
  renamed(s);
  provide(s, { mode: 'gate', gate: join(s.base, 'gate') });
  const first = execAsync(s, ['anchors', 'refresh']);
  for (let i = 0; i < 500 && requests(s).length === 0; i++) await new Promise((ok) => setTimeout(ok, 20));
  const second = exec(s, ['anchors', 'refresh']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /already running/);
  assert.equal(requests(s).length, 1, 'only the first job asked the provider');
  writeFileSync(join(s.base, 'gate'), '');
  assert.equal((await first).status, 0);
  assert.equal(moves(s).length, 1);
  // Control for the stale lock: a lock naming a process that has exited does not stop a job.
  const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  mkdirSync(join(s.data, 'tenants'), { recursive: true });
  writeFileSync(join(s.data, 'tenants/acme.sqlite.anchors.lock'), dead);
  const again = exec(s, ['anchors', 'refresh']);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /already running/);
});

/** Five anchored methods in one file, then every line moved down by one. */
function many() {
  const names = ['amber', 'basalt', 'cobalt', 'dune', 'ember'];
  const body = (n) => [`export function ${n}(a: number): number {`, `  return a + ${n.length};`, '}'];
  const file = names.flatMap(body);
  const at = (i, shift = 0) => sym(`src/m.ts#${names[i]}#function`, 'function', `function ${names[i]}`, i * 3 + 1 + shift, i * 3 + 3 + shift, `h${i}`);
  const s = world({ files: { 'src/m.ts': lines(...file) }, symbols: [at(0)], key: at(0).key, statement: 'Hazard of amber is real' });
  const words = ['trellis', 'cormorant', 'abacus', 'wicker'];
  provide(s, { current: 's1', snapshots: { s1: { symbols: names.map((_, i) => at(i)) } } });
  const ids = [s.id];
  for (let i = 1; i < 5; i++) {
    const r = exec(s, ['remember', '--scope', 'repository', '--type', 'hazard', '--anchor', at(i).key, '--', `The ${words[i - 1]} of ${names[i]} cannot be reordered`]);
    assert.equal(r.status, 0, r.stderr);
    ids.push(/remembered (m-[0-9a-f]+)/.exec(r.stdout)[1]);
  }
  commit(s.acmeApi, { 'src/m.ts': lines('// shifted', ...file) });
  provide(s, { current: 's2', snapshots: { s2: { symbols: names.map((_, i) => at(i, 1)) } } });
  reset(s);
  return { s, ids, at };
}

test('findings 11 and 12 a run is bounded and the rest waits for the next; each anchor is written as it resolves', () => {
  const { s, ids } = many();
  const cap = { MEMORY_ANCHORS_PER_RUN: '2' };
  const snapshots = () => ids.map((id) => item(s, id).anchor.snapshot);
  const r1 = exec(s, ['anchors', 'refresh'], { env: cap });
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(ops(s, 'key').length, 2, 'two anchors resolved, no more');
  assert.equal(snapshots().filter((x) => x === 's2').length, 2);
  const log = readFileSync(join(s.data, 'logs/anchors.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.filter((e) => e.event === 'capped').map((e) => [e.done, e.left]), [[2, 3]]);
  exec(s, ['anchors', 'refresh'], { env: cap });
  exec(s, ['anchors', 'refresh'], { env: cap });
  assert.deepEqual(snapshots(), ['s2', 's2', 's2', 's2', 's2'], 'progress accumulates over runs');
  assert.equal(ops(s, 'key').length, 5, 'no anchor was resolved twice');
});

test('findings 11 and 12 one bad key does not block the rest, and is not counted as the provider failing', () => {
  const { s, ids, at } = many();
  provide(s, { badKeys: [at(1).key] });
  const r = exec(s, ['anchors', 'refresh']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids.map((id) => item(s, id).anchor.snapshot), ['s2', 's1', 's2', 's2', 's2']);
  const log = readFileSync(join(s.data, 'logs/anchors.jsonl'), 'utf8');
  assert.match(log, /anchor_skipped/);
  assert.equal(flags(s)['acme/api'], false, 'the provider did not fail');
});

test('finding 14 the failure flag is kept per repository, a crash of any kind sets it, and another repository cannot clear it', () => {
  const s = world();
  assert.equal(refresh(s).status, 0);
  assert.deepEqual(flags(s), { 'acme/api': false });
  provide(s, { mode: 'crash' });
  assert.equal(refresh(s).status, 0);
  assert.deepEqual(flags(s), { 'acme/api': true });
  // Another repository of the tenant runs a healthy refresh with nothing anchored: it must not touch acme/api's flag.
  provide(s, { mode: null });
  const web = exec(s, ['anchors', 'refresh'], { cwd: s.acmeWeb });
  assert.equal(web.status, 0, web.stderr);
  assert.equal(flags(s)['acme/api'], true);
  // So acme/api is still checked by path: its cited lines changed.
  commit(s.acmeApi, { 'src/a.ts': lines('// header', 'export class Ledger {', '  consume(n: number): number {', '    return n - 9;', '  }', '}') });
  assert.equal(exec(s, ['list']).status, 0);
  assert.equal(item(s).status, 'stale');
});

test('findings 15 and 16 end and signature are optional in a symbol; an anchor without them follows the code by what the move rule uses', () => {
  const bare = (x) => ({ key: x.key, kind: x.kind, start: x.start, hash: x.hash });
  const s = world({ symbols: [bare(CLASS), bare(CONSUME)] });
  assert.equal(item(s).anchor.signature, undefined);
  assert.equal(item(s).anchor.end, 3, 'no end line: the anchor cites the start line');
  commit(s.acmeApi, { 'src/a.ts': lines('// one', ...A) });
  provide(s, { current: 's2', snapshots: { s2: { symbols: [bare({ ...CLASS, start: 3 }), bare({ ...CONSUME, start: 4 })] } } });
  assert.equal(refresh(s).status, 0);
  assert.deepEqual([item(s).status, item(s).anchor.start, item(s).anchor.snapshot], ['active', 4, 's2']);
});
