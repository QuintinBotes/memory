import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setup, run, runAsync, remember, until } from './helpers.mjs';

// Review findings on #24: a read-then-write that is not under the write lock, and the injection log's rewrite, lose or
// repeat work when two processes meet. Each race is made deterministic by a lock holder that releases on cue.
const tenantFile = (s) => join(s.data, 'tenants/acme.sqlite');
const query = (s, sql, ...args) => {
  const db = new DatabaseSync(tenantFile(s), { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};
const key = (text) => createHash('sha256').update(text.toLowerCase()).digest('hex');
const hook = (s, name, input) => runAsync([name], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', cwd: s.acmeApi, ...input }) });
/** A contender's env: it logs a line as it asks for the write lock, which the holder has, so it is about to queue. */
const queueLog = (s) => join(s.base, 'queued.log');
const queueing = (s) => ({ LOCK_WAIT_LOG: queueLog(s) });
const waitQueued = (s, n) => until(() => existsSync(queueLog(s)) && readFileSync(queueLog(s), 'utf8').split('\n').filter(Boolean).length >= n);
const logFile = (s) => join(s.data, 'logs/injections.jsonl');
const logLines = (s) => readFileSync(logFile(s), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));

function seeded() {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'The ledger consume call holds the lock before it writes', '--scope', 'repository', '--type', 'hazard').status, 0);
  s.seedId = query(s, 'SELECT id FROM items')[0].id;
  return s;
}

/** A child that takes the store's write lock, then on "go" runs `sql` (with ${columns} of the seed row) and commits. */
function holder(s, rows) {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(tenantFile(s))});
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    console.log('locked');
    process.stdin.once('data', () => {
      const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name).filter((n) => n !== 'id');
      const seed = db.prepare('SELECT * FROM items WHERE id = ?').get(${JSON.stringify(s.seedId)});
      for (const r of ${JSON.stringify(rows)}) {
        const row = { ...seed, ...r };
        db.prepare('INSERT INTO items (id, ' + cols.join(', ') + ') VALUES (?' + ', ?'.repeat(cols.length) + ')').run(r.id, ...cols.map((c) => row[c]));
      }
      db.exec('COMMIT');
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const locked = new Promise((ok) => child.stdout.once('data', ok));
  const done = new Promise((ok) => child.on('exit', ok));
  return { locked, go: async () => { child.stdin.write('go\n'); await done; } };
}

test('a sweep reads its rows under the write lock, so two sweeps never propose the same pair twice', async () => {
  const s = seeded();
  const rows = [];
  for (let n = 0; n < 20; n++) {
    const statement = `Pair statement number${n} stands alone`;
    for (const [i, suffix] of ['a', 'b'].entries()) rows.push({ id: `m-${n}${suffix}`, statement, statement_key: key(statement), status: 'active', created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
  }
  const h = holder(s, rows);
  await h.locked;
  const sweeps = [runAsync(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA, env: queueing(s) }), runAsync(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA, env: queueing(s) })];
  await waitQueued(s, 2);
  await h.go();
  const done = await Promise.all(sweeps);
  for (const r of done) assert.equal(r.status, 0, r.stderr);
  const total = done.reduce((sum, r) => sum + Number(/proposed (\d+)/.exec(r.stdout)[1]), 0);
  assert.equal(total, 20, done.map((r) => r.stdout).join());
  assert.equal(query(s, "SELECT count(*) AS n FROM audit_events WHERE action = 'merge_proposed'")[0].n, 20);
  assert.equal(query(s, 'SELECT count(*) AS n FROM items WHERE supersedes IS NOT NULL')[0].n, 20);
});

test('a proposal waits its turn at the tombstone check: a statement rejected while it queued is not proposed', async () => {
  const s = seeded();
  const statement = 'Retry the flaky deploy three times';
  const h = holder(s, [{ id: 'm-tomb', statement, statement_key: key(statement), status: 'rejected', status_reason: 'owner said no' }]);
  await h.locked;
  const calls = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_propose', arguments: { statement, scope: 'repository', type: 'precedent', evidence: { source: 'probe:t' } } } },
  ];
  const proposing = runAsync(['mcp'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: calls.map((c) => JSON.stringify(c)).join('\n') + '\n', env: queueing(s) });
  await waitQueued(s, 1);
  await h.go();
  assert.equal((await proposing).status, 0);
  assert.equal(query(s, "SELECT count(*) AS n FROM items WHERE statement_key = ? AND status = 'proposed'", key(statement))[0].n, 0);
});

test('an import rejection is applied to what is proposed when the lock is won, not to what was there when it looked', async () => {
  const s = seeded();
  const statement = 'Every handler logs its request id';
  const record = join(s.acmeApi, 'rejected.jsonl');
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, `${JSON.stringify({ kind: 'standard', text: statement, at: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) })}\n`);
  const cfg = join(s.data, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), imports: { [s.acmeApi]: { rejections: 'rejected.jsonl' } } }));
  const h = holder(s, [{ id: 'm-prop', statement, statement_key: key(statement), status: 'proposed' }]);
  await h.locked;
  const importing = runAsync(['import'], { cwd: s.base, data: s.data, config: s.configA, env: queueing(s) });
  await waitQueued(s, 1);
  await h.go();
  const r = await importing;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(query(s, 'SELECT id, status FROM items WHERE statement_key = ?', key(statement)).map((x) => ({ ...x })), [{ id: 'm-prop', status: 'rejected' }]);
});

test('purge pruning the injection log loses no line a subagent appends meanwhile', async () => {
  const s = seeded();
  mkdirSync(dirname(logFile(s)), { recursive: true });
  const old = JSON.stringify({ event: 'injected', session: 'old', agent: 'old', item: 'm-dead', anchors: ['src/a.ts'], tokens: 10, at: '2026-01-01T00:00:00.000Z' });
  const kept = JSON.stringify({ event: 'injected', session: 'old', agent: 'old', item: s.seedId, anchors: ['src/a.ts'], tokens: 10, at: '2026-01-01T00:00:00.000Z' });
  // A big log, so the rewrite is slow and the appends land inside it.
  writeFileSync(logFile(s), Array.from({ length: 120_000 }, (_, i) => (i % 2 === 0 ? old : kept)).join('\n') + '\n');
  const pruning = runAsync(['purge', '--item', 'm-dead', '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  const appends = [];
  for (let n = 0; n < 12; n++) appends.push(hook(s, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: `agent-${n}`, agent_type: 'general-purpose' }));
  const results = await Promise.all([pruning, ...appends]);
  for (const r of results) assert.equal(r.status, 0, r.stderr);
  const lines = logLines(s);
  assert.deepEqual([...new Set(lines.filter((l) => l.agent !== 'old').map((l) => l.agent))].sort(), Array.from({ length: 12 }, (_, n) => `agent-${n}`).sort());
  assert.equal(lines.filter((l) => l.item === 'm-dead').length, 0, 'the purged item\'s lines are gone');
  assert.equal(lines.filter((l) => l.agent === 'old').length, 60_000, 'the kept lines all stay');
});

test('a subagent hook that cannot read the store prints nothing, exits 0 and counts the skip in the injection log', async () => {
  const s = seeded();
  writeFileSync(tenantFile(s), 'this is not a database');
  const r = await hook(s, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: 'agent-skip', agent_type: 'general-purpose' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const lines = logLines(s);
  assert.equal(lines.length, 1);
  assert.deepEqual({ event: lines[0].event, agent: lines[0].agent, session: lines[0].session, via: lines[0].via }, { event: 'skipped', agent: 'agent-skip', session: 's1', via: 'subagent-start' });
  assert.match(lines[0].at, /^\d{4}-/);
});
