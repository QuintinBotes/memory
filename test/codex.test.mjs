import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundle, setup, remember, run, runAsync, commit, sessionStart, tokens } from './helpers.mjs';

// #138: the recall hooks read Codex's payloads, shaped as codex-cli 0.172 sent them (recorded, paths replaced).
const logFile = (s) => join(s.data, 'logs/injections.jsonl');
const logged = (s) => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : []);
const idOf = (s, statement) => {
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  try {
    return db.prepare('SELECT id FROM items WHERE statement = ?').get(statement).id;
  } finally {
    db.close();
  }
};

/** What every Codex hook payload carries. */
const common = (s, event, session = '01a21f31-f54c-70f1-a612-3f9d3dded082') => ({
  session_id: session,
  transcript_path: join(s.base, 'rollout-2026-11-27T23-48-18-01a21f31.jsonl'),
  cwd: s.acmeApi,
  hook_event_name: event,
  model: 'gpt-6.2-sol',
  permission_mode: 'bypassPermissions',
});
const codex = (s, command, payload) => runAsync([command, '--agent', 'codex'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify(payload) });

const body = Array.from({ length: 100 }, (_, i) => (i === 49 ? 'export function computeTotal() {' : `line ${i + 1}`)).join('\n') + '\n';
const HAZARD = 'computeTotal rounds before it sums, so totals drift by a cent';
const RECIPE = 'Cannot find module nonexistent-pkg-xyz => the package is not installed: run npm ci, then run the command again';
const PATCH = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-export function computeTotal() {\n+export function computeTotal(): number {\n*** End Patch';
const SHELL_ERROR = "node:internal/modules/cjs/loader:1607\n  throw err;\n  ^\n\nError: Cannot find module 'nonexistent-pkg-xyz'\nRequire stack:\n- /work/repo/[eval]\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1603:15)\n {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: [ '/work/repo/[eval]' ]\n}\n\nNode.js v26.13.1\n";

function seeded() {
  const s = setup();
  commit(s.acmeApi, { 'src/a.ts': body });
  const cfg = join(s.data, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), pointOfAction: true }));
  for (const args of [[HAZARD, '--type', 'hazard', '--anchor', 'src/a.ts:40-60'], [RECIPE, '--type', 'repair-recipe'], ['Releases are cut from main only', '--type', 'decision']]) {
    const r = remember(s.acmeApi, s.data, s.configA, args[0], '--scope', 'repository', ...args.slice(1));
    assert.equal(r.status, 0, r.stderr);
  }
  return s;
}
const preToolUse = (s, session) => ({ ...common(s, 'PreToolUse', session), turn_id: 't1', tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_use_id: 'exec-1' });
const postToolUse = (s, response) => ({ ...common(s, 'PostToolUse'), turn_id: 't1', tool_name: 'Bash', tool_input: { command: "node -e \"require('nonexistent-pkg-xyz')\"" }, tool_response: response, tool_use_id: 'exec-2' });
/** The context in a hook's JSON; asserts nothing else is in it, so no permission decision. */
function context(r, event) {
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return null;
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: event, additionalContext: out.hookSpecificOutput.additionalContext } });
  return out.hookSpecificOutput.additionalContext;
}

test('SC1 memory hooks --agent codex prints a hooks.json fragment of memory commands only, and writes nothing', () => {
  const s = setup();
  const before = readdirSync(s.data, { recursive: true }).sort();
  const r = run(['hooks', '--agent', 'codex'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  const { hooks } = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
  for (const h of commands) {
    assert.equal(h.type, 'command');
    assert.match(h.command, new RegExp(`^node ${JSON.stringify(bundle).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} (session-start|point-of-action|failure-recall) --agent codex$|capture$`));
  }
  assert.deepEqual(readdirSync(s.data, { recursive: true }).sort(), before);
  assert.equal(run(['hooks'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 2);
});

test('SC2 a Codex SessionStart prints the same slice as Claude Code, as plain stdout Codex adds as context', async () => {
  const s = seeded();
  const claude = sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(claude.status, 0, claude.stderr);
  assert.match(claude.stdout, /Releases are cut from main only/);
  const r = await codex(s, 'session-start', { ...common(s, 'SessionStart'), source: 'startup' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, claude.stdout);
});

test('SC3 a Codex apply_patch of anchored code returns the item as context within 120 tokens, with no permission decision', async () => {
  const s = seeded();
  const text = context(await codex(s, 'point-of-action', preToolUse(s)), 'PreToolUse');
  assert.match(text, /computeTotal rounds before it sums/);
  assert.ok(tokens(text) <= 120, `${tokens(text)} tokens`);
  const other = { ...preToolUse(s, 'other'), tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-line 5\n+line five\n*** End Patch' } };
  assert.equal(context(await codex(s, 'point-of-action', other), 'PreToolUse'), null, 'an edit away from the anchored lines adds nothing');
});

test('SC4 a failed Codex shell command carrying a known signature shows the recipe once per fingerprint', async () => {
  const s = seeded();
  const text = context(await codex(s, 'failure-recall', postToolUse(s, SHELL_ERROR)), 'PostToolUse');
  assert.match(text, /run npm ci, then run the command again/);
  assert.ok(tokens(text) <= 120, `${tokens(text)} tokens`);
  assert.equal((await codex(s, 'failure-recall', postToolUse(s, SHELL_ERROR))).stdout, '', 'once per fingerprint');
  const passed = await codex(s, 'failure-recall', postToolUse(s, `Exit code: 0\nWall time: 0 seconds\nOutput:\n${SHELL_ERROR}`));
  assert.equal(passed.stdout, '', 'a command that exited 0 is no failure');
});

test('SC4 a Codex output with no exit code shows the recipe once and never counts a contradiction', async () => {
  const s = seeded();
  const recipe = idOf(s, RECIPE);
  const passing = `Cannot find module nonexistent-pkg-xyz is the message the test expects; 1 passed\n`;
  assert.match(context(await codex(s, 'failure-recall', postToolUse(s, passing)), 'PostToolUse'), /run npm ci/);
  assert.equal((await codex(s, 'failure-recall', postToolUse(s, passing))).stdout, '');
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  try {
    assert.equal(db.prepare('SELECT contradictions FROM items WHERE id = ?').get(recipe).contradictions, 0);
  } finally {
    db.close();
  }
});

test('SC5 Codex injections are logged under the agent codex, and Claude Code and Codex sessions each see an item once', async () => {
  const s = seeded();
  const hazard = idOf(s, HAZARD);
  const claude = await runAsync(['point-of-action'], {
    cwd: s.acmeApi, data: s.data, config: s.configA,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(s.acmeApi, 'src/a.ts'), old_string: 'export function computeTotal() {', new_string: 'x' }, cwd: s.acmeApi }),
  });
  assert.notEqual(context(claude, 'PreToolUse'), null);
  assert.notEqual(context(await codex(s, 'point-of-action', preToolUse(s)), 'PreToolUse'), null, 'shown to Codex in its own session');
  assert.equal((await codex(s, 'point-of-action', preToolUse(s))).stdout, '', 'and only once');
  await codex(s, 'failure-recall', postToolUse(s, SHELL_ERROR));
  const lines = logged(s).filter((l) => l.event === 'injected');
  assert.deepEqual(lines.map((l) => [l.agent, l.via, l.item === hazard]), [['main', 'point-of-action', true], ['codex', 'point-of-action', true], ['codex', 'failure-recall', false]]);
  // A compaction gives Codex its items again, as it does Claude Code's main agent.
  assert.equal((await codex(s, 'session-start', { ...common(s, 'SessionStart'), source: 'compact' })).status, 0);
  assert.notEqual(context(await codex(s, 'point-of-action', preToolUse(s)), 'PreToolUse'), null);
});

test('SC6 a payload in an unknown shape prints nothing, exits 0 and logs one skipped line', async () => {
  const s = seeded();
  for (const [command, args] of [['session-start', ['--agent', 'codex']], ['point-of-action', ['--agent', 'codex']], ['failure-recall', ['--agent', 'nobody']]]) {
    const before = logged(s).length;
    const r = await runAsync([command, ...args], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ event: 'something', cwd: s.acmeApi }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const added = logged(s).slice(before);
    assert.equal(added.length, 1);
    assert.equal(added[0].event, 'skipped');
    assert.equal(added[0].via, command);
  }
});
