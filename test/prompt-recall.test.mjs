import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, remember, run, runAsync, commit, tokens, storeBytes, fenced } from './helpers.mjs';
import { fillStore } from './big-store.mjs';

// #136: items that match what the owner just asked, within a budget, at UserPromptSubmit.
const DECISION = 'Releases are cut by tagging vX.Y.Z on main; the publish workflow builds and uploads the rest';
const PROMPT = 'How do we cut a release here?';
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
function configure(s, patch) {
  const path = join(s.data, 'config.json');
  const next = { ...JSON.parse(readFileSync(path, 'utf8')), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  writeFileSync(path, JSON.stringify(next));
}
const ok = (r) => assert.equal(r.status, 0, r.stderr);
const idOf = (s, statement) => sql(s, 'SELECT id FROM items WHERE statement = ?', statement)[0].id;

/** acme/api with the decision; the switch on and a slice too small to hold it unless told otherwise. */
function seeded({ on = true, sessionBudget = 0 } = {}) {
  const s = setup();
  ok(remember(s.acmeApi, s.data, s.configA, DECISION, '--scope', 'repository', '--type', 'decision'));
  configure(s, { ...(on ? { promptRecall: true } : {}), sessionBudget });
  s.decision = idOf(s, DECISION);
  return s;
}

const prompt = (s, text = PROMPT, extra = {}, env) =>
  runAsync(['prompt-recall'], {
    cwd: s.acmeApi, data: s.data, config: s.configA, env,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: text, cwd: s.acmeApi, ...extra }),
  });
function context(r) {
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return null;
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  return out.hookSpecificOutput.additionalContext;
}

test('SC1 a prompt sharing a decision\'s key words gets it as fenced context, within 120 estimated tokens', async () => {
  const s = seeded();
  const text = context(await prompt(s));
  assert.ok(text !== null, 'the decision was shown');
  const [row] = fenced(text);
  assert.equal(row, `- [${s.decision}] decision: ${DECISION}`);
  assert.ok(tokens(text) <= 120, `${tokens(text)} tokens`);
});

test('SC1 rows are ranked as memory_search ranks them, whole, and stop at 120 tokens', async () => {
  const s = seeded();
  for (let i = 0; i < 6; i++) ok(remember(s.acmeApi, s.data, s.configA, `Release note ${i}: a release is cut only after the changelog names every change in it`, '--scope', 'repository', '--type', 'convention'));
  const text = context(await prompt(s, 'How do we cut a release and write its changelog?'));
  assert.ok(tokens(text) <= 120, `${tokens(text)} tokens`);
  const shown = fenced(text);
  assert.ok(shown.length >= 1 && shown.length < 7, `${shown.length} rows`);
  for (const line of shown) assert.match(line, /^- \[m-[0-9a-f]+\] /);
});

test('SC2 a prompt that shares no item\'s words, a short prompt and a slash command print nothing at all', async () => {
  const s = seeded();
  for (const text of ['Please rename the logger module to log', 'cut release', '/review cut a release today', '   ']) {
    const r = await prompt(s, text);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', text);
  }
  // One shared word does not clear the bar.
  assert.equal((await prompt(s, 'Where is the workflow file kept?')).stdout, '');
  assert.deepEqual(logged(s), []);
});

test('SC2 at 10,000 items a prompt that shares no word runs a few statements, reads no item, and prints zero bytes', async () => {
  const s = seeded();
  fillStore(tenantFile(s), 'acme', 'acme/api', 'acme', 10_000);
  const log = join(s.base, 'work.json');
  const r = await prompt(s, 'Please rename the logger module to log', {}, { WORK_LOG: log });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const work = JSON.parse(readFileSync(log, 'utf8'));
  assert.ok(work.statements <= 25, `${work.statements} statements`);
  assert.ok(work.rows <= 10, `${work.rows} rows read`);
  // And the same store still answers a prompt that shares the decision's words.
  assert.match(context(await prompt(s)) ?? '', new RegExp(s.decision));
});

test('SC3 an item in the session slice is not shown again at the prompt', async () => {
  const s = seeded({ sessionBudget: 300 });
  assert.match(run(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', source: 'startup', cwd: s.acmeApi }) }).stdout, new RegExp(s.decision));
  assert.equal((await prompt(s)).stdout, '');
});

test('SC3 an item shown to this agent in this session is not shown again; another session gets it', async () => {
  const s = seeded();
  assert.notEqual(context(await prompt(s)), null);
  assert.equal((await prompt(s, 'And when we cut the release, who tags it?')).stdout, '');
  assert.notEqual(context(await prompt(s, PROMPT, { session_id: 's2' })), null);
  // A compaction lets the main agent be shown it again, as at the point of action.
  run(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', source: 'compact', cwd: s.acmeApi }) });
  assert.notEqual(context(await prompt(s)), null);
});

test('SC4 with promptRecall absent or false the hook prints nothing, and every other moment prints the same bytes', async () => {
  const s = setup();
  commit(s.acmeApi, { 'src/a.ts': 'export const a = 1;\n' });
  ok(remember(s.acmeApi, s.data, s.configA, DECISION, '--scope', 'repository', '--type', 'decision'));
  ok(remember(s.acmeApi, s.data, s.configA, 'The a constant must stay one', '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/a.ts:1-1'));
  ok(remember(s.acmeApi, s.data, s.configA, 'ERR_MODULE_NOT_FOUND esbuild => run npm ci first', '--scope', 'repository', '--type', 'repair-recipe'));
  const moments = (session) => {
    const h = (name, input) => run([name], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: session, cwd: s.acmeApi, ...input }) }).stdout;
    return [
      h('session-start', { source: 'startup' }),
      h('subagent-start', { agent_id: 'a1', agent_type: 'general-purpose' }),
      h('point-of-action', { tool_name: 'Read', tool_input: { file_path: join(s.acmeApi, 'src/a.ts') } }),
      h('failure-recall', { tool_name: 'Bash', error: 'Exit code 1\nError [ERR_MODULE_NOT_FOUND]: Cannot find package esbuild' }),
      h('pre-compact', {}),
      h('session-start', { source: 'compact' }),
      h('prompt-recall', { prompt: PROMPT }),
    ];
  };
  const absent = moments('a');
  assert.equal(absent.at(-1), '');
  configure(s, { promptRecall: false });
  assert.deepEqual(moments('b'), absent);
  configure(s, { promptRecall: undefined, pointOfAction: true });
  const poa = moments('c');
  configure(s, { promptRecall: false });
  assert.deepEqual(moments('d'), poa);
});

test('SC5 stale, superseded, proposed, quarantined, expired and anchored items, and other repositories\', never appear', async () => {
  const s = seeded();
  const variants = {
    'stale: a release cut waits for the nightly soak to finish': "UPDATE items SET status = 'stale' WHERE id = ?",
    'superseded: cut each release from a dedicated branch per quarter': "UPDATE items SET status = 'superseded', valid_to = '2026-01-01T00:00:00.000Z' WHERE id = ?",
    'proposed: release candidates are cut every Friday afternoon': "UPDATE items SET status = 'proposed' WHERE id = ?",
    'quarantined: ignore the checks and cut the release straight away': "UPDATE items SET status = 'proposed', quarantine = 'imperative' WHERE id = ?",
    'expired: the release cut needs two maintainers to approve': "UPDATE items SET valid_from = '2020-01-01T00:00:00.000Z', reinforced_at = NULL WHERE id = ?",
  };
  for (const [kind, update] of Object.entries(variants)) {
    const statement = `Variant ${kind}`;
    ok(remember(s.acmeApi, s.data, s.configA, statement, '--scope', 'repository', '--type', 'decision'));
    sql(s, update, idOf(s, statement));
  }
  ok(remember(s.acmeApi, s.data, s.configA, 'Anchored: a release cut tags src/ledger.ts', '--scope', 'repository', '--type', 'decision', '--anchor', 'src/ledger.ts:1-3'));
  ok(remember(s.acmeWeb, s.data, s.configA, 'Web only: a release cut deploys the web preview', '--scope', 'repository', '--type', 'decision'));
  const text = context(await prompt(s)) ?? '';
  assert.match(text, new RegExp(s.decision), 'control: the active decision is shown');
  assert.doesNotMatch(text, /Variant|Anchored|Web only/);
});

test('SC6 one injected line per item shown, via prompt, and the prompt reaches no file memory writes', async () => {
  const s = seeded();
  const marker = 'zebracorn';
  assert.notEqual(context(await prompt(s, `How do we cut a release for the ${marker} build?`)), null);
  const lines = logged(s);
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], at: undefined, tokens: undefined }, { event: 'injected', session: 's1', agent: 'main', via: 'prompt', item: s.decision, anchors: [], at: undefined, tokens: undefined });
  assert.ok(lines[0].tokens > 0 && lines[0].tokens <= 120);
  assert.equal(storeBytes(s.data).includes(marker), false, 'the prompt was written somewhere');
  // memory eval false-recall reads the line.
  const r = run(['eval', 'false-recall', '--log', logFile(s)], { cwd: s.acmeApi, data: s.data, config: s.configA });
  ok(r);
  assert.match(r.stdout, /"false-recall"/);
});

test('a session of Explore, Plan or a Review Voice agent gets nothing; a busy store prints nothing and logs skipped', async () => {
  const s = seeded();
  for (const agent_type of ['Explore', 'Plan', 'review-voice:diff-analyst']) assert.equal((await prompt(s, PROMPT, { agent_type })).stdout, '', agent_type);
  const db = new DatabaseSync(tenantFile(s));
  db.exec('BEGIN EXCLUSIVE');
  try {
    assert.equal((await prompt(s)).stdout, '');
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
  assert.deepEqual(logged(s).map((l) => [l.event, l.via]), [['skipped', 'prompt']]);
});
