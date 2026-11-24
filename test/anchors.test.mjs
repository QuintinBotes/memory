import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, remember, run, commit, sessionStart } from './helpers.mjs';

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
/** Merges `patch` into the provider's state. */
function provide(s, patch) {
  const was = existsSync(stateFile(s)) ? JSON.parse(readFileSync(stateFile(s), 'utf8')) : { repository: 'acme/api', snapshots: {} };
  writeFileSync(stateFile(s), JSON.stringify({ ...was, ...patch, snapshots: { ...was.snapshots, ...patch.snapshots } }));
}
const exec = (s, args, extra = {}) => run(args, { cwd: s.acmeApi, data: s.data, config: s.configA, ...extra });
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

test('while the provider answers, the hooks leave its anchors to the refresh job; once it fails they are checked by path', () => {
  const s = world();
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
