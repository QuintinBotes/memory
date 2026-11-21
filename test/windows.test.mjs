import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, remember, run, sessionStart, tokens } from './helpers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const log = (data) => join(data, 'logs', 'injections.jsonl');
const logged = (data) => (existsSync(log(data)) ? readFileSync(log(data), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : []);

/** The JSON Claude Code sends: SessionStart after a compaction, and SubagentStart with the subagent's directory and type. */
const compacted = (cwd, data, config) =>
  run(['session-start'], { cwd, data, config, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'compact', cwd }) });
const subagent = (cwd, data, config, agentType, agentId = 'agent-1') =>
  run(['subagent-start'], { cwd, data, config, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: agentType, cwd }) });
/** The context a SubagentStart hook adds, or null when it printed nothing. */
const context = (r) => {
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return null;
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
  return out.hookSpecificOutput.additionalContext;
};

function edit(data, change) {
  const path = join(data, 'config.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...change }));
}

function seeded() {
  const s = setup();
  for (const [statement, scope] of [
    ['Releases are cut from the main branch only', 'repository'],
    ['Every service exposes a health endpoint', 'organisation'],
    ['Explain changes in plain English', 'person'],
  ]) {
    const r = remember(s.acmeApi, s.data, s.configA, statement, '--scope', scope, '--type', 'convention');
    assert.equal(r.status, 0, r.stderr);
  }
  return s;
}

test('the plugin registers SessionStart after a compaction and SubagentStart, each with a time limit', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.SessionStart.map((h) => h.matcher), ['startup|resume|clear|compact']);
  assert.match(hooks.SessionStart[0].hooks[0].command, /memory\.mjs" session-start$/);
  assert.equal(hooks.SubagentStart.length, 1);
  assert.match(hooks.SubagentStart[0].hooks[0].command, /memory\.mjs" subagent-start$/);
  for (const h of [...hooks.SessionStart, ...hooks.SubagentStart]) assert.ok(h.hooks[0].timeout > 0);
});

test('after a compaction, and in a general-purpose subagent, the slice is byte-identical to the startup slice', () => {
  const s = seeded();
  const startup = sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(startup.status, 0, startup.stderr);
  assert.match(startup.stdout, /Releases are cut/);
  const after = compacted(s.acmeApi, s.data, s.configA);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, startup.stdout);
  assert.equal(context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose')), startup.stdout);
});

test("Explore, Plan and Review Voice's agents get nothing", () => {
  const s = seeded();
  for (const type of ['Explore', 'Plan', 'review-voice:diff-analyst', 'review-voice:challenger', 'challenger', 'statusline-setup']) {
    assert.equal(context(subagent(s.acmeApi, s.data, s.configA, type)), null, type);
  }
  assert.deepEqual(logged(s.data), []);
  // A session started as one of them with --agent, at startup or after a compaction, gets nothing either.
  for (const [source, type] of [['startup', 'review-voice:evidence-verifier'], ['compact', 'Explore'], ['compact', 'diff-analyst']]) {
    const r = run(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source, agent_type: type, cwd: s.acmeApi }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', type);
  }
});

test('an agent type added to the allow list gets the slice; Explore, Plan and Review Voice agents can never be added', () => {
  const s = seeded();
  const startup = sessionStart(s.acmeApi, s.data, s.configA).stdout;
  edit(s.data, { subagentTypes: ['editor', 'my-plugin:implementer'] });
  assert.equal(context(subagent(s.acmeApi, s.data, s.configA, 'editor')), startup);
  assert.equal(context(subagent(s.acmeApi, s.data, s.configA, 'my-plugin:implementer')), startup);
  assert.equal(context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose')), startup);
  assert.equal(context(subagent(s.acmeApi, s.data, s.configA, 'reviewer')), null);
  for (const type of ['Explore', 'Plan', 'review-voice:evidence-verifier', 'tie-breaker']) {
    edit(s.data, { subagentTypes: [type] });
    const r = run(['list'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(r.status, 2, type);
    assert.match(r.stderr, new RegExp(`${type}.*never`));
    // The hook stays silent rather than fail the subagent, and delivers nothing to the refused type.
    assert.equal(context(subagent(s.acmeApi, s.data, s.configA, type)), null, type);
  }
});

test("the subagent slice resolves the tenant from the subagent's working directory", () => {
  const s = seeded();
  const beta = remember(s.betaWeb, s.data, s.configA, 'Beta deploys on Thursdays', '--scope', 'repository', '--type', 'convention');
  assert.equal(beta.status, 0, beta.stderr);
  // The hook runs in the session's directory; the input names the subagent's.
  const inBeta = context(run(['subagent-start'], {
    cwd: s.acmeApi, data: s.data, config: s.configA,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'general-purpose', cwd: s.betaWeb }),
  }));
  assert.equal(inBeta, sessionStart(s.betaWeb, s.data, s.configA).stdout);
  assert.match(inBeta, /Beta deploys/);
  assert.doesNotMatch(inBeta, /Releases are cut|health endpoint/);
});

test('a budget of 0 prints nothing in every window', () => {
  const s = seeded();
  edit(s.data, { sessionBudget: 0 });
  assert.equal(sessionStart(s.acmeApi, s.data, s.configA).stdout, '');
  assert.equal(compacted(s.acmeApi, s.data, s.configA).stdout, '');
  assert.equal(context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose')), null);
  assert.deepEqual(logged(s.data), []);
});

test('each subagent slice stays within 300 tokens and is logged with its agent id and tokens, never its text', () => {
  const s = seeded();
  for (let n = 0; n < 40; n++) {
    const r = remember(s.acmeApi, s.data, s.configA, `Convention number ${n} applies to every module in this repository`, '--scope', 'repository', '--type', 'convention');
    assert.equal(r.status, 0, r.stderr);
  }
  edit(s.data, { sessionBudget: 2000 });
  const slice = context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose', 'agent-7'));
  assert.ok(tokens(slice) <= 300, `${tokens(slice)} tokens`);
  context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose', 'agent-8'));
  const lines = logged(s.data);
  const shown = slice.split('\n').filter((l) => l.startsWith('- ')).length;
  assert.equal(lines.length, 2 * shown);
  for (const line of lines) {
    assert.equal(line.event, 'injected');
    assert.equal(line.via, 'subagent-start');
    assert.equal(line.session, 's1');
    assert.match(line.item, /^m-[0-9a-f]+$/);
    assert.ok(Number.isInteger(line.tokens) && line.tokens > 0);
    assert.deepEqual(line.anchors, []);
  }
  const first = lines.filter((l) => l.agent === 'agent-7');
  assert.equal(first.length, shown);
  assert.ok(first.reduce((sum, l) => sum + l.tokens, 0) <= tokens(slice));
  assert.doesNotMatch(readFileSync(log(s.data), 'utf8'), /Convention number|Releases are cut/);
  // The consent plan says what the log holds.
  const plan = run(['init'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.match(plan.stdout, /anchored file paths.*logs\/injections\.jsonl; never their text/);
  // A startup or compaction slice is not a subagent's, and is not logged here.
  sessionStart(s.acmeApi, s.data, s.configA);
  compacted(s.acmeApi, s.data, s.configA);
  assert.equal(logged(s.data).length, lines.length);
});

test('the subagent hook prints nothing and exits 0 when memory is not set up or its input is not JSON', () => {
  const s = seeded();
  const garbage = run(['subagent-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: 'not json' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
  // A plan changed since the owner agreed to it: memory is inert, and nothing is shown or logged.
  edit(s.data, { tenants: { acme: ['acme/*'] } });
  assert.equal(context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose')), null);
  assert.deepEqual(logged(s.data), []);
  writeFileSync(join(s.data, 'config.json'), '{not json');
  assert.equal(context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose')), null);
});

test("an anchored item's log line carries its anchored paths, for false recall to judge", () => {
  const s = setup();
  const r = remember(s.acmeApi, s.data, s.configA, 'consume runs under the run lock', '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/ledger.ts:1-3');
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose')), /consume runs under the run lock/);
  assert.deepEqual(logged(s.data).map((l) => l.anchors), [['src/ledger.ts']]);
});

test('an owner who agreed before the injection log existed keeps every older category, and the log stays off until they agree again', () => {
  const s = seeded();
  // A consent saved before the plan had a version: it covers only the categories the first plan disclosed.
  const path = join(s.data, 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  delete cfg.consent.version;
  writeFileSync(path, JSON.stringify(cfg));

  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /Releases are cut/);
  assert.match(context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose')), /Releases are cut/);
  assert.deepEqual(logged(s.data), [], 'the log is a category the stored consent does not cover');
  const r = remember(s.acmeApi, s.data, s.configA, 'Tests run in parallel', '--scope', 'repository');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /memory init/, 'a command says a new category waits for the owner');

  // memory init shows the new category as new, and asks again; without --confirm nothing changes.
  const plan = run(['init'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(Number.isInteger(JSON.parse(plan.stdout).version));
  assert.match(plan.stderr, /new since you agreed[\s\S]*logs\/injections\.jsonl[\s\S]*--confirm/);
  assert.doesNotMatch(plan.stderr, /git origin remote/, 'only the new category is shown as new');
  context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose'));
  assert.deepEqual(logged(s.data), []);

  const agreed = run(['init', '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(agreed.status, 0, agreed.stderr);
  assert.match(agreed.stderr, /new since you agreed, and are on from now/);
  context(subagent(s.acmeApi, s.data, s.configA, 'general-purpose'));
  assert.ok(logged(s.data).length > 0, 'once agreed, the log is written');
  assert.doesNotMatch(run(['init'], { cwd: s.acmeApi, data: s.data, config: s.configA }).stderr, /new since you agreed/);
  assert.doesNotMatch(remember(s.acmeApi, s.data, s.configA, 'Lint before commit', '--scope', 'repository').stderr, /memory init/);
});
