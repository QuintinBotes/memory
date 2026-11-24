import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { setup, remember, run, runAsync } from './helpers.mjs';
import { fillStore, wordOf } from './big-store.mjs';

// Gap 4 (#24), user story 2: at 10,000 items a hook stays cheap. Cheap is asserted on the work done (rows read,
// statements run, pairs compared), never on the clock: a wall-time bound in a test flakes on a loaded machine. The
// latency bar itself (p95 150 ms, p99 300 ms, eight writers) is measured by `node scripts/bench-hook.mjs`, on demand.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const N = 10_000;

/** src/consolidate.ts as the bundler sees it, loaded here so a test can call its functions. MEMORY_SRC_ROOT points it at another checkout. */
async function consolidation() {
  const entry = join(process.env.MEMORY_SRC_ROOT ?? root, 'src/consolidate.ts');
  const { outputFiles } = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, external: ['node:*'], logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
}

/** Items shaped like `Visible`, counting each time a pair comparison reads `anchors`: every compared pair does, once per side. */
function countedItems(count, { digits = false } = {}) {
  const counter = { reads: 0 };
  let seed = 7;
  const next = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), (seed >>> 16) % n);
  const items = Array.from({ length: count }, (_, i) => {
    const anchors = [];
    return {
      id: `i-${i}`,
      scope: ['person', 'repository', 'organisation', 'global'][next(10) < 5 ? 1 : next(3) < 2 ? 2 : next(2) === 0 ? 0 : 3],
      type: ['hazard', 'convention'][next(2)],
      statement: `${Array.from({ length: 7 }, () => wordOf(next(count < 1000 ? 30 : 2000))).join(' ')}${digits && next(4) === 0 ? ` ${next(3)}` : ''}`,
      get anchors() {
        counter.reads++;
        return anchors;
      },
    };
  });
  return { items, counter };
}

/** The matcher as it was before the index: every pair, then type, scope, anchors, numbers and word overlap. */
function reference(items) {
  const tokens = (t) => new Set(t.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const numbers = (s) => [...s].filter((w) => /\d/.test(w)).sort().join(' ');
  const jaccard = (a, b) => {
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    const union = a.size + b.size - shared;
    return union === 0 ? 0 : shared / union;
  };
  const order = ['person', 'repository', 'organisation', 'global'];
  const w = items.map((i) => tokens(i.statement));
  return items.filter((a, i) => !items.some((b, j) => i !== j && a.type === b.type && order.indexOf(b.scope) < order.indexOf(a.scope) && numbers(w[i]) === numbers(w[j]) && jaccard(w[i], w[j]) >= 0.5));
}

test('FR-006 narrower-scope-wins gives the answer of comparing every pair, on dense near matches', async () => {
  const { narrowerWins } = await consolidation();
  for (const digits of [false, true]) {
    const { items } = countedItems(600, { digits });
    const kept = narrowerWins(items).map((i) => i.id);
    assert.deepEqual(kept, reference(items).map((i) => i.id));
    assert.ok(kept.length < items.length, 'the fixture does hide some items, or this proves nothing');
    assert.ok(kept.length > items.length / 3, 'and shows many');
  }
});

test('SC-002 recall over 10,000 visible items compares a few pairs per item, not every pair', async () => {
  const { narrowerWins } = await consolidation();
  const { items, counter } = countedItems(N);
  const kept = narrowerWins(items);
  assert.ok(kept.length > 0);
  // Every pair compared reads `anchors` of both sides; comparing all cross-scope pairs of one type is tens of millions of reads.
  assert.ok(counter.reads <= 40 * N, `${counter.reads} anchor reads for ${N} items`);
});

function bigStore() {
  const s = setup();
  const r = remember(s.acmeApi, s.data, s.configA, 'Seed lesson one', '--scope', 'repository', '--type', 'hazard');
  assert.equal(r.status, 0, r.stderr);
  const file = join(s.data, 'tenants/acme.sqlite');
  fillStore(file, 'acme', 'acme/api', 'acme', N);
  return { ...s, file };
}
const startInput = (s) => JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: s.acmeApi });

test('US2.3 session start at 10,000 items reads each item once, runs a handful of statements and leaves the sweep to `memory sweep`', async () => {
  const s = bigStore();
  const log = join(s.base, 'work.json');
  const r = await runAsync(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: startInput(s), env: { WORK_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\+\d{4} more: memory list/, 'a slice over the visible items, with the rest counted');
  const work = JSON.parse(readFileSync(log, 'utf8'));
  assert.ok(work.statements <= 40, `${work.statements} statements`);
  assert.ok(work.rows <= N * 1.1, `${work.rows} rows read for ${N} items`);
  const db = new DatabaseSync(s.file, { readOnly: true });
  const swept = db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'sweep'").get().n;
  db.close();
  assert.equal(swept, 0, 'a store this size is not swept at session start, which would compare every pair');
});

test('US2.3 the session-start slice at 10,000 items is byte-identical with eight writers running', async () => {
  const s = bigStore();
  const quiet = run(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: startInput(s) });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.ok(quiet.stdout.length > 0);

  const messages = (w) => [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...Array.from({ length: 40 }, (_, n) => ({ jsonrpc: '2.0', id: n + 1, method: 'tools/call', params: { name: 'memory_propose', arguments: { statement: `Writer ${w} proposes mk${w}x${n}`, scope: 'repository', type: 'precedent', evidence: { source: `probe:${w}:${n}` } } } })),
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const writers = Array.from({ length: 8 }, (_, w) => runAsync(['mcp'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: messages(w) }));
  const during = [];
  for (let n = 0; n < 3; n++) during.push(await runAsync(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: startInput(s) }));
  for (const w of await Promise.all(writers)) assert.equal(w.status, 0, w.stderr);
  for (const r of during) {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, quiet.stdout);
  }
});
