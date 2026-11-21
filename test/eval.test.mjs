import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, sandbox } from './helpers.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eval');
const pulls = join(fixtures, 'pulls.json');
const log = join(fixtures, 'injections.jsonl');

/**
 * A PATH holding only stand-ins: `gh`, `claude` and `curl` record that they ran, so a test proves the harness
 * posts nothing and calls no model; `orbit`, when asked for, prints a version.
 */
function bin({ orbit = false } = {}) {
  const { base } = sandbox();
  const dir = join(base, 'bin');
  mkdirSync(dir);
  const calls = join(base, 'calls');
  for (const name of ['gh', 'claude', 'curl']) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> "${calls}"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  if (orbit) {
    writeFileSync(join(dir, 'orbit'), '#!/bin/sh\necho 0.4.0\n');
    chmodSync(join(dir, 'orbit'), 0o755);
  }
  return { path: dir, calls, base };
}

function evaluate(args, options = {}) {
  const b = bin(options);
  const r = run(['eval', ...args], { cwd: b.base, path: b.path });
  const rows = r.status === 0 ? r.stdout.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [];
  return { ...r, rows, row: (measure, arm) => rows.find((x) => x.measure === measure && x.arm === arm), called: existsSync(b.calls) };
}

test('the replay builds memory only from pull requests before the cut-off and counts restated owner-declined findings after it, off and on', () => {
  const r = evaluate(['replay', '--since', '2026-03-01', '--pulls', pulls]);
  assert.equal(r.status, 0, r.stderr);
  const off = r.row('review-replay', 'off');
  const on = r.row('review-replay', 'on');
  assert.equal(off.status, 'measured');
  assert.deepEqual(off.samples, { pulls_before: 2, pulls_after: 2, findings_after: 7, restatements: 4, memory_items: 0 });
  assert.deepEqual(on.samples, { pulls_before: 2, pulls_after: 2, findings_after: 7, restatements: 4, memory_items: 2 });
  assert.equal(off.repeats, 4);
  assert.equal(off.held, 0);
  // Held: the ledger and retry restatements. Repeats: the cache one, declined only after the cut-off, so memory
  // never learned it, and the worker one, which shares no word or path with what memory holds.
  assert.equal(on.held, 2);
  assert.equal(on.repeats, 2);
  assert.equal(on.meets_bar, true);
  // Four restatements, not five: the one of a finding the owner accepted is not a repeat of a declined one.

  // A later cut-off: the cache finding is now evidence before it, and memory holds its restatement.
  const later = evaluate(['replay', '--since', '2026-03-10', '--pulls', pulls]);
  assert.equal(later.status, 0, later.stderr);
  assert.equal(later.row('review-replay', 'off').repeats, 3);
  assert.equal(later.row('review-replay', 'on').samples.memory_items, 3);
  assert.equal(later.row('review-replay', 'on').repeats, 1);
});

test('a replay with no owner-declined finding restated after the cut-off reports zero and says so, not a ratio', () => {
  const r = evaluate(['replay', '--since', '2026-04-01', '--pulls', pulls]);
  assert.equal(r.status, 0, r.stderr);
  const on = r.row('review-replay', 'on');
  assert.equal(r.row('review-replay', 'off').repeats, 0);
  assert.equal(on.repeats, 0);
  assert.equal(on.meets_bar, null);
  assert.match(on.note, /no owner-declined finding was restated after the cut-off/);
});

test("Review Voice's seeded-defect recall is reported beside the replay, as not run, never as a number", () => {
  const r = evaluate(['replay', '--since', '2026-03-01', '--pulls', pulls]);
  for (const arm of ['off', 'on']) {
    const row = r.row('review-voice-seeded-recall', arm);
    assert.equal(row.status, 'not run');
    assert.match(row.note, /model/);
    assert.match(row.bar, /unchanged/);
    assert.equal(row.recall, 'not run');
  }
});

test('the false-recall report gives the share of recalled items later marked wrong or stale, or anchored where nothing was touched', () => {
  const r = evaluate(['false-recall', '--log', log]);
  assert.equal(r.status, 0, r.stderr);
  const on = r.row('false-recall', 'on');
  // Six recalls: m-a once in s1 (shown twice); m-c is false (its file was touched only in another session), m-d was
  // later marked wrong and m-e stale. m-a's wrong mark came before it was shown; m-f's directory anchor was touched.
  assert.deepEqual(on.samples, { sessions: 2, recalled: 6 });
  assert.equal(on.false_recall, 0.5);
  assert.deepEqual(on.why, { marked_wrong_or_stale: 2, no_anchor_touched: 1 });
  assert.equal(on.meets_bar, false);
  assert.match(on.bar, /under 10%/);
  assert.deepEqual(on.switches, ['memory_search', 'session-start']);
  const off = r.row('false-recall', 'off');
  assert.deepEqual(off.switches, []);
  assert.equal(off.samples.recalled, 0);
  assert.equal(off.false_recall, null);
});

test("the Orbit arm plans three runs per goal off and on with Orbit's four measures, and reports them not run until Orbit has a memory switch", () => {
  const r = evaluate(['orbit'], { orbit: true });
  assert.equal(r.status, 0, r.stderr);
  for (const arm of ['off', 'on']) {
    const row = r.row('orbit-benchmark', arm);
    assert.equal(row.status, 'not run');
    assert.equal(row.runs_per_goal, 3);
    for (const m of ['pass_rate', 'cost_per_accepted_task', 'false_done_rate', 'attempts_to_first_green']) assert.equal(row[m], 'not run', m);
    assert.match(row.note, /Orbit 0\.4\.0 is installed/);
    assert.match(row.note, /orbit#233/);
    assert.match(row.bar, /no fall in pass rate/);
    assert.match(row.bar, /no rise in cost/);
  }
  assert.deepEqual(r.row('orbit-benchmark', 'off').switches, []);
  assert.ok(r.row('orbit-benchmark', 'on').switches.length > 0);
});

test('a missing Orbit installation skips the Orbit arm and says so, and the other rows still run', () => {
  const r = evaluate(['--since', '2026-03-01', '--pulls', pulls, '--log', log]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.row('orbit-benchmark', 'on').note, /Orbit is not installed/);
  assert.equal(r.row('orbit-benchmark', 'on').status, 'not run');
  assert.equal(r.row('review-replay', 'on').status, 'measured');
  assert.equal(r.row('false-recall', 'on').status, 'measured');
  for (const row of r.rows) assert.match(row.version, /^\d+\.\d+\.\d+/);
});

test('the whole harness, run twice on the same inputs, prints identical rows, and never calls GitHub or a model', () => {
  const args = ['--since', '2026-03-01', '--pulls', pulls, '--log', log];
  const first = evaluate(args, { orbit: true });
  const second = evaluate(args, { orbit: true });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.rows.length >= 8);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.called || second.called, false);
});

test('each row states its bar and the capabilities on in its arm', () => {
  const r = evaluate(['--since', '2026-03-01', '--pulls', pulls, '--log', log]);
  for (const row of r.rows) {
    assert.ok(row.bar.length > 0, row.measure);
    assert.ok(Array.isArray(row.switches), row.measure);
    if (row.arm === 'off') assert.deepEqual(row.switches, [], row.measure);
  }
  assert.match(r.row('review-replay', 'on').bar, /halved/);
  assert.deepEqual(r.row('review-replay', 'on').switches, ['memory_search']);
});

test('the harness refuses inputs it cannot read, with exit 2 and the reason', () => {
  const { base } = sandbox();
  const bad = join(base, 'bad.json');
  writeFileSync(bad, JSON.stringify({ pulls: [{ number: 1, reviewed_at: '2026-01-01', findings: [{ id: 'a', statement: 'x', restates: 'nope' }] }] }));
  const badLog = join(base, 'bad.jsonl');
  writeFileSync(badLog, '{"event":"injected","session":"s1"}\n');
  for (const [args, why] of [
    [['replay', '--pulls', pulls], /--since/],
    [['replay', '--since', 'soon', '--pulls', pulls], /--since/],
    [['replay', '--since', '2026-03-01', '--pulls', join(base, 'missing.json')], /missing\.json/],
    [['replay', '--since', '2026-03-01', '--pulls', bad], /restates/],
    [['false-recall', '--log', badLog], /line 1/],
    [['false-recall'], /--log/],
    [['poison'], /unknown measure/],
  ]) {
    const r = run(['eval', ...args], { cwd: base });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, why);
  }
});
