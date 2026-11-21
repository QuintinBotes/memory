import { spawnSync } from 'node:child_process';

/**
 * One scorecard row: a measure in one arm, with the plugin version, the
 * capabilities on in that arm, its sample sizes and its bar. A measure that
 * could not run says "not run" and why; it never carries a number. Rows hold
 * no time and no item id, so the same inputs print the same rows.
 */
export interface Row {
  measure: string;
  arm: 'off' | 'on';
  version: string;
  switches: string[];
  status: 'measured' | 'not run';
  bar: string;
  [field: string]: unknown;
}

/** What a measure is called, the capabilities its on arm turns on, and the bar it must hold. */
export interface Measure {
  measure: string;
  on: string[];
  bar: string;
}

/** A row with its columns in one order: measure, arm, version, switches, status, bar, then the measure's own. */
export const row = (version: string, m: Measure, arm: Row['arm'], status: Row['status'], fields: Record<string, unknown>, switches = arm === 'on' ? m.on : []): Row => ({
  measure: m.measure,
  arm,
  version,
  switches,
  status,
  bar: m.bar,
  ...fields,
});

/** The off and on rows of a measure that did not run, every figure "not run". */
export const notRun = (version: string, m: Measure, note: string, figures: string[], extra: Record<string, unknown> = {}): Row[] =>
  (['off', 'on'] as const).map((arm) => row(version, m, arm, 'not run', { ...extra, ...Object.fromEntries(figures.map((f) => [f, 'not run'])), note }));

/** SC-002 of #8: reported beside the replay. It needs Review Voice's reviewer, a model, which this harness never calls. */
export const seededRecall = (version: string): Row[] =>
  notRun(
    version,
    { measure: 'review-voice-seeded-recall', on: ['memory_search'], bar: 'seeded recall unchanged with memory on' },
    "Review Voice's seeded-defect suite runs its reviewer, a model, and Review Voice does not call memory yet; this harness calls no model",
    ['recall'],
  );

/**
 * Orbit's benchmark, memory off and on, three runs per goal (orbit#172). Its live tier calls a model and spends
 * money, and its benchmark has no memory switch until orbit#233, so this arm only says whether Orbit is here.
 */
export function orbitArm(version: string): Row[] {
  const r = spawnSync('orbit', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  const found = r.status === 0 ? r.stdout.trim().split('\n')[0] : undefined;
  const note =
    (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      ? 'Orbit is not installed (no orbit on PATH), so its arm is skipped'
      : found === undefined
        ? 'orbit --version failed, so its arm is skipped'
        : `Orbit ${found} is installed, but its benchmark has no memory switch until QuintinBotes/orbit#233; a live run calls a model and spends money, which this harness never does`;
  return notRun(
    version,
    { measure: 'orbit-benchmark', on: ['orbit memory adapter'], bar: 'no fall in pass rate; no rise in cost per accepted task' },
    note,
    ['pass_rate', 'cost_per_accepted_task', 'false_done_rate', 'attempts_to_first_green'],
    { runs_per_goal: 3 },
  );
}
