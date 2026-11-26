import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, sandbox } from './helpers.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'head-to-head');
const acme = join(fixtures, 'acme.json');
const checked = join(fixtures, 'checked.jsonl');
const CATEGORIES = ['single-fact', 'multi-source', 'knowledge-update', 'temporal', 'abstention', 'code-anchored-hazard', 'stale-citation'];
const BUILT_IN = ['memory', 'off', 'auto-memory', 'whole-history'];
const EXTERNAL = ['mem0', 'graphiti', 'basic-memory', 'community-plugin'];

/**
 * A stand-in for an alternative's local install, speaking the arm protocol (README, Head to head): it answers with every
 * ingested statement sharing a word with the question. `mode` makes it crash, ignore the telemetry switch, or count
 * its runs.
 */
function stubArm(base, name, mode = 'ok') {
  const file = join(base, `${name}.mjs`);
  writeFileSync(file, `
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
let held = [];
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.op === 'hello') {
    if (mode === 'crash') process.exit(3);
    const off = process.env.DO_NOT_TRACK === '1' && (${JSON.stringify(name)} !== 'mem0' || process.env.MEM0_TELEMETRY === 'False');
    console.log(JSON.stringify({ telemetry: mode === 'telemetry-on' || !off ? 'on' : 'off' }));
  } else if (m.op === 'ingest') {
    held = m.evidence.filter((e) => e.kind !== 'code-change').map((e) => e.statement);
    console.log(JSON.stringify({ ok: true }));
  } else if (m.op === 'answer') {
    const words = m.question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    console.log(JSON.stringify({ hits: held.filter((s) => words.some((w) => s.toLowerCase().includes(w))).slice(0, 5) }));
  }
}
`);
  return [process.execPath, file];
}

function headToHead(args, { history = acme, arms, data } = {}) {
  const { base } = sandbox();
  const dir = data ?? join(base, 'data');
  const extra = [];
  if (arms !== undefined) {
    const file = join(base, 'arms.json');
    writeFileSync(file, JSON.stringify({ arms: arms(base) }));
    extra.push('--arms', file);
  }
  const r = run(['eval', 'head-to-head', '--history', history, ...extra, ...args], { cwd: base, data: dir });
  const rows = r.status === 0 ? r.stdout.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [];
  const out = join(dir, 'eval', 'head-to-head', 'acme');
  return {
    ...r,
    rows,
    base,
    out,
    row: (arm, category = 'all') => rows.find((x) => x.measure === 'head-to-head' && x.arm === arm && x.category === category),
    latency: (arm) => rows.find((x) => x.measure === 'head-to-head-latency' && x.arm === arm),
    verdict: rows.find((x) => x.measure === 'head-to-head-verdict'),
    lines: (name) => readFileSync(join(out, name), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)),
  };
}

/** A small history, one question per category, written for one test. */
function smallHistory(base, extra = {}) {
  const file = join(base, 'small.json');
  writeFileSync(file, JSON.stringify({
    tenant: 'acme', repository: 'acme/api', client: true,
    evidence: [
      { id: 'a', at: '2026-01-02', kind: 'decision', statement: 'The ledger worker batch size is 40', key: 'batch size is 40' },
      { id: 'b1', at: '2026-01-03', kind: 'decision', statement: 'Run the ledger migration before deploying', key: 'ledger migration before deploying' },
      { id: 'b2', at: '2026-01-04', kind: 'decision', statement: 'Flush the ledger cache after deploying', key: 'ledger cache after deploying' },
      { id: 'c1', at: '2026-01-05', kind: 'decision', statement: 'Store ledger amounts as floats', key: 'amounts as floats' },
      { id: 'c2', at: '2026-02-05', kind: 'decision', statement: 'Store ledger amounts as integer cents', key: 'amounts as integer cents', supersedes: 'c1' },
      { id: 'h', at: '2026-01-06', kind: 'hazard', statement: 'Never call ledger.post() without the row lock', key: 'without the row lock', path: 'src/ledger/post.ts' },
      { id: 's', at: '2026-01-07', kind: 'hazard', statement: 'The ledger rounding rule lives in legacy module one', key: 'rounding rule lives in legacy module one', path: 'src/ledger/legacy.ts' },
      { id: 'x', at: '2026-02-08', kind: 'code-change', statement: 'Rewrote src/ledger/legacy.ts', path: 'src/ledger/legacy.ts' },
      { id: 'v', at: '2026-01-09', kind: 'lesson', statement: 'Webhook deliveries retry seven times', key: 'retry seven times' },
      { id: 'late', at: '2026-04-01', kind: 'decision', statement: 'The ledger archive keeps nine months', key: 'archive keeps nine months' },
    ],
    events: [
      { id: 'q1', at: '2026-03-02', kind: 'correction', question: 'What batch size does the ledger worker use?', answers: ['a'] },
      { id: 'q2', at: '2026-03-03', kind: 'decision', question: 'What must happen when deploying the ledger?', answers: ['b1', 'b2'] },
      { id: 'q3', at: '2026-03-04', kind: 'correction', question: 'How do we store ledger amounts?', answers: ['c2'] },
      { id: 'q4', at: '2026-03-05', kind: 'failure', question: 'How did we store ledger amounts at commit c9?', asOf: '2026-01-20', answers: ['c1'] },
      { id: 'q5', at: '2026-03-06', kind: 'decision', question: 'Who approves forklift rentals?', answers: [] },
      { id: 'q6', at: '2026-03-07', kind: 'failure', question: 'Editing src/ledger/post.ts: anything to watch?', path: 'src/ledger/post.ts', answers: ['h'] },
      { id: 'q7', at: '2026-03-08', kind: 'correction', question: 'Where does the ledger rounding rule live?', answers: ['s'] },
      { id: 'q8', at: '2026-03-09', kind: 'failure', question: 'How often are callbacks attempted again?', answers: ['v'] },
      { id: 'q9', at: '2026-04-02', kind: 'correction', question: 'How long does the ledger archive keep records?', answers: ['late'] },
      { id: 'q0', at: '2026-01-30', kind: 'correction', question: 'Asked before the cut-off', answers: ['a'] },
    ],
    ...extra,
  }));
  return file;
}

test('the replay set takes questions only from after the cut-off, ingests only evidence before it, and labels each with one of seven categories', () => {
  const { base } = sandbox();
  const r = headToHead(['--since', '2026-03-01'], { history: smallHistory(base) });
  assert.equal(r.status, 0, r.stderr);
  const set = JSON.parse(readFileSync(join(r.out, 'replay-set.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(set.questions.map((q) => [q.id, q.category])), {
    q1: 'single-fact', q2: 'multi-source', q3: 'knowledge-update', q4: 'temporal', q5: 'abstention', q6: 'code-anchored-hazard', q7: 'stale-citation', q8: 'single-fact',
  });
  // q9's answer was recorded after the cut-off; q0 was asked before it.
  assert.equal(set.dropped, 1);
  assert.deepEqual(set.ingest.map((e) => e.id), ['a', 'b1', 'b2', 'c1', 'h', 's', 'v', 'c2', 'x']);
  const q3 = set.questions.find((q) => q.id === 'q3');
  assert.deepEqual([q3.keys, q3.mustNot], [['amounts as integer cents'], ['amounts as floats']]);
  const q7 = set.questions.find((q) => q.id === 'q7');
  assert.deepEqual([q7.keys, q7.mustNot], [[], ['rounding rule lives in legacy module one']]);
});

test('the synthetic acme fixture builds about 300 questions, every category present, its five late answers dropped', () => {
  const r = headToHead(['--since', '2026-06-01']);
  assert.equal(r.status, 0, r.stderr);
  const set = JSON.parse(readFileSync(join(r.out, 'replay-set.json'), 'utf8'));
  assert.equal(set.questions.length, 315);
  assert.equal(set.dropped, 5);
  for (const c of CATEGORIES) assert.equal(set.questions.filter((q) => q.category === c).length, 45, c);
  assert.ok(set.ingest.every((e) => e.at < '2026-06-01'));
});

test('the scorecard writes the FR-006 bars first, then each arm and category: recall at 1 and 5, abstention, stale recall, tokens and latency', () => {
  const r = headToHead(['--since', '2026-06-01']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.rows[0].measure, 'head-to-head-bars');
  assert.match(JSON.stringify(r.rows[0].bars), /knowledge-update.*abstention.*stale-citation/);
  assert.match(JSON.stringify(r.rows[0].bars), /5 points/);
  assert.match(JSON.stringify(r.rows[0].bars), /one fifth/);
  assert.match(JSON.stringify(r.rows[0].bars), /150 ms/);
  for (const arm of BUILT_IN) {
    for (const c of CATEGORIES) {
      const row = r.row(arm, c);
      assert.equal(row.status, 'measured', `${arm} ${c}`);
      for (const f of ['recall_at_1', 'recall_at_5', 'stale_recall', 'abstained', 'tokens_per_question', 'tokens_per_correct_item']) assert.ok(f in row, `${arm} ${c} ${f}`);
      assert.equal(row.samples, 45);
    }
    assert.ok('abstention_precision' in r.row(arm));
    assert.equal(typeof r.latency(arm).p50_ms, 'number');
    assert.equal(typeof r.latency(arm).p95_ms, 'number');
  }
  // Memory off answers nothing: every abstention is right and nothing else is.
  assert.equal(r.row('off', 'abstention').abstained, 1);
  assert.equal(r.row('off').abstention_precision, Math.round((45 / 315) * 1000) / 1000);
  assert.equal(r.row('off', 'single-fact').recall_at_5, 0);
  // The whole history finds everything and recalls every stale and superseded item with it.
  assert.equal(r.row('whole-history', 'single-fact').recall_at_5, 1);
  assert.equal(r.row('whole-history', 'stale-citation').stale_recall, 1);
  assert.ok(r.row('whole-history').tokens_per_question > 20 * r.row('memory').tokens_per_question);
  // Claude Code loads the first 200 lines of auto memory, so items written later are not in it.
  assert.ok(r.row('auto-memory', 'multi-source').recall_at_5 < 1);
});

test("on the synthetic fixture memory's stale recall is 0% and its knowledge-update recall at 1 at least 95% (SC-002)", () => {
  const r = headToHead(['--since', '2026-06-01']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.row('memory', 'stale-citation').stale_recall, 0);
  assert.equal(r.row('memory', 'knowledge-update').stale_recall, 0);
  assert.ok(r.row('memory', 'knowledge-update').recall_at_1 >= 0.95, String(r.row('memory', 'knowledge-update').recall_at_1));
});

test('grading is deterministic: two runs print the same rows but latency, and 30 sampled grades report the matcher precision once hand-checked', () => {
  const first = headToHead(['--since', '2026-06-01', '--checked', checked]);
  const second = headToHead(['--since', '2026-06-01', '--checked', checked]);
  assert.equal(first.status, 0, first.stderr);
  const graded = (r) => r.rows.filter((x) => x.measure !== 'head-to-head-latency');
  assert.deepEqual(graded(first), graded(second));
  const sample = first.lines('sample.jsonl');
  assert.equal(sample.length, 30);
  for (const s of sample) assert.ok(s.arm && s.question && s.key && typeof s.excerpt === 'string' && s.correct === null);
  assert.deepEqual(first.verdict.matcher_precision, { sample: 30, checked: 30, precision: 1 });
  const unchecked = headToHead(['--since', '2026-06-01']);
  assert.equal(unchecked.verdict.matcher_precision.checked, 0);
  assert.equal(unchecked.verdict.matcher_precision.precision, null);
  assert.match(unchecked.verdict.matcher_precision.note, /sample\.jsonl/);
});

test('a miss by memory that another arm found, sharing no word with the question, counts as a vocabulary miss, and its share is kept for later', () => {
  const { base } = sandbox();
  const r = headToHead(['--since', '2026-03-01'], { history: smallHistory(base) });
  assert.equal(r.status, 0, r.stderr);
  // q8 asks about "callbacks attempted again"; the item says "Webhook deliveries retry seven times".
  assert.equal(r.verdict.vocabulary_misses, 1);
  assert.ok(r.verdict.memory_misses_found_elsewhere >= 1);
  assert.equal(r.verdict.vocabulary_miss_share, Math.round((1 / r.verdict.memory_misses_found_elsewhere) * 1000) / 1000);
  const saved = JSON.parse(readFileSync(join(r.out, 'last.json'), 'utf8'));
  assert.equal(saved.vocabulary_miss_share, r.verdict.vocabulary_miss_share);
  assert.equal(saved.since, '2026-03-01');
  // Every per-question result stays in the data directory.
  const results = r.lines('results.jsonl');
  assert.ok(results.some((x) => x.arm === 'memory' && x.question === 'q8' && x.at5 === 0));
});

test('the verdict checks memory against the best alternative on each bar and names the categories it misses (SC-001)', () => {
  const r = headToHead(['--since', '2026-06-01']);
  assert.equal(r.status, 0, r.stderr);
  const checks = Object.fromEntries(r.verdict.checks.map((c) => [c.bar, c]));
  for (const bar of ['knowledge-update', 'abstention', 'stale-citation', 'single-fact', 'multi-source', 'tokens-per-correct-item']) {
    assert.equal(typeof checks[bar].meets, 'boolean', bar);
    assert.ok(checks[bar].best_arm !== 'off' && checks[bar].best_arm !== 'memory', bar);
  }
  assert.deepEqual(r.verdict.misses, r.verdict.checks.filter((c) => !c.meets).map((c) => c.bar));
  assert.equal(typeof r.latency('memory').meets_bar, 'boolean');
});

test('every alternative arm is in the scorecard: one not installed scores zero and says so, never silently left out', () => {
  const r = headToHead(['--since', '2026-06-01']);
  assert.equal(r.status, 0, r.stderr);
  for (const arm of EXTERNAL) {
    const row = r.row(arm);
    assert.equal(row.status, 'failed', arm);
    assert.equal(row.recall_at_5, 0);
    assert.match(row.note, /not installed/);
  }
});

test('an installed alternative runs as a separate process with its telemetry off; one that crashes or keeps telemetry on scores zero', () => {
  const r = headToHead(['--since', '2026-06-01'], {
    arms: (base) => ({
      mem0: { command: stubArm(base, 'mem0') },
      graphiti: { command: stubArm(base, 'graphiti', 'crash') },
      'basic-memory': { command: stubArm(base, 'basic-memory', 'telemetry-on') },
      'community-plugin': { command: [join(base, 'nowhere')] },
    }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.row('mem0').status, 'measured');
  assert.ok(r.row('mem0', 'single-fact').recall_at_5 > 0);
  assert.equal(r.row('graphiti').status, 'failed');
  assert.match(r.row('graphiti').note, /crashed|exited/);
  assert.equal(r.row('basic-memory').status, 'failed');
  assert.match(r.row('basic-memory').note, /telemetry/);
  assert.equal(r.row('basic-memory', 'abstention').abstained, 0);
  assert.match(r.row('community-plugin').note, /not installed/);
});

test('a model-backed arm reports its spread over three runs', () => {
  const r = headToHead(['--since', '2026-06-01'], { arms: (base) => ({ mem0: { command: stubArm(base, 'mem0'), modelBacked: true } }) });
  assert.equal(r.status, 0, r.stderr);
  const row = r.row('mem0', 'single-fact');
  assert.equal(row.runs, 3);
  assert.equal(row.spread.recall_at_5.length, 2);
  assert.equal(r.row('memory', 'single-fact').runs, 1);
});

test('for a client tenant an arm that sends evidence off the machine is skipped with the reason; for a personal tenant it runs', () => {
  const arms = (base) => ({ mem0: { command: stubArm(base, 'mem0'), offMachine: true } });
  const client = headToHead(['--since', '2026-06-01'], { arms });
  assert.equal(client.status, 0, client.stderr);
  assert.equal(client.row('mem0').status, 'skipped');
  assert.match(client.row('mem0').note, /client tenant/);
  const { base } = sandbox();
  const personal = headToHead(['--since', '2026-03-01'], { arms, history: smallHistory(base, { client: false }) });
  assert.equal(personal.status, 0, personal.stderr);
  assert.equal(personal.row('mem0').status, 'measured');
});

test('the head-to-head refuses inputs it cannot use, with exit 2 and the reason', () => {
  const { base } = sandbox();
  const badArms = join(base, 'arms.json');
  writeFileSync(badArms, JSON.stringify({ arms: { mem0: { command: 'mem0' } } }));
  const badHistory = join(base, 'bad.json');
  writeFileSync(badHistory, JSON.stringify({ tenant: 'acme', repository: 'acme/api', evidence: [{ id: 'a', at: '2026-01-01', kind: 'decision', statement: 'x' }], events: [] }));
  for (const [args, why] of [
    [['--history', acme], /--since/],
    [['--since', '2026-06-01'], /--history/],
    [['--since', 'soon', '--history', acme], /--since/],
    [['--since', '2026-06-01', '--history', acme, '--arms', badArms], /command/],
    [['--since', '2026-06-01', '--history', badHistory], /key/],
  ]) {
    const r = run(['eval', 'head-to-head', ...args], { cwd: base, data: join(base, 'data') });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, why);
  }
});
