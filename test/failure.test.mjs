import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, remember, runAsync, storeBytes, tokens } from './helpers.mjs';
import { fillStore } from './big-store.mjs';

// Slice 12 (#15): a failed Bash command shows the repair memory knows, beside the error, once per agent.
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

const SIGNATURE = 'ERR_MODULE_NOT_FOUND esbuild';
const RECIPE = `${SIGNATURE} => the build tool is missing: run npm ci in the repository root, then build again`;
const ERROR = (at = '/work/a') =>
  `node:internal/modules/esm/resolve:873\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from ${at}/scripts/build.mjs\n    at packageResolve (node:internal/modules/esm/resolve:873:9)\nNode.js v22.13.0\n`;

/** A store with the recipe; `source` is the recipe's evidence. */
function seeded(source = 'remember') {
  const s = setup();
  const r = remember(s.acmeApi, s.data, s.configA, RECIPE, '--scope', 'repository', '--type', 'repair-recipe', '--source', source);
  assert.equal(r.status, 0, r.stderr);
  s.recipe = sql(s, 'SELECT id FROM items WHERE type = ?', 'repair-recipe')[0].id;
  return s;
}

/** The PostToolUseFailure JSON Claude Code sends, run through the hook. */
const fail = (s, error, extra = {}) =>
  runAsync(['failure-recall'], {
    cwd: s.acmeApi, data: s.data, config: s.configA,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm run build' }, error, is_interrupt: false, cwd: s.acmeApi, ...extra }),
  });
function context(r) {
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return null;
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  return out.hookSpecificOutput.additionalContext;
}

test('US1.1 a Bash failure matching a recipe shows it within 120 estimated tokens, with no opt-in, and logs the item id', async () => {
  const s = seeded();
  assert.equal(JSON.parse(readFileSync(join(s.data, 'config.json'), 'utf8')).pointOfAction, undefined, 'no capability is switched on');
  const text = context(await fail(s, ERROR()));
  assert.match(text, /run npm ci in the repository root/);
  assert.match(text, new RegExp(`\\[${s.recipe}\\]`));
  assert.ok(tokens(text) <= 120, `${tokens(text)} tokens`);
  const [line] = logged(s);
  assert.deepEqual({ event: line.event, item: line.item, session: line.session, agent: line.agent, via: line.via }, { event: 'injected', item: s.recipe, session: 's1', agent: 'main', via: 'failure-recall' });
  assert.doesNotMatch(readFileSync(logFile(s), 'utf8'), /esbuild|npm ci/, 'the log holds ids, never text');
});

test('US1.2 the same fingerprint failing again prints nothing, even with other paths and times in the error, and is counted once as a contradiction', async () => {
  const s = seeded();
  assert.notEqual(context(await fail(s, ERROR())), null);
  assert.equal(sql(s, 'SELECT contradictions FROM items WHERE id = ?', s.recipe)[0].contradictions, 0);
  assert.equal((await fail(s, ERROR('/elsewhere/b'))).stdout, '');
  assert.equal(sql(s, 'SELECT contradictions FROM items WHERE id = ?', s.recipe)[0].contradictions, 1);
  assert.equal((await fail(s, ERROR('/elsewhere/c'))).stdout, '');
  assert.equal(sql(s, 'SELECT contradictions FROM items WHERE id = ?', s.recipe)[0].contradictions, 1, 'one contradiction per agent and fingerprint');
});

test('US1.2 another agent, and another session, are shown the recipe once each', async () => {
  const s = seeded();
  assert.notEqual(context(await fail(s, ERROR())), null);
  assert.notEqual(context(await fail(s, ERROR(), { agent_id: 'sub-1', agent_type: 'general-purpose' })), null);
  assert.notEqual(context(await fail(s, ERROR(), { session_id: 's2' })), null);
});

test('US1.3 an error that matches no item prints nothing and stores nothing', async () => {
  const s = seeded();
  const r = await fail(s, 'Error: ENOENT: no such file or directory, open zz-unique-missing.txt\n');
  assert.equal(r.stdout, '');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(logged(s), []);
  assert.equal(sql(s, 'SELECT contradictions FROM items WHERE id = ?', s.recipe)[0].contradictions, 0);
});

test('US1.4 an interrupted command prints nothing', async () => {
  const s = seeded();
  assert.equal((await fail(s, ERROR(), { is_interrupt: true })).stdout, '');
  assert.notEqual(context(await fail(s, ERROR())), null, 'the interrupt did not use up the recipe');
});

test('FR-001 only Bash failures are read', async () => {
  const s = seeded();
  assert.equal((await fail(s, ERROR(), { tool_name: 'Read' })).stdout, '');
});

test('US1.5 a recipe whose source shows the command passing after it is labelled verified; any other is not', async () => {
  const plain = seeded();
  assert.doesNotMatch(context(await fail(plain, ERROR())), /verified/);
  const proven = seeded('bash passed after fix');
  assert.match(context(await fail(proven, ERROR())), /repair-recipe \(verified\): ERR_MODULE_NOT_FOUND esbuild =>/);
});

test('FR-003 an item matches by its signature, the text before the arrow: all its words in one error line; the repair part and other types never match', async () => {
  const s = seeded();
  assert.equal((await fail(s, "Error: Cannot find package 'esbuild'\n")).stdout, '', 'ERR_MODULE_NOT_FOUND is not in the error');
  assert.equal((await fail(s, 'Error [ERR_MODULE_NOT_FOUND]: nothing\nsomething about esbuild failed\n')).stdout, '', 'the words are on different lines');
  assert.equal((await fail(s, 'Error: the build tool is missing: run npm ci in the repository root failed\n')).stdout, '', 'the repair part of the item is not a signature');
  const t = setup();
  remember(t.acmeApi, t.data, t.configA, RECIPE, '--scope', 'repository', '--type', 'hazard');
  assert.equal((await fail(t, ERROR())).stdout, '', 'a hazard is not a recipe');
});

test('tenants stay apart: another tenant\'s recipe is never shown', async () => {
  const s = setup();
  remember(s.betaWeb, s.data, s.configA, RECIPE, '--scope', 'repository', '--type', 'repair-recipe');
  assert.equal((await fail(s, ERROR())).stdout, '');
});

test('without consent nothing is read or printed', async () => {
  const s = seeded();
  writeFileSync(join(s.data, 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(s.data, 'config.json'), 'utf8')), consent: undefined }));
  assert.equal((await fail(s, ERROR())).stdout, '');
});

test('the error text is never stored', async () => {
  const s = seeded();
  const unique = 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package \'esbuild\' zzuniquetail';
  context(await fail(s, `${unique}\n`));
  await fail(s, `${unique}\n`);
  assert.equal(storeBytes(s.data).includes('zzuniquetail'), false);
});

test('a huge error is read within a cap of lines and stays fast', async () => {
  const s = seeded();
  const noise = Array.from({ length: 300_000 }, (_, i) => `progress line ${i}`).join('\n');
  const started = Date.now();
  const text = context(await fail(s, `${noise}\n${ERROR()}`));
  const took = Date.now() - started;
  assert.match(text, /run npm ci/, 'the error at the tail is found');
  assert.ok(took < 2000, `${took} ms`);
});

test('a store of 10,000 items is read by type only, and the hook stays inside its time limit', async () => {
  const s = seeded();
  fillStore(tenantFile(s), 'acme', 'acme/api', 'acme', 10_000);
  const log = join(s.base, 'work.json');
  const started = Date.now();
  const r = await runAsync(['failure-recall'], {
    cwd: s.acmeApi, data: s.data, config: s.configA, env: { WORK_LOG: log },
    input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: {}, error: ERROR(), cwd: s.acmeApi }),
  });
  const took = Date.now() - started;
  assert.notEqual(context(r), null);
  assert.ok(took < 1000, `${took} ms`);
  const work = JSON.parse(readFileSync(log, 'utf8'));
  const recipes = sql(s, "SELECT count(*) AS n FROM items WHERE type IN ('failure-pattern', 'repair-recipe')")[0].n;
  assert.ok(work.rows <= recipes + 20, `${work.rows} rows read, ${recipes} recipes and failure patterns held`);
  assert.ok(Math.max(0, ...work.busyTimeouts) <= 500, 'the busy wait is the hooks\' short one');
});

test('hooks.json registers PostToolUseFailure on Bash with a time limit', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.PostToolUseFailure.length, 1);
  assert.equal(hooks.PostToolUseFailure[0].matcher, 'Bash');
  assert.match(hooks.PostToolUseFailure[0].hooks[0].command, /memory\.mjs" failure-recall$/);
  assert.ok(hooks.PostToolUseFailure[0].hooks[0].timeout <= 2);
});
