import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { estimate } from '../../slice.ts';
import { ArmFailed, EXTERNAL_ARMS, autoMemoryArm, externalArm, memoryArm, offArm, wholeHistoryArm, type Arm, type ExternalSpec } from './arms.ts';
import { grade, holds, precision, sample, sharesNoWord, type Grade, type Sampled } from './grade.ts';
import { CATEGORIES, type Question, type ReplaySet } from './replay-set.ts';

/** FR-006 of #25, written into the scorecard before any arm runs. "The best alternative" is any arm but memory and memory off. */
export const BARS = {
  'knowledge-update': 'memory at or above the best alternative on knowledge-update recall at 1',
  abstention: 'memory at or above the best alternative on abstention precision',
  'stale-citation': 'memory at or above the best alternative on stale citation: one minus stale recall',
  'single-fact': 'memory within 5 points of the best alternative on single-fact recall at 5',
  'multi-source': 'memory within 5 points of the best alternative on multi-source recall at 5',
  'tokens-per-correct-item': "memory at most one fifth of the best alternative's tokens per correct item, the best alternative being the one with the highest recall at 5 over all questions",
  latency: 'memory p95 latency at most 150 ms',
} as const;

const P95_MS = 150;
const BUILT_IN: Record<string, () => Arm> = { memory: memoryArm, off: offArm, 'auto-memory': autoMemoryArm, 'whole-history': wholeHistoryArm };
const MODEL_RUNS = 3;

/** The arms configuration: `{"arms": {"<name>": {"command": [...], "offMachine"?, "modelBacked"?}}}`. */
export function parseArms(text: string): Record<string, ExternalSpec> {
  const doc = JSON.parse(text) as { arms?: unknown };
  const arms = doc?.arms;
  if (typeof arms !== 'object' || arms === null || Array.isArray(arms)) throw new Error('expected {"arms": {"<name>": {"command": [...]}}}');
  for (const [name, spec] of Object.entries(arms as Record<string, ExternalSpec>)) {
    if (name in BUILT_IN) throw new Error(`${name} is a built-in arm and takes no command`);
    if (!Array.isArray(spec?.command) || spec.command.length === 0 || !spec.command.every((c) => typeof c === 'string' && c !== '')) {
      throw new Error(`arm ${name} needs a command: a list of the program and its arguments`);
    }
    for (const flag of ['offMachine', 'modelBacked'] as const) {
      if (spec[flag] !== undefined && typeof spec[flag] !== 'boolean') throw new Error(`arm ${name}: ${flag} is true or false`);
    }
  }
  return arms as Record<string, ExternalSpec>;
}

interface Answer {
  q: Question;
  hits: string[];
  ms: number;
}

/** One run of an arm: ingest, then every question, each answer timed here. */
async function runArm(arm: Arm, set: ReplaySet): Promise<Answer[]> {
  try {
    await arm.ingest(set);
    const out: Answer[] = [];
    for (const q of set.questions) {
      const start = performance.now();
      const hits = await arm.answer(q);
      out.push({ q, hits, ms: performance.now() - start });
    }
    return out;
  } finally {
    arm.close();
  }
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : r3(xs.reduce((a, b) => a + b, 0) / xs.length));
const pct = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! * 10) / 10;
};

/** The figures of a set of grades: one category's, or all of an arm's. */
function figures(grades: Grade[], all: boolean): Record<string, unknown> {
  const keyed = grades.filter((g) => g.category !== 'abstention' && g.category !== 'stale-citation');
  const guarded = grades.filter((g) => g.category === 'knowledge-update' || g.category === 'stale-citation');
  const correct = grades.reduce((a, g) => a + g.correct, 0);
  const tokens = grades.reduce((a, g) => a + g.tokens, 0);
  const silent = grades.filter((g) => g.abstained);
  return {
    samples: grades.length,
    recall_at_1: mean(keyed.map((g) => g.at1)),
    recall_at_5: mean(keyed.map((g) => g.at5)),
    abstained: mean(grades.map((g) => (g.abstained ? 1 : 0))),
    stale_recall: mean(guarded.map((g) => (g.staleRecalled ? 1 : 0))),
    tokens_per_question: mean(grades.map((g) => g.tokens)),
    tokens_per_correct_item: correct === 0 ? null : Math.round((tokens / correct) * 10) / 10,
    ...(all ? { abstention_precision: silent.length === 0 ? null : r3(silent.filter((g) => g.category === 'abstention').length / silent.length) } : {}),
  };
}

interface Result {
  arm: string;
  status: 'measured' | 'failed' | 'skipped';
  runs: number;
  note?: string;
  answers: Answer[];
  grades: Grade[];
  /** Per category, recall at 5 of each run. */
  perRun: Record<string, number[]>;
}

async function measure(name: string, make: () => Arm, set: ReplaySet, runs: number): Promise<Result> {
  let first: Answer[] = [];
  const perRun: Record<string, number[]> = {};
  for (let i = 0; i < runs; i++) {
    const answers = await runArm(make(), set);
    if (i === 0) first = answers;
    const grades = answers.map((a) => grade(name, a.q, a.hits, estimate(a.hits.join('\n')), a.ms));
    for (const c of CATEGORIES) (perRun[c] ??= []).push((figures(grades.filter((g) => g.category === c), false)['recall_at_5'] as number | null) ?? 0);
  }
  return { arm: name, status: 'measured', runs, answers: first, grades: first.map((a) => grade(name, a.q, a.hits, estimate(a.hits.join('\n')), a.ms)), perRun };
}

export interface Scorecard {
  rows: Record<string, unknown>[];
  last: Record<string, unknown>;
}

/**
 * The head-to-head replay (#25): each arm ingests the same evidence and answers the same questions; the scorecard
 * gives, per arm and category, recall at 1 and 5, abstention, stale recall, tokens and latency, then the bars' verdict.
 * Every row but the latency rows is the same for the same inputs and arm versions.
 */
export async function headToHead(version: string, set: ReplaySet, external: Record<string, ExternalSpec>, checked: Sampled[], out: string): Promise<Scorecard> {
  const bars = { measure: 'head-to-head-bars', version, tenant: set.tenant, since: set.since, status: 'set before the run', bars: BARS };
  const results: Result[] = [];
  for (const [name, make] of Object.entries(BUILT_IN)) results.push(await measure(name, make, set, 1));
  for (const name of [...new Set([...Object.keys(EXTERNAL_ARMS), ...Object.keys(external)])]) {
    const spec = external[name];
    const none = { arm: name, runs: 0, answers: [], grades: [], perRun: {} };
    if (spec === undefined) results.push({ ...none, status: 'failed', note: `${name} is not installed: no command for it in the arms file (README, Head to head)` });
    else if (spec.offMachine === true && set.client) results.push({ ...none, status: 'skipped', note: `${name} sends evidence off this machine, and ${set.tenant} is a client tenant` });
    else {
      try {
        results.push(await measure(name, () => externalArm(name, spec), set, spec.modelBacked === true ? MODEL_RUNS : 1));
      } catch (error) {
        results.push({ ...none, status: 'failed', note: error instanceof ArmFailed ? error.message : `${name} crashed: ${(error as Error).message}` });
      }
    }
  }

  const rows: Record<string, unknown>[] = [bars];
  const latency: Record<string, unknown>[] = [];
  for (const r of results) {
    const base = { measure: 'head-to-head', arm: r.arm, version, status: r.status, runs: r.runs };
    const note = r.note === undefined ? {} : { note: r.note };
    for (const c of [...CATEGORIES, 'all'] as const) {
      const fields =
        r.status === 'measured' ? figures(c === 'all' ? r.grades : r.grades.filter((g) => g.category === c), c === 'all')
        : { samples: set.questions.filter((q) => c === 'all' || q.category === c).length, recall_at_1: 0, recall_at_5: 0, abstained: 0, stale_recall: null, tokens_per_question: null, tokens_per_correct_item: null, ...(c === 'all' ? { abstention_precision: null } : {}) };
      const spread = r.runs > 1 && c !== 'all' ? { spread: { recall_at_5: [Math.min(...r.perRun[c]!), Math.max(...r.perRun[c]!)] } } : {};
      rows.push({ ...base, category: c, ...fields, ...spread, ...note });
    }
    const ms = r.grades.map((g) => g.ms);
    const p95 = pct(ms, 95);
    latency.push({
      measure: 'head-to-head-latency', arm: r.arm, version, status: r.status, p50_ms: pct(ms, 50), p95_ms: p95,
      ...(r.arm === 'memory' ? { bar: BARS.latency, meets_bar: p95 !== null && p95 <= P95_MS } : {}), ...note,
    });
  }

  // The verdict: memory against the best alternative on each bar.
  const score = (r: Result, bar: string): number => {
    if (r.status !== 'measured') return 0;
    const of = (c: string): Record<string, unknown> => figures(c === 'all' ? r.grades : r.grades.filter((g) => g.category === c), c === 'all');
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
    if (bar === 'knowledge-update') return n(of(bar)['recall_at_1']);
    if (bar === 'abstention') return n(of('all')['abstention_precision']);
    if (bar === 'stale-citation') return 1 - n(of(bar)['stale_recall'] ?? 1);
    return n(of(bar)['recall_at_5']);
  };
  const memory = results.find((r) => r.arm === 'memory')!;
  const alternatives = results.filter((r) => r.arm !== 'memory' && r.arm !== 'off' && r.status !== 'skipped');
  const checks: Record<string, unknown>[] = [];
  for (const bar of ['knowledge-update', 'abstention', 'stale-citation', 'single-fact', 'multi-source'] as const) {
    const best = alternatives.reduce((a, b) => (score(b, bar) > score(a, bar) ? b : a));
    const [mine, theirs] = [r3(score(memory, bar)), r3(score(best, bar))];
    const meets = bar === 'single-fact' || bar === 'multi-source' ? mine >= theirs - 0.05 : mine >= theirs;
    checks.push({ bar, memory: mine, best_alternative: theirs, best_arm: best.arm, meets });
  }
  const tokens = (r: Result): number | null => (r.status === 'measured' ? (figures(r.grades, true)['tokens_per_correct_item'] as number | null) : null);
  const recall = (r: Result): number => (r.status === 'measured' ? ((figures(r.grades, true)['recall_at_5'] as number | null) ?? 0) : 0);
  const best = alternatives.reduce((a, b) => (recall(b) > recall(a) ? b : a));
  const [mine, theirs] = [tokens(memory), tokens(best)];
  checks.push({ bar: 'tokens-per-correct-item', memory: mine, best_alternative: theirs, best_arm: best.arm, meets: mine !== null && (theirs === null || mine * 5 <= theirs) });

  // SC-003: memory's misses that another arm found, and of them the ones whose item shares no word with the question.
  let elsewhere = 0;
  let vocabulary = 0;
  memory.answers.forEach((a, i) => {
    a.q.keys.forEach((key, k) => {
      if (a.hits.slice(0, 5).some((h) => holds(h, key))) return;
      if (!results.some((r) => r !== memory && r.answers[i]?.hits.slice(0, 5).some((h) => holds(h, key)))) return;
      elsewhere++;
      if (sharesNoWord(a.q.question, a.q.statements[k]!)) vocabulary++;
    });
  });
  const sampled = sample(results.flatMap((r) => r.answers.map((a) => ({ arm: r.arm, q: a.q, hits: a.hits }))));
  const share = elsewhere === 0 ? null : r3(vocabulary / elsewhere);
  const misses = checks.filter((c) => !c.meets).map((c) => c.bar);
  const verdict = {
    measure: 'head-to-head-verdict', version, tenant: set.tenant, since: set.since,
    replay_set: {
      questions: set.questions.length, ingested: set.ingest.length, dropped: set.dropped,
      by_category: Object.fromEntries(CATEGORIES.map((c) => [c, set.questions.filter((q) => q.category === c).length])),
    },
    checks, misses,
    vocabulary_misses: vocabulary, memory_misses_found_elsewhere: elsewhere, vocabulary_miss_share: share,
    matcher_precision: precision(sampled, checked, join(out, 'sample.jsonl')),
  };
  rows.push(...latency, verdict);

  // Everything per question stays in the data directory; only these rows are printed.
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const write = (file: string, text: string): void => writeFileSync(join(out, file), text, { mode: 0o600 });
  const lines = (xs: unknown[]): string => xs.map((x) => `${JSON.stringify(x)}\n`).join('');
  write('replay-set.json', `${JSON.stringify(set, null, 1)}\n`);
  write('results.jsonl', lines(results.flatMap((r) => r.grades)));
  write('sample.jsonl', lines(sampled));
  write('scorecard.jsonl', lines(rows));
  const last = { tenant: set.tenant, since: set.since, version, vocabulary_misses: vocabulary, memory_misses_found_elsewhere: elsewhere, vocabulary_miss_share: share, misses };
  write('last.json', `${JSON.stringify(last, null, 2)}\n`);
  return { rows, last };
}

/** Where a tenant's head-to-head files live in the data directory; #28 reads `vocabulary_miss_share` from last.json there. */
export const headToHeadDir = (data: string, tenant: string): string => join(data, 'eval', 'head-to-head', tenant);

