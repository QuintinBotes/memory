import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, remember, run, runAsync, commit, tokens } from './helpers.mjs';

// Slice 10 (#14): items anchored to code appear when an agent reads or edits that code, once per agent per session.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tenantFile = (s) => join(s.data, 'tenants/acme.sqlite');
const logFile = (s) => join(s.data, 'logs/injections.jsonl');
const logged = (s) => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : []);
const sql = (s, text, ...args) => {
  const db = new DatabaseSync(tenantFile(s));
  try {
    return db.prepare(text).all(...args);
  } finally {
    db.close();
  }
};

// src/a.ts: line n reads `line n`, except line 50, which declares the function the hazards are about.
const body = Array.from({ length: 100 }, (_, i) => (i === 49 ? 'export function computeTotal() {' : `line ${i + 1}`)).join('\n') + '\n';
const HAZARD = 'computeTotal rounds before it sums, so totals drift by a cent';

function seeded({ on = true } = {}) {
  const s = setup();
  commit(s.acmeApi, { 'src/a.ts': body, 'src/b.ts': 'export const b = 1;\n' });
  if (on) {
    const cfg = join(s.data, 'config.json');
    writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), pointOfAction: true }));
  }
  const r = remember(s.acmeApi, s.data, s.configA, HAZARD, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/a.ts:40-60');
  assert.equal(r.status, 0, r.stderr);
  s.hazard = sql(s, 'SELECT id FROM items WHERE statement = ?', HAZARD)[0].id;
  return s;
}

/** The PreToolUse JSON Claude Code sends, run through the hook. */
const hook = (s, tool, toolInput, extra = {}, env) =>
  runAsync(['point-of-action'], {
    cwd: s.acmeApi, data: s.data, config: s.configA, env,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd: s.acmeApi, ...extra }),
  });
const read = (s, extra, env) => hook(s, 'Read', { file_path: join(s.acmeApi, 'src/a.ts'), offset: 30, limit: 51 }, extra, env);
/** The context the hook added; asserts it exited 0 and returned no permission decision. */
function context(r) {
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return null;
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  return out.hookSpecificOutput.additionalContext;
}

test('US1.1 reading lines 30 to 80 of an anchored range adds the item and returns no permission decision, and logs it', async () => {
  const s = seeded();
  const text = context(await read(s));
  assert.match(text, /computeTotal rounds before it sums/);
  assert.match(text, new RegExp(`\\[${s.hazard}\\]`));
  const [line] = logged(s);
  assert.deepEqual({ event: line.event, item: line.item, session: line.session, agent: line.agent, via: line.via, anchors: line.anchors }, { event: 'injected', item: s.hazard, session: 's1', agent: 'main', via: 'point-of-action', anchors: ['src/a.ts'] });
  assert.ok(line.tokens > 0 && line.tokens <= 120);
  assert.doesNotMatch(readFileSync(logFile(s), 'utf8'), /computeTotal/, 'the log holds ids, never text');
});

test('US1.1 a read of lines that do not overlap the anchored range adds nothing', async () => {
  const s = seeded();
  assert.equal(context(await hook(s, 'Read', { file_path: join(s.acmeApi, 'src/a.ts'), offset: 1, limit: 20 })), null);
  assert.equal(context(await hook(s, 'Read', { file_path: join(s.acmeApi, 'src/a.ts'), offset: 90 })), null);
  assert.equal(context(await hook(s, 'Read', { file_path: join(s.acmeApi, 'src/a.ts') })) !== null, true, 'a Read of the whole file overlaps it');
});

test('US1.2 the same agent reading the file again sees nothing', async () => {
  const s = seeded();
  assert.notEqual(context(await read(s)), null);
  assert.equal((await read(s)).stdout, '');
  assert.equal(logged(s).length, 1);
});

test('US1.3 a subagent in the same session sees the item once', async () => {
  const s = seeded();
  assert.notEqual(context(await read(s)), null);
  const sub = { agent_id: 'agent-1', agent_type: 'general-purpose' };
  assert.match(context(await read(s, sub)), /computeTotal rounds/);
  assert.equal((await read(s, sub)).stdout, '');
  assert.deepEqual(logged(s).map((l) => l.agent), ['main', 'agent-1']);
});

test('US1.4 an Edit whose old_string lies inside the anchored lines shows the item, one outside does not', async () => {
  const s = seeded();
  const file = join(s.acmeApi, 'src/a.ts');
  assert.equal(context(await hook(s, 'Edit', { file_path: file, old_string: 'line 10\nline 11', new_string: 'x' })), null);
  assert.match(context(await hook(s, 'Edit', { file_path: file, old_string: 'line 45', new_string: 'x' })), /computeTotal rounds/);
});

test('US1.4 MultiEdit, Write and NotebookEdit are matched too', async () => {
  const s = seeded();
  const file = join(s.acmeApi, 'src/a.ts');
  const multi = await hook(s, 'MultiEdit', { file_path: file, edits: [{ old_string: 'line 3', new_string: 'x' }, { old_string: 'line 55', new_string: 'y' }] }, { session_id: 'm' });
  assert.notEqual(context(multi), null);
  assert.notEqual(context(await hook(s, 'Write', { file_path: file, content: 'x' }, { session_id: 'w' })), null);
  assert.notEqual(context(await hook(s, 'NotebookEdit', { notebook_path: file, new_source: 'x' }, { session_id: 'n' })), null);
});

test('US1.5 a file with no anchored items prints 0 bytes, for every tool and for a path outside the repository', async () => {
  const s = seeded();
  for (const [tool, input] of [
    ['Read', { file_path: join(s.acmeApi, 'src/b.ts') }],
    ['Edit', { file_path: join(s.acmeApi, 'src/b.ts'), old_string: 'b', new_string: 'c' }],
    ['Write', { file_path: join(s.acmeApi, 'src/new.ts'), content: 'x' }],
    ['Read', { file_path: join(s.base, 'elsewhere.txt') }],
    ['Bash', { command: 'cat src/a.ts' }],
  ]) {
    const r = await hook(s, tool, input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', `${tool} printed bytes`);
  }
  assert.equal(logged(s).length, 0);
});

test('US1.6 a file that changed since anchoring matches the whole file for a Read, and an Edit matches symbols named in old_string', async () => {
  const s = seeded();
  const file = join(s.acmeApi, 'src/a.ts');
  writeFileSync(file, `inserted at the top\n${body}`);
  sql(s, "UPDATE items SET anchors_json = json_set(anchors_json, '$[0].symbol', 'src/a.ts#computeTotal#function') WHERE id = ?", s.hazard);
  assert.match(context(await hook(s, 'Read', { file_path: file, offset: 1, limit: 5 })), /computeTotal rounds/);
  assert.match(context(await hook(s, 'Edit', { file_path: file, old_string: 'export function computeTotal() {', new_string: 'x' }, { session_id: 'e1' })), /computeTotal rounds/);
  assert.equal(context(await hook(s, 'Edit', { file_path: file, old_string: 'line 3', new_string: 'x' }, { session_id: 'e2' })), null);
});

test('US1.7 Review Voice agents, Explore and Plan get nothing', async () => {
  const s = seeded();
  for (const agent_type of ['Explore', 'Plan', 'review-voice:diff-analyst', 'diff-analyst', 'not-allowed-type']) {
    const r = await read(s, { agent_id: 'a', agent_type });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', agent_type);
  }
  assert.equal(logged(s).length, 0);
});

test('US1.8 PreCompact prints at most 1,000 characters of shown ids and statements, and a compact session start resets the main ledger only', async () => {
  const s = seeded();
  for (let n = 0; n < 12; n++) {
    remember(s.acmeApi, s.data, s.configA, `Hazard number ${n} about the totals code ${'pad '.repeat(40)}`, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/a.ts:40-60');
  }
  const sub = { agent_id: 'agent-1', agent_type: 'general-purpose' };
  for (let n = 0; n < 6; n++) await read(s);
  await read(s, sub);
  const compact = await runAsync(['pre-compact'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', hook_event_name: 'PreCompact', trigger: 'auto', cwd: s.acmeApi }) });
  assert.equal(compact.status, 0, compact.stderr);
  assert.ok(compact.stdout.length > 0 && compact.stdout.length <= 1000, `${compact.stdout.length} characters`);
  const shown = logged(s).map((l) => l.item);
  assert.ok(shown.some((id) => compact.stdout.includes(`[${id}] `)), 'it lists shown items by id and statement');
  assert.match(compact.stdout, /^~~~text /);

  const start = await runAsync(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'compact', cwd: s.acmeApi }) });
  assert.equal(start.status, 0, start.stderr);
  assert.deepEqual(sql(s, "SELECT count(*) AS n FROM ledger WHERE agent = 'main'")[0].n, 0, 'the main ledger is reset');
  assert.ok(sql(s, "SELECT count(*) AS n FROM ledger WHERE agent = 'agent-1'")[0].n > 0, 'a subagent keeps its own');
  assert.notEqual(context(await read(s)), null, 'the main agent may be shown its items again');
});

test('FR-003 one injection takes at most 120 tokens, and an agent gets at most 600 over a session', async () => {
  const s = seeded();
  for (let n = 0; n < 60; n++) {
    remember(s.acmeApi, s.data, s.configA, `Hazard ${n} in the totals code, ${'detail '.repeat(10)}number ${n}`, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/a.ts:40-60');
  }
  const injected = [];
  for (let n = 0; n < 40; n++) {
    const text = context(await read(s));
    if (text === null) break;
    assert.ok(tokens(text) <= 120, `injection ${n} took ${tokens(text)} tokens`);
    injected.push(tokens(text));
  }
  assert.ok(injected.length >= 5, 'the budget allows several injections');
  const total = logged(s).reduce((sum, l) => sum + l.tokens, 0);
  assert.equal(total, injected.reduce((a, b) => a + b, 0), 'the log adds up to what was printed');
  assert.ok(total <= 600, `${total} tokens`);
  assert.ok(sql(s, "SELECT count(*) AS n FROM items WHERE status = 'active'")[0].n > logged(s).length, 'items were left unshown');
  assert.equal((await read(s)).stdout, '', 'the session budget is spent');
});

test('a directory anchor matches a new file written under it', async () => {
  const s = seeded();
  sql(s, "UPDATE items SET anchors_json = '[{\"path\":\"src/api\"}]' WHERE id = ?", s.hazard);
  assert.match(context(await hook(s, 'Write', { file_path: join(s.acmeApi, 'src/api/new.ts'), content: 'x' })), /computeTotal rounds/);
  assert.equal(context(await hook(s, 'Write', { file_path: join(s.acmeApi, 'src/apix/new.ts'), content: 'x' }, { session_id: 'o' })), null);
});

test('FR-007 with the capability off, the default, the hook prints nothing and records nothing', async () => {
  const s = seeded({ on: false });
  const r = await read(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(logged(s).length, 0);
});

test('FR-005 with the capability on, anchored items leave the session-start slice and are counted there', () => {
  for (const on of [true, false]) {
    const s = seeded({ on });
    remember(s.acmeApi, s.data, s.configA, 'Releases are cut from the main branch only', '--scope', 'repository', '--type', 'convention');
    const r = run(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: s.acmeApi }) });
    assert.match(r.stdout, /Releases are cut/);
    if (on) {
      assert.doesNotMatch(r.stdout, /computeTotal rounds/);
      assert.match(r.stdout, /\+1 anchored to code/);
    } else {
      assert.match(r.stdout, /computeTotal rounds/);
    }
  }
});

test('with the write lock held the hook exits 0, prints nothing and counts the skip; once the lock is free the item is still shown', async () => {
  const s = seeded();
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(tenantFile(s))});
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    console.log('locked');
    process.stdin.on('end', () => { db.exec('ROLLBACK'); process.exit(0); });
    process.stdin.resume();
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((ok) => holder.stdout.once('data', ok));
  const work = join(s.base, 'work.json');
  const r = await read(s, undefined, { WORK_LOG: work });
  const closed = new Promise((ok) => holder.on('exit', ok));
  holder.stdin.end();
  await closed;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  // Not how long it took (that depends on the machine's load): the lock wait it asked SQLite for is the hook's short one.
  const { busyTimeouts } = JSON.parse(readFileSync(work, 'utf8'));
  assert.ok(busyTimeouts.length > 0 && Math.max(...busyTimeouts) <= 500, `a hook waits at most 500 ms for a lock, not ${busyTimeouts}`);
  const lines = logged(s);
  assert.deepEqual(lines.map((l) => [l.event, l.via, l.agent, l.session]), [['skipped', 'point-of-action', 'main', 's1']]);
  assert.notEqual(context(await read(s)), null);
});

test('a store that cannot be read prints nothing, exits 0 and counts the skip', async () => {
  const s = seeded();
  writeFileSync(tenantFile(s), 'this is not a database');
  const r = await read(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.deepEqual(logged(s).map((l) => l.event), ['skipped']);
});

test('hooks.json registers PreToolUse on the five file tools and PreCompact, each with a time limit', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, 'Read|Edit|Write|MultiEdit|NotebookEdit');
  assert.match(hooks.PreToolUse[0].hooks[0].command, /memory\.mjs" point-of-action$/);
  assert.ok(hooks.PreToolUse[0].hooks[0].timeout <= 2);
  assert.equal(hooks.PreCompact.length, 1);
  assert.match(hooks.PreCompact[0].hooks[0].command, /memory\.mjs" pre-compact$/);
  assert.ok(hooks.PreCompact[0].hooks[0].timeout <= 2);
});

// The hook finds items through the anchor-path index (#14, SC-003), so its work does not grow with the store.
const write = (s, file, session) => hook(s, 'Write', { file_path: join(s.acmeApi, file), content: 'x' }, { session_id: session });

test('SC-003 the hook loads only the rows anchored at the touched path: unrelated rows are never read, and an unanchored path loads none', async () => {
  const s = seeded();
  const db = new DatabaseSync(tenantFile(s));
  // A row the hook loaded would fail to parse and make it skip; the triggers are dropped so the index does not see the damage.
  db.exec('DROP TRIGGER item_anchors_insert; DROP TRIGGER item_anchors_update;');
  for (let n = 0; n < 50; n++) {
    db.prepare(`INSERT INTO items (id, tenant, scope, scope_key, type, statement, statement_key, status, authority, origin_trust, anchors_json, valid_from, created_at)
      VALUES (?, 'acme', 'repository', 'acme/api', 'hazard', ?, ?, 'active', 'advisory', 'owner', '{not json', 'x', 'x')`).run(`bad-${n}`, `Unrelated ${n}`, `k${n}`);
  }
  db.close();
  assert.match(context(await write(s, 'src/a.ts', 'one')), /computeTotal rounds/, 'the matching item is still found');
  assert.equal(context(await write(s, 'src/b.ts', 'two')), null);
  assert.equal(logged(s).filter((l) => l.event === 'skipped').length, 0, 'no unrelated row was parsed');
});

test('SC-003 a store written before the anchor index is migrated and its existing anchors backfilled', async () => {
  const s = seeded();
  const db = new DatabaseSync(tenantFile(s));
  db.exec('DROP TRIGGER item_anchors_insert; DROP TRIGGER item_anchors_update; DROP TABLE item_anchors; PRAGMA user_version = 8;');
  db.close();
  assert.match(context(await write(s, 'src/a.ts', 'one')), /computeTotal rounds/);
  assert.deepEqual(sql(s, 'SELECT item_id, path FROM item_anchors').map((r) => ({ ...r })), [{ item_id: s.hazard, path: 'src/a.ts' }]);
  assert.equal(sql(s, 'PRAGMA user_version')[0].user_version, 12);
  sql(s, "UPDATE items SET anchors_json = '[{\"path\":\"src/b.ts\"}]' WHERE id = ?", s.hazard);
  assert.deepEqual(sql(s, 'SELECT path FROM item_anchors').map((r) => ({ ...r })), [{ path: 'src/b.ts' }], 'a later write keeps the index in step');
});

test('SC-003 the index finds the same items as comparing every anchor with the touched path', async () => {
  const s = seeded();
  const anchors = { h1: ['src/a.ts'], h2: ['src/api', 'docs/x.md'], h3: ['src/api/deep/f.ts'], h4: ['src'] };
  const ids = {};
  for (const [name, paths] of Object.entries(anchors)) {
    assert.equal(remember(s.acmeApi, s.data, s.configA, `Hazard ${name} of the totals code`, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/a.ts:40-60').status, 0);
    ids[name] = sql(s, 'SELECT id FROM items WHERE statement = ?', `Hazard ${name} of the totals code`)[0].id;
    sql(s, 'UPDATE items SET anchors_json = ? WHERE id = ?', JSON.stringify(paths.map((path) => ({ path }))), ids[name]);
  }
  sql(s, "UPDATE items SET anchors_json = '[]' WHERE id = ?", s.hazard);
  const hits = (file) => sql(s, "SELECT id, anchors_json FROM items WHERE status = 'active'").filter((r) => JSON.parse(r.anchors_json).some((a) => a.path === file || file.startsWith(`${a.path}/`))).map((r) => r.id).sort();
  let n = 0;
  for (const file of ['src/a.ts', 'src/api/deep/f.ts', 'src/apix/q.ts', 'docs/x.md', 'other/z.ts']) {
    const before = logged(s).length;
    context(await write(s, file, `s${n++}`));
    assert.deepEqual(logged(s).slice(before).map((l) => l.item).sort(), hits(file), file);
  }
});
