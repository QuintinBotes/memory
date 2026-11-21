import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo, run, sandbox } from './helpers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tasksDir = join(root, 'lab', 'tasks');
const fixtures = join(root, 'test', 'fixtures');
const replay = `"${process.execPath}" "${join(root, 'lab', 'replay-agent.mjs')}" "${join(fixtures, 'lab')}"`;
const TASKS = ['change-reach', 'compaction', 'failure-env', 'hazard-change', 'hazard-keep', 'subagent'];

/** A stand-in for memory's hooks, which write the injection log in a real run: one recall of 42 tokens on the on arm. */
const logged = (agent) =>
  `if [ "$MEMORY_LAB_ARM" = on ]; then mkdir -p "$MEMORY_DATA_DIR/logs" && printf '%s\\n' '{"event":"injected","session":"s1","item":"m-1","via":"session-start","anchors":[],"tokens":42}' >> "$MEMORY_DATA_DIR/logs/injections.jsonl"; fi; ${agent}`;

/** Runs `memory eval` from inside a git repository, with `gh`, `claude` and `curl` replaced by stand-ins that record a call. */
function evaluate(args) {
  const { base } = sandbox();
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const calls = join(base, 'calls');
  for (const name of ['gh', 'claude', 'curl']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${calls}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const data = join(base, 'data');
  const config = join(base, 'config');
  mkdirSync(config);
  const cwd = repo(base, 'acme/api', 'https://github.com/acme/api.git');
  const r = run(['eval', ...args], { cwd, data, config, path: `${bin}:${process.env.PATH}` });
  // The verdict prints one sentence, not rows.
  const rows = r.status === 0 ? r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : [];
  return {
    ...r,
    base,
    config,
    rows,
    row: (task, arm) => rows.find((x) => x.measure === 'session-lab' && x.task === task && x.arm === arm),
    called: existsSync(calls),
    stored: existsSync(data),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }),
  };
}

const hazard = (agent = logged(replay)) => evaluate(['lab', '--task', 'hazard-change', '--model', 'fixture-model', '--agent', agent]);

test('the seeded-hazard task runs three times per arm, and each row reports pass rate, tokens, cache reads, turns, hook durations and the injection log', () => {
  const r = hazard();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.rows.length, 2);
  const off = r.row('hazard-change', 'off');
  const on = r.row('hazard-change', 'on');
  for (const row of [off, on]) {
    assert.equal(row.status, 'measured');
    assert.equal(row.model, 'fixture-model');
    assert.deepEqual(row.samples, { runs: 3, agent_failed: 0 });
    assert.match(row.bar, /no lower/);
  }
  assert.deepEqual(off.switches, []);
  assert.deepEqual(on.switches, ['memory plugin']);
  // The off transcript makes consume async, which the hidden test refuses; the on transcript keeps it synchronous.
  assert.equal(off.pass_rate, 0);
  assert.equal(on.pass_rate, 1);
  assert.equal(on.meets_bar, true);
  assert.equal(off.input_tokens, 1500);
  assert.equal(off.cache_read_tokens, 9000);
  assert.equal(off.turns, 4);
  assert.equal(on.input_tokens, 1700);
  assert.equal(on.cache_read_tokens, 9400);
  assert.equal(on.turns, 3);
  // Only memory's own hooks are timed; the transcript's other hook is not memory's.
  assert.deepEqual(off.hook_ms, {});
  assert.deepEqual(on.hook_ms, { SessionStart: { count: 3, p95: 96 } });
  assert.deepEqual(off.injected, { items: 0, tokens: 0 });
  assert.deepEqual(on.injected, { items: 3, tokens: 126 });
  assert.equal(r.called, false, 'the lab ran gh, claude or curl');
  assert.equal(r.stored, false, "the lab opened or created the owner's memory store");
  assert.equal(r.dirty, '', 'the lab changed the repository it was run from');
});

test('a run is graded by hidden tests the agent is never given: not in its directory, its environment or its plugin copy', () => {
  const look = `if find "$PWD" "\${MEMORY_LAB_PLUGIN:-$PWD}" -name hidden -o -name lab -o -name '*.test.mjs' | grep -q . || env | grep -q "${tasksDir}"; then exit 9; fi; ${replay}`;
  const r = hazard(look);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.row('hazard-change', 'off').samples.agent_failed, 0);
  assert.equal(r.row('hazard-change', 'on').samples.agent_failed, 0);
  assert.equal(r.row('hazard-change', 'on').pass_rate, 1);
  // An agent that changes nothing ends with success, and the hidden tests still fail it.
  const idle = hazard('true');
  assert.equal(idle.row('hazard-change', 'on').pass_rate, 0);
  assert.equal(idle.row('hazard-change', 'on').samples.agent_failed, 0);
});

test('the same agent outputs, scored twice, give identical rows', () => {
  const a = hazard();
  const b = hazard();
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
});

test('a run whose agent fails to start counts as a failed run, not a skipped one', () => {
  for (const agent of ['exit 127', '/nonexistent/agent']) {
    const r = hazard(agent);
    assert.equal(r.status, 0, r.stderr);
    for (const arm of ['off', 'on']) {
      const row = r.row('hazard-change', arm);
      assert.deepEqual(row.samples, { runs: 3, agent_failed: 3 }, agent);
      assert.equal(row.pass_rate, 0);
      assert.equal(row.input_tokens, null);
      assert.equal(row.turns, null);
    }
    // Nothing ran, so nothing is shown no worse: the bar is not judged, and the verdict counts the row as nothing.
    assert.equal(r.row('hazard-change', 'on').meets_bar, null);
    assert.match(r.row('hazard-change', 'on').note, /failed to start/);
  }
});

test('the replay agent re-roots a recorded absolute path and refuses one that leaves its working directory', () => {
  const { base } = sandbox();
  const dir = join(base, 'transcripts');
  mkdirSync(join(dir, 'hazard-change'), { recursive: true });
  const outside = join(base, 'escaped.mjs');
  const line = (o) => `${JSON.stringify(o)}\n`;
  const tool = (name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  // Recorded in /recorded/repo: the absolute Edit lands in this run's copy.
  writeFileSync(join(dir, 'hazard-change', 'on.jsonl'), line({ type: 'system', subtype: 'init', cwd: '/recorded/repo' }) +
    tool('Edit', { file_path: '/recorded/repo/src/ledger.mjs', old_string: '  spent += amount;', new_string: "  if (amount < 0) throw new RangeError('negative');\n  spent += amount;" }) +
    line({ type: 'result', num_turns: 2, modelUsage: {} }));
  writeFileSync(join(dir, 'hazard-change', 'off.jsonl'), tool('Write', { file_path: outside, content: 'export {};\n' }) + tool('Write', { file_path: '../../escaped.mjs', content: 'export {};\n' }));
  const r = hazard(`"${process.execPath}" "${join(root, 'lab', 'replay-agent.mjs')}" "${dir}"`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.row('hazard-change', 'on').pass_rate, 1);
  assert.equal(r.row('hazard-change', 'off').samples.agent_failed, 3);
  assert.equal(existsSync(outside), false);
});

test("the lab's git never reaches the repository it was run from, even when GIT_DIR names it", () => {
  const { base } = sandbox();
  const cwd = repo(base, 'acme/api', 'https://github.com/acme/api.git');
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const before = head();
  const r = spawnSync(process.execPath, [join(root, 'dist', 'memory.mjs'), 'eval', 'lab', '--task', 'hazard-change', '--model', 'm', '--agent', replay], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MEMORY_DATA_DIR: join(base, 'data'), CLAUDE_CONFIG_DIR: base, GIT_DIR: join(cwd, '.git'), GIT_WORK_TREE: cwd, GIT_INDEX_FILE: join(cwd, '.git', 'index') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(head(), before);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }), '');
  assert.match(r.stdout, /"pass_rate":1/);
});

test('a full capability run, six tasks, two arms and three runs each, completes unattended', () => {
  const r = evaluate(['lab', '--model', 'fixture-model', '--agent', replay]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(tasksDir).sort(), TASKS);
  assert.equal(r.rows.length, 12);
  for (const task of TASKS) {
    const off = r.row(task, 'off');
    const on = r.row(task, 'on');
    assert.equal(off.samples.runs, 3, task);
    assert.equal(off.pass_rate, 0, task);
    assert.equal(on.pass_rate, 1, task);
    assert.equal(on.meets_bar, true, task);
  }
  // The compaction task's session starts twice per run, at startup and after the compaction; the subagent task's
  // subagent start is timed beside its session start.
  assert.equal(r.row('compaction', 'on').hook_ms.SessionStart.count, 6);
  assert.deepEqual(Object.keys(r.row('subagent', 'on').hook_ms).sort(), ['SessionStart', 'SubagentStart']);
  assert.equal(r.called, false);
});

test('with no agent named, the lab reports not run beside the other measures', () => {
  const r = evaluate([]);
  assert.equal(r.status, 0, r.stderr);
  for (const arm of ['off', 'on']) {
    const row = r.rows.find((x) => x.measure === 'session-lab' && x.arm === arm);
    assert.equal(row.status, 'not run');
    assert.equal(row.pass_rate, 'not run');
    assert.match(row.note, /--agent/);
  }
});

test('the verdict says auto memory may be switched off only when the scorecard and the lab both hold their bars, and otherwise names the arm that failed', () => {
  const save = (name, rows) => {
    const file = join(sandbox().base, name);
    writeFileSync(file, rows.map((x) => `${JSON.stringify(x)}\n`).join(''));
    return file;
  };
  const pulls = join(fixtures, 'eval', 'pulls.json');
  const log = join(fixtures, 'eval', 'injections.jsonl');
  const held = save('held.jsonl', evaluate(['replay', '--since', '2026-03-01', '--pulls', pulls]).rows);
  const missed = save('missed.jsonl', evaluate(['--since', '2026-03-01', '--pulls', pulls, '--log', log]).rows);
  const lab = save('lab.jsonl', hazard().rows);
  const swapped = `MEMORY_LAB_ARM=$([ "$MEMORY_LAB_ARM" = on ] && echo off || echo on) ${replay}`;
  const worse = save('worse.jsonl', hazard(swapped).rows);
  const unrun = save('unrun.jsonl', evaluate([]).rows.filter((x) => x.measure === 'session-lab'));

  const verdict = (scorecard, labRows) => evaluate(['verdict', '--scorecard', scorecard, '--lab', labRows]);
  const yes = verdict(held, lab);
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(yes.stdout.trim(), `auto memory may be switched off in ${yes.config}`);
  assert.deepEqual(readdirSync(yes.config), [], "the verdict changed Claude Code's configuration");

  const recall = verdict(missed, lab);
  assert.equal(recall.status, 0, recall.stderr);
  assert.doesNotMatch(recall.stdout, /may be switched off/);
  assert.match(recall.stdout, /false-recall \(on arm\)/);

  const lost = verdict(held, worse);
  assert.doesNotMatch(lost.stdout, /may be switched off/);
  assert.match(lost.stdout, /session-lab hazard-change \(on arm\)/);

  // Neither file may stand in for the other, and a file with nothing measured shows nothing.
  for (const [scorecard, labRows] of [[lab, lab], [held, held], [held, unrun]]) {
    const r = verdict(scorecard, labRows);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /may be switched off/);
    assert.match(r.stdout, /no measured row/);
  }
});

test('the lab and the verdict refuse inputs they cannot use, with exit 2 and the reason', () => {
  const { base } = sandbox();
  const bad = join(base, 'bad.jsonl');
  writeFileSync(bad, 'not json\n');
  for (const [args, why] of [
    [['lab', '--model', 'm'], /--agent/],
    [['lab', '--agent', 'true'], /--model/],
    [['lab', '--model', 'm', '--agent', 'true', '--task', 'nope'], /no lab task nope/],
    [['verdict', '--lab', bad], /--scorecard/],
    [['verdict', '--scorecard', bad, '--lab', bad], /line 1/],
    [['verdict', '--scorecard', join(base, 'missing.jsonl'), '--lab', bad], /missing\.jsonl/],
  ]) {
    const r = run(['eval', ...args], { cwd: base });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, why);
  }
});
