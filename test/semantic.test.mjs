import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, runAsync, remember, commit, fenced } from './helpers.mjs';

// #28: a local semantic leg over loopback Ollama, off by default, fused with the keyword and graph rankings by RRF
// (k = 60), and an optional local reranker; both reached by memory_search and diff recall and never by a hook.

const STOP = new Set('a an and are as at be by for from has have in into is it its of on or that the this to was were will with when which while not no do does so if then'.split(' '));
/** The stub's embedding: each word counts as its first three letters, so words of one prefix are close and others are not. */
function embed(text) {
  const v = new Array(256).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(w)) continue;
    let h = 0x811c9dc5;
    for (const c of w.slice(0, 3)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
    v[(h >>> 0) % 256] += 1;
  }
  return v;
}

/** A stand-in for Ollama on 127.0.0.1: records each request; `mode` makes it fail. */
async function ollama(mode = 'ok') {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ url: req.url, body: parsed });
      if (mode === '500') return void ((res.statusCode = 500), res.end('{}'));
      if (mode === '404') return void ((res.statusCode = 404), res.end('{"error":"model not found"}'));
      res.setHeader('content-type', 'application/json');
      // The reranker's call: it answers the facts in reverse.
      if (req.url === '/api/generate') {
        const n = parsed.prompt.split('\n').filter((l) => /^\d+\. /.test(l)).length;
        return void res.end(JSON.stringify({ model: parsed.model, response: JSON.stringify({ order: Array.from({ length: n }, (_, i) => n - i) }), done: true }));
      }
      res.end(JSON.stringify({ model: parsed.model, embeddings: parsed.input.map(embed) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

const configPath = (s) => join(s.data, 'config.json');
const setConfig = (s, change) => writeFileSync(configPath(s), JSON.stringify(change(JSON.parse(readFileSync(configPath(s), 'utf8')))));
const legOn = (s, url, extra = {}) => setConfig(s, (c) => ({ ...c, embeddings: { provider: 'ollama', model: 'nomic-embed-text', url, ...extra } }));
const legOff = (s) => setConfig(s, (c) => (delete c.embeddings, c));
/** The tenant's last head-to-head scorecard, as `memory eval head-to-head` writes it. */
function scorecard(s, share, tenant = 'acme') {
  const dir = join(s.data, 'eval', 'head-to-head', tenant);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last.json'), JSON.stringify({ tenant, since: '2026-06-01', version: '0.8.0', vocabulary_misses: 3, memory_misses_found_elsewhere: 10, vocabulary_miss_share: share, misses: [] }));
}

// The labelled vocabulary misses: each question shares no word, and no Porter stem, with its item, only prefixes.
const MISSES = [
  ['Subscription payments belong to billing', 'subscribe pay'],
  ['Timeouts live in the gateway config', 'timer gates configure'],
  ['Passwords are hashed with argon', 'passing hasty argue'],
  ['Queues drain nightly', 'query drama nights'],
  ['Webhooks retry with backoff', 'website retrieval background'],
];
// Questions the keyword ranking answers, and ones nothing answers.
const KEYWORD = [
  ['Releases are tagged by the release manager', 'release tagged'],
  ['Feature flags are removed after launch', 'feature flags removed'],
];
const ABSTAIN = ['kubernetes helm', 'zebra yacht', 'umbrella violin', 'oxygen jungle', 'xylophone ember'];

/** Items stored with the leg off; returns the context, then the leg is turned on over `stub` with a vector for each. */
async function seeded(stub, { items = [...MISSES, ...KEYWORD].map(([t]) => t) } = {}) {
  const s = setup();
  for (const t of items) assert.equal(remember(s.acmeApi, s.data, s.configA, t, '--scope', 'repository', '--type', 'decision').status, 0);
  if (stub !== undefined) {
    legOn(s, stub.url);
    const filled = await runAsync(['embed', '--backfill'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(filled.status, 0, filled.stderr);
    stub.requests.length = 0;
  }
  return s;
}

const searchCall = (query, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_search', arguments: { query } } });
/** Each query through one MCP server, as an agent asks them; returns each answer's text. */
async function search(s, ...queries) {
  const r = await runAsync(['mcp'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: queries.map((q, i) => searchCall(q, i + 1)).join('\n') + '\n' });
  const lines = r.stdout.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  return queries.map((_, i) => lines.find((l) => l.id === i + 1).result.content[0].text);
}
const rowsOf = (text) => (text.includes('~~~') ? fenced(text).filter((l) => l.startsWith('[')) : []);
const SKIPPED = /Semantic leg skipped/;
const recallAt5 = (texts, pairs) => pairs.filter(([item], i) => rowsOf(texts[i]).slice(0, 5).some((l) => l.includes(item))).length / pairs.length;

test('scenario 1: on the labelled vocabulary misses, recall at 5 rises by at least 10 points with the leg on', async () => {
  const stub = await ollama();
  try {
    const s = await seeded(stub);
    const questions = MISSES.map(([, q]) => q);
    legOff(s);
    const off = recallAt5(await search(s, ...questions), MISSES);
    legOn(s, stub.url);
    const on = recallAt5(await search(s, ...questions), MISSES);
    assert.equal(off, 0, 'words alone miss them all');
    assert.ok(on - off >= 0.1, `recall at 5 off ${off}, on ${on}`);
    assert.equal(on, 1);
    assert.deepEqual(stub.requests.map((q) => [q.url, q.body.model, q.body.input]), questions.map((q) => ['/api/embed', 'nomic-embed-text', [q]]));
  } finally {
    await stub.close();
  }
});

test('scenario 2: over every category recall at 5 does not fall with the leg on, and false recall stays under 10%', async () => {
  const stub = await ollama();
  try {
    const s = await seeded(stub);
    const ask = async () => {
      const keyword = await search(s, ...KEYWORD.map(([, q]) => q));
      const misses = await search(s, ...MISSES.map(([, q]) => q));
      const abstain = await search(s, ...ABSTAIN);
      return { keyword: recallAt5(keyword, KEYWORD), misses: recallAt5(misses, MISSES), falseRecall: abstain.filter((t) => rowsOf(t).length > 0).length / ABSTAIN.length };
    };
    legOff(s);
    const off = await ask();
    legOn(s, stub.url);
    const on = await ask();
    assert.ok(on.keyword >= off.keyword && on.misses >= off.misses, JSON.stringify({ off, on }));
    assert.equal(on.keyword, 1);
    assert.ok(on.falseRecall < 0.1, JSON.stringify(on));
  } finally {
    await stub.close();
  }
});

// The failure recipe and point-of-action hazard of the hook tests (#14, #15).
const SIGNATURE = 'ERR_MODULE_NOT_FOUND esbuild';
const RECIPE = `${SIGNATURE} => the build tool is missing: run npm ci in the repository root, then build again`;
const ERROR = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from /work/a/scripts/build.mjs\n";
const HAZARD = 'computeTotal rounds before it sums, so totals drift by a cent';

test('scenario 3: with the leg on, the session slice, point-of-action and failure hooks never call the embedder and print the same bytes', async () => {
  const stub = await ollama();
  try {
    const s = await seeded(undefined, { items: [] });
    const body = Array.from({ length: 60 }, (_, i) => (i === 49 ? 'export function computeTotal() {' : `line ${i + 1}`)).join('\n') + '\n';
    commit(s.acmeApi, { 'src/a.ts': body });
    setConfig(s, (c) => ({ ...c, pointOfAction: true }));
    const ok = (r) => assert.equal(r.status, 0, r.stderr);
    ok(remember(s.acmeApi, s.data, s.configA, HAZARD, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/a.ts:40-60'));
    ok(remember(s.acmeApi, s.data, s.configA, RECIPE, '--scope', 'repository', '--type', 'repair-recipe'));
    ok(remember(s.acmeApi, s.data, s.configA, 'Subscription payments belong to billing', '--scope', 'repository', '--type', 'decision'));
    const hooks = async (session) => {
      const at = { session_id: session, cwd: s.acmeApi };
      const call = (cmd, input) => runAsync([cmd], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ ...at, ...input }) });
      const out = [
        await call('session-start', { hook_event_name: 'SessionStart', source: 'startup' }),
        await call('point-of-action', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(s.acmeApi, 'src/a.ts'), offset: 30, limit: 30 } }),
        await call('failure-recall', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm run build' }, error: ERROR, is_interrupt: false }),
      ];
      for (const r of out) assert.equal(r.status, 0, r.stderr);
      return out.map((r) => r.stdout);
    };
    const off = await hooks('s-off');
    legOn(s, stub.url);
    setConfig(s, (c) => ({ ...c, rerank: { url: stub.url } }));
    const filled = await runAsync(['embed', '--backfill'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(filled.status, 0, filled.stderr);
    stub.requests.length = 0;
    const on = await hooks('s-on');
    assert.match(off[0], /Subscription payments/);
    assert.match(off[1], /computeTotal rounds/);
    assert.match(off[2], /run npm ci/);
    assert.deepEqual(on, off, 'byte-identical');
    assert.deepEqual(stub.requests, [], 'no hook called the embedder');
    // and the leg is live: a search in the same state does call it
    await search(s, 'subscribe pay billing computeTotal');
    assert.deepEqual(stub.requests.map((q) => q.url), ['/api/embed', '/api/generate']);
  } finally {
    await stub.close();
  }
});

test('scenario 4: an absent or failing embedder leaves search to keywords, and it says the semantic leg was skipped', async () => {
  const down = await ollama();
  let s;
  try {
    s = await seeded(down);
  } finally {
    await down.close(); // nothing listens there now
  }
  const [gone] = await search(s, 'release tagged');
  assert.match(gone, /Semantic leg skipped \(Ollama at http:\/\/127\.0\.0\.1:\d+ is unreachable or too slow\); items are ranked by words and paths only\./);
  assert.ok(rowsOf(gone).some((l) => l.includes('Releases are tagged')), 'keyword results are still returned');
  assert.ok(!rowsOf(gone).some((l) => / semantic |rrf /.test(l)), 'no semantic points are faked');
  for (const [mode, said] of [['500', /Ollama answered 500/], ['404', /Ollama answered 404; is nomic-embed-text installed \(ollama pull nomic-embed-text\)\?/]]) {
    const stub = await ollama(mode);
    try {
      legOn(s, stub.url);
      const [text] = await search(s, 'release tagged');
      assert.match(text, said);
      assert.match(text, SKIPPED);
      assert.ok(rowsOf(text).some((l) => l.includes('Releases are tagged')));
      assert.ok(stub.requests.every((q) => q.url === '/api/embed'), 'memory never asks Ollama to pull a model');
    } finally {
      await stub.close();
    }
  }
});

test('scenario 5: a client tenant refuses an embedder that is not on this machine, for search, remember and backfill', async () => {
  const s = await seeded(undefined);
  legOn(s, 'http://192.0.2.10:11434'); // TEST-NET: never contacted, the network guard fails the test if it were
  const [text] = await search(s, 'subscribe pay');
  assert.match(text, /Semantic leg skipped \(acme is a client tenant, and its text goes only to an embedder on this machine \(a 127\.0\.0\.1, localhost or \[::1\] address\); ollama is not\)/);
  assert.ok(rowsOf(text).length === 0 || !rowsOf(text).some((l) => /semantic/.test(l)));
  const r = remember(s.acmeApi, s.data, s.configA, 'Refunds go through the ledger', '--scope', 'repository');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not embedded \(acme is a client tenant/);
  const filled = run(['embed', '--backfill'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(filled.status, 0, filled.stderr);
  assert.match(filled.stderr, /not embedded: acme is a client tenant/);
  assert.match(filled.stdout, /embedded 0 items/);
  // a loopback address by any of its names is this machine
  for (const host of ['localhost', '[::1]']) {
    legOn(s, `http://${host}:9`);
    const [text] = await search(s, 'subscribe pay');
    assert.match(text, SKIPPED);
    assert.doesNotMatch(text, /client tenant/);
  }
});

test('no replay gate: the leg runs whenever an embedder is configured and consented; the scorecard\'s vocabulary-miss share is information only', async () => {
  const stub = await ollama();
  try {
    const s = await seeded(stub);
    for (const share of [undefined, 0.05]) {
      if (share !== undefined) scorecard(s, share);
      const [text] = await search(s, 'subscribe pay');
      assert.doesNotMatch(text, SKIPPED);
      assert.ok(rowsOf(text)[0].includes('Subscription payments'), text);
    }
  } finally {
    await stub.close();
  }
});

test('FR-002: the leg is off by default: nothing is embedded or sent, and search says nothing about it', () => {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Subscription payments belong to billing', '--scope', 'repository', '--type', 'decision').status, 0);
  const text = run(['mcp'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: searchCall('subscribe pay') + '\n' }).stdout;
  assert.doesNotMatch(text, /Semantic|Embeddings|Rerank/);
  const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_vectors').get().n, 0);
  db.close();
  const backfill = run(['embed', '--backfill'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.notEqual(backfill.status, 0);
  assert.match(backfill.stderr, /no embedder is configured/);
});

test('FR-002: diff recall reaches the leg; a hazard named in other words than the changed file is found with it on', async () => {
  const stub = await ollama();
  try {
    const s = await seeded(undefined, { items: [] });
    assert.equal(remember(s.acmeApi, s.data, s.configA, 'Consumers are throttled per account', '--scope', 'repository', '--type', 'hazard').status, 0);
    const base = commit(s.acmeApi, { 'README.md': 'x\n' });
    commit(s.acmeApi, { 'src/consumption.ts': 'export const c = 1;\n' });
    const diff = () => runAsync(['recall', '--diff', 'HEAD~1..HEAD'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    const off = await diff();
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stdout, /Consumers are throttled/);
    legOn(s, stub.url);
    assert.equal((await runAsync(['embed', '--backfill'], { cwd: s.acmeApi, data: s.data, config: s.configA })).status, 0);
    const on = await diff();
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /Consumers are throttled.*semantic [\d.]+.*rrf 0\.0164/);
    assert.equal(stub.requests.at(-1).body.input[0], 'consumption');
    void base;
  } finally {
    await stub.close();
  }
});

test('FR-004: results are fused by RRF with k = 60, and each row keeps its points', async () => {
  const stub = await ollama();
  try {
    const s = await seeded(stub);
    // "subscription billing": first in both rankings, so 2 / 61; then items only one leg finds, at 1 / 62 and below.
    const [text] = await search(s, 'subscription billing');
    const rows = rowsOf(text);
    assert.ok(rows[0].includes('Subscription payments'), text);
    assert.match(rows[0], /why: repository 2, text [\d.]+, semantic [\d.]+, confidence \w+ [\d.]+, rrf 0\.0328/);
    for (const row of rows) assert.match(row, /why: .*confidence \w+ [\d.]+.*, rrf 0\.0\d+/);
  } finally {
    await stub.close();
  }
});

test('the ollama embedder is validated in config: a url carries no credentials and belongs to ollama alone', () => {
  const s = setup();
  for (const embeddings of [{ provider: 'ollama', url: 'http://user:pw@127.0.0.1:11434' }, { provider: 'voyage', url: 'http://127.0.0.1:1' }, { provider: 'ollama', url: 'ftp://127.0.0.1' }, { provider: 'llama' }]) {
    setConfig(s, (c) => ({ ...c, embeddings }));
    const r = run(['mcp'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: searchCall('x') + '\n' });
    assert.match(r.stdout + r.stderr, /embeddings must be/);
  }
});

const rerankOn = (s, rerank) => setConfig(s, (c) => ({ ...c, rerank }));
const QUERY = 'release feature tagged flags';

test('rerank: a local generative model reorders the top rows, inkling-2-mini unless named, and each row says its new place', async () => {
  const stub = await ollama();
  try {
    const s = await seeded(undefined);
    const [plain] = await search(s, QUERY);
    const before = rowsOf(plain);
    assert.ok(before.length >= 2, plain);
    rerankOn(s, { url: stub.url });
    const [text] = await search(s, QUERY);
    assert.doesNotMatch(text, /Rerank skipped/);
    const after = rowsOf(text);
    assert.deepEqual(after.map((l) => l.replace(/, rerank \d+$/, '')), [...before].reverse());
    after.forEach((l, i) => assert.ok(l.endsWith(`, rerank ${i + 1}`), l));
    assert.deepEqual(stub.requests.map((q) => [q.url, q.body.model, q.body.stream]), [['/api/generate', 'inkling-2-mini', false]]);
    assert.match(stub.requests[0].body.prompt, /^Query: release feature tagged flags\n1\. /);
  } finally {
    await stub.close();
  }
});

test('rerank: a failing or absent model keeps the fused order and says the rerank was skipped', async () => {
  const s = await seeded(undefined);
  const [plain] = await search(s, QUERY);
  const down = await ollama();
  await down.close();
  for (const mode of ['500', '404', 'down']) {
    const stub = mode === 'down' ? down : await ollama(mode);
    try {
      rerankOn(s, { url: stub.url, model: 'inkling-2-mini' });
      const [text] = await search(s, QUERY);
      assert.match(text, /Rerank skipped \(.*(Ollama answered|unreachable)/);
      assert.match(text, /; the fused order stands\./);
      assert.deepEqual(rowsOf(text), rowsOf(plain), 'the fused order, unchanged');
    } finally {
      if (mode !== 'down') await stub.close();
    }
  }
});

test('rerank: a client tenant refuses a model that is not on this machine', async () => {
  const s = await seeded(undefined);
  rerankOn(s, { url: 'http://192.0.2.10:11434' }); // never contacted: the network guard fails the test if it were
  const [text] = await search(s, QUERY);
  assert.match(text, /Rerank skipped \(acme is a client tenant, and its text goes only to a model on this machine .*; http:\/\/192\.0\.2\.10:11434 is not\)/);
  assert.ok(rowsOf(text).length >= 2);
});

test('rerank: diff recall reaches it too', async () => {
  const stub = await ollama();
  try {
    const s = await seeded(undefined, { items: [] });
    for (const t of ['Consumption totals are cached', 'Consumption rates come from the meter']) {
      assert.equal(remember(s.acmeApi, s.data, s.configA, t, '--scope', 'repository', '--type', 'hazard').status, 0);
    }
    commit(s.acmeApi, { 'src/consumption.ts': 'export const c = 1;\n' });
    rerankOn(s, { url: stub.url });
    const r = await runAsync(['recall', '--diff', 'HEAD~1..HEAD'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rerank 1/);
    assert.deepEqual(stub.requests.map((q) => q.url), ['/api/generate']);
  } finally {
    await stub.close();
  }
});

test('rerank config is validated: an http(s) url without credentials, and a model name', () => {
  const s = setup();
  for (const rerank of [{ url: 'http://u:p@127.0.0.1:11434' }, { url: 'ftp://127.0.0.1' }, { model: '' }, 'on']) {
    rerankOn(s, rerank);
    const r = run(['mcp'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: searchCall('x') + '\n' });
    assert.match(r.stdout + r.stderr, /rerank must be/);
  }
});
