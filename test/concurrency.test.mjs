import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, runAsync, remember, sessionStart } from './helpers.mjs';

// Gap 4 (#24), user stories 1 and 2: parallel agents never lose a write, and a hook never fails because the store is busy.
// The issue's run is eight writers of 500 proposals, 500 feedback signals and 500 ledger rows; this suite runs the same
// shape smaller (PER_WRITER of each from four MCP writers, plus remember, capture, sweep and ledger writers) so it stays
// inside a normal test run. Raise MEMORY_TEST_PER_WRITER for the full run.
const PER_WRITER = Number(process.env.MEMORY_TEST_PER_WRITER ?? 150);
const MCP_WRITERS = 4;
const SEED = 'The ledger consume call holds the lock before it writes';
const BUSY = /SQLITE_BUSY|database is locked|database table is locked/i;

const tenantFile = (s) => join(s.data, 'tenants/acme.sqlite');
const query = (s, sql, ...args) => {
  const db = new DatabaseSync(tenantFile(s), { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};
const count = (s, sql, ...args) => Object.values(query(s, sql, ...args)[0])[0];

function seeded() {
  const s = setup();
  const r = remember(s.acmeApi, s.data, s.configA, SEED, '--scope', 'repository', '--type', 'hazard');
  assert.equal(r.status, 0, r.stderr);
  s.seedId = query(s, 'SELECT id FROM items')[0].id;
  // Capture's filter is a deterministic fake: it keeps each line that starts with LESSON.
  const config = join(s.data, 'config.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), capture: { model: 'fake' } }));
  return s;
}

/** One MCP server process given every call at once, like an agent's session; resolves with each call's text and error flag. */
async function mcp(s, calls) {
  const messages = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...calls.map(([name, args], i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } })),
  ];
  const r = await runAsync(['mcp'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n' });
  assert.equal(r.status, 0, r.stderr);
  const byId = new Map(r.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  return calls.map((_, i) => {
    const res = byId.get(i + 1);
    assert.ok(res !== undefined, `no response to call ${i + 1}: ${r.stderr}`);
    return { text: res.error ? res.error.message : res.result.content.map((c) => c.text).join(''), isError: Boolean(res.error) || res.result.isError === true };
  });
}

const propose = (statement, source) => ['memory_propose', { statement, scope: 'repository', type: 'precedent', evidence: { source } }];
const feedback = (id, signal) => ['memory_feedback', { id, signal }];

/** Nothing any process printed may carry a lock error, and every process must have exited 0. */
function assertQuiet(results, what) {
  for (const r of results) {
    assert.equal(r.status ?? 0, 0, `${what}: ${r.stderr ?? ''}`);
    assert.doesNotMatch(`${r.stderr ?? ''}${r.stdout ?? ''}`, BUSY, what);
  }
}

/** A child process that takes the tenant file's write lock and keeps it until told to stop or killed. */
function holdWriteLock(file, { insert = false } = {}) {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    ${insert ? "db.prepare(\"INSERT INTO audit_events (audit_id, action, metadata_json, created_at) VALUES ('held-1', 'sweep', '{}', 'x')\").run();" : ''}
    console.log('locked');
    process.stdin.on('end', () => { db.exec('ROLLBACK'); process.exit(0); });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const locked = new Promise((ok, fail) => {
    child.stdout.on('data', (d) => String(d).includes('locked') && ok());
    child.on('exit', () => fail(new Error('the lock holder exited before it held the lock')));
  });
  const closed = new Promise((ok) => child.on('exit', ok));
  return { locked, release: () => child.stdin.end(), kill: () => child.kill('SIGKILL'), closed };
}

test('US1.1 eight concurrent writers lose no proposal, feedback signal or ledger row, and none fails with a lock error', async () => {
  const s = seeded();
  const writers = [];
  for (let w = 0; w < MCP_WRITERS; w++) {
    const calls = [];
    for (let n = 0; n < PER_WRITER; n++) {
      calls.push(propose(`Concurrency probe mk${w}x${n} holds`, `probe:w${w}:${n}`));
      calls.push(feedback(s.seedId, n % 2 === 0 ? 'helped' : 'wrong'));
    }
    writers.push(mcp(s, calls));
  }
  const remembered = (async () => {
    const out = [];
    for (let n = 0; n < 12; n++) out.push(await runAsync(['remember', '--scope', 'repository', '--type', 'convention', '--', `Remembered rule mk${n}r${n} applies`], { cwd: s.acmeApi, data: s.data, config: s.configA }));
    return out;
  })();
  const swept = (async () => {
    const out = [];
    for (let n = 0; n < 12; n++) out.push(await runAsync(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA }));
    return out;
  })();
  const ledger = (async () => {
    const out = [];
    for (let n = 0; n < 12; n++) {
      out.push(await runAsync(['subagent-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SubagentStart', agent_id: `agent-${n}`, agent_type: 'general-purpose', cwd: s.acmeApi }) }));
    }
    return out;
  })();
  const capture = (async () => {
    const out = [];
    for (let n = 0; n < 6; n++) {
      const file = join(s.base, `t${n}.jsonl`);
      const msg = (type, text) => JSON.stringify({ type, message: { content: [{ type: 'text', text }] } });
      writeFileSync(file, [...Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `ok, step ${i}; running the tests again, nothing to keep here yet`)), msg('assistant', `LESSON: Captured lesson mk${n}c${n} stands`), msg('user', 'thanks')].join('\n') + '\n');
      out.push(await runAsync(['capture', '--foreground'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: `cap-${n}`, hook_event_name: 'SessionEnd', transcript_path: file, cwd: s.acmeApi }) }));
    }
    return out;
  })();

  const [mcpDone, rem, sweeps, ledgerRuns, caps] = await Promise.all([Promise.all(writers), remembered, swept, ledger, capture]);

  for (const calls of mcpDone) for (const c of calls) {
    assert.equal(c.isError, false, c.text);
    assert.doesNotMatch(c.text, BUSY);
  }
  assertQuiet([...rem, ...sweeps, ...ledgerRuns, ...caps], 'a writer');
  for (const r of caps) assert.match(r.stderr, /captured 1 /, r.stderr);
  for (const r of rem) assert.match(r.stdout, /remembered m-/, r.stderr);

  // Every proposal exactly once.
  const proposals = query(s, "SELECT statement FROM items WHERE status = 'proposed'").map((r) => r.statement);
  assert.equal(proposals.length, MCP_WRITERS * PER_WRITER);
  assert.equal(new Set(proposals).size, proposals.length);
  const seen = query(s, "SELECT source_ref FROM evidence WHERE source_ref LIKE 'probe:%'").map((r) => r.source_ref);
  assert.equal(new Set(seen).size, MCP_WRITERS * PER_WRITER, 'each proposal carries its own evidence, once');
  // Every feedback signal exactly once: the counter and the audit trail agree.
  const half = (MCP_WRITERS * PER_WRITER) / 2;
  const [seed] = query(s, 'SELECT helped, wrong FROM items WHERE id = ?', s.seedId);
  assert.deepEqual({ ...seed }, { helped: half, wrong: half });
  assert.equal(count(s, "SELECT count(*) FROM audit_events WHERE action = 'feedback'"), MCP_WRITERS * PER_WRITER);
  // The other writers' work all landed.
  assert.equal(count(s, "SELECT count(*) FROM items WHERE statement LIKE 'Remembered rule %'"), 12);
  assert.equal(count(s, "SELECT count(*) FROM items WHERE statement LIKE 'Captured lesson %'"), 6);
  // Every ledger call logged its rows whole: each line is one JSON object, and every agent appears.
  const lines = readFileSync(join(s.data, 'logs/injections.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  assert.deepEqual([...new Set(lines.map((l) => l.agent))].sort(), Array.from({ length: 12 }, (_, n) => `agent-${n}`).sort());
  assert.equal(query(s, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
  // No row landed under another tenant or scope.
  assert.equal(count(s, "SELECT count(*) FROM items WHERE tenant != 'acme' OR scope != 'repository' OR scope_key != 'acme/api'"), 0);
});

test('US1.2 two writers giving helped to one item at the same moment raise its count by exactly two', async () => {
  const s = seeded();
  for (let round = 0; round < 10; round++) {
    const before = count(s, 'SELECT helped FROM items WHERE id = ?', s.seedId);
    const both = await Promise.all([mcp(s, [feedback(s.seedId, 'helped')]), mcp(s, [feedback(s.seedId, 'helped')])]);
    for (const [c] of both) assert.equal(c.isError, false, c.text);
    assert.equal(count(s, 'SELECT helped FROM items WHERE id = ?', s.seedId), before + 2);
  }
});

test('US1.3 one statement proposed by two sessions at the same moment is one proposal with both pieces of evidence', async () => {
  const s = seeded();
  for (let round = 0; round < 10; round++) {
    const statement = `Both sessions saw mk${round}d${round} fail`;
    const both = await Promise.all([mcp(s, [propose(statement, `probe:a:${round}`)]), mcp(s, [propose(statement, `probe:b:${round}`)])]);
    for (const [c] of both) assert.equal(c.isError, false, c.text);
    const rows = query(s, 'SELECT id FROM items WHERE statement = ?', statement);
    assert.equal(rows.length, 1, `round ${round}: ${rows.length} proposals`);
    assert.deepEqual(query(s, 'SELECT source_ref FROM evidence WHERE item_id = ? ORDER BY source_ref', rows[0].id).map((r) => r.source_ref), [`probe:a:${round}`, `probe:b:${round}`]);
  }
});

test('US1.4 a writer killed in the middle of a transaction loses nobody else\'s write and leaves an intact store', async () => {
  const s = seeded();
  const held = holdWriteLock(tenantFile(s), { insert: true });
  await held.locked;
  // The others queue behind the dead-to-be writer's lock; kill it with its transaction open.
  const others = Promise.all([mcp(s, [propose('Written while a writer dies mk1k1 stays', 'probe:k1')]), mcp(s, [feedback(s.seedId, 'helped')])]);
  held.kill();
  await held.closed;
  for (const [c] of await others) assert.equal(c.isError, false, c.text);
  assert.equal(count(s, "SELECT count(*) FROM items WHERE statement = 'Written while a writer dies mk1k1 stays'"), 1);
  assert.equal(count(s, 'SELECT helped FROM items WHERE id = ?', s.seedId), 1);
  assert.equal(count(s, "SELECT count(*) FROM audit_events WHERE audit_id = 'held-1'"), 0, 'the dead writer\'s half transaction left no trace');
  assert.equal(query(s, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
});

test('US2.1 with the write lock held, the session-start hook exits 0 within its busy limit and still prints the same slice (readers are not blocked)', async () => {
  const s = seeded();
  const free = sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(free.status, 0, free.stderr);
  assert.match(free.stdout, /ledger consume call/);
  // The store was swept once above, so the hook's own sweep is not due; age that record so it is, and the hook must write.
  const db = new DatabaseSync(tenantFile(s));
  db.exec("UPDATE audit_events SET created_at = '2020-01-01T00:00:00.000Z' WHERE action = 'sweep'");
  db.close();

  const held = holdWriteLock(tenantFile(s));
  await held.locked;
  const log = join(s.base, 'work.json');
  const r = await runAsync(['session-start'], {
    cwd: s.acmeApi, data: s.data, config: s.configA, env: { WORK_LOG: log },
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: s.acmeApi }),
  });
  held.release();
  await held.closed;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, free.stdout, 'a held write lock does not change what the reader sees');
  assert.doesNotMatch(r.stderr, BUSY);
  const { busyTimeouts } = JSON.parse(readFileSync(log, 'utf8'));
  assert.ok(busyTimeouts.length > 0 && Math.max(...busyTimeouts) <= 500, `a hook waits at most 500 ms for a lock, not ${busyTimeouts}`);
});

test('US2.1 with the write lock held, the subagent-start hook exits 0 and prints the slice, and its ledger rows land', async () => {
  const s = seeded();
  const input = JSON.stringify({ session_id: 's1', hook_event_name: 'SubagentStart', agent_id: 'agent-held', agent_type: 'general-purpose', cwd: s.acmeApi });
  const held = holdWriteLock(tenantFile(s));
  await held.locked;
  const r = await runAsync(['subagent-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input });
  held.release();
  await held.closed;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ledger consume call/);
  assert.match(readFileSync(join(s.data, 'logs/injections.jsonl'), 'utf8'), /agent-held/);
});

test('a hook on a store whose file cannot be read prints nothing and exits 0', () => {
  const s = seeded();
  mkdirSync(join(s.data, 'tenants'), { recursive: true });
  writeFileSync(tenantFile(s), 'this is not a database');
  const r = run(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: s.acmeApi }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
