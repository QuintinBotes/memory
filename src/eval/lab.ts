import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_VARIABLES } from '../context.ts';
import { injectionLog } from '../store/paths.ts';
import { row, type Measure, type Row } from './scorecard.ts';

/**
 * The session lab (#6): fixture tasks run by an agent command, memory's plugin off and on, three runs per arm, each
 * graded by hidden tests. Each task is a directory of `lab/tasks`:
 *
 *   task.json   {"about": "...", "prompt": "...", "memory": [{"scope", "type", "statement", "anchor"?}]}
 *   repo/       the fixture repository, copied to a temporary directory for every run
 *   hidden/     *.test.mjs, run with node --test after the agent exits, with LAB_REPO naming the run's copy
 *
 * The agent command runs under /bin/sh in the copy, with the prompt on stdin and the run named in its environment:
 * MEMORY_LAB_TASK, MEMORY_LAB_ARM (off or on), MEMORY_LAB_RUN, MEMORY_LAB_MODEL, MEMORY_LAB_OUT (a directory for its
 * session.jsonl) and, on the on arm, MEMORY_LAB_PLUGIN (a copy of the plugin without the lab). MEMORY_DATA_DIR is a
 * new directory per run: empty on the off arm, and on the on arm consented and holding the task's memory, so no run
 * reads or writes the owner's store. Its stdout is read as Claude Code's stream-json; its session.jsonl as the
 * session transcript Claude Code keeps. The lab itself calls no model: it runs only the command it is given.
 */
export const LAB: Measure = { measure: 'session-lab', on: ['memory plugin'], bar: 'pass rate with memory on no lower than off' };
export const RUNS = 3;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TASKS = join(ROOT, 'lab', 'tasks');
const BUNDLE = join(ROOT, 'dist', 'memory.mjs');
/** What the on arm's agent may load: the plugin, without the lab's tasks and hidden tests. */
const PLUGIN_PARTS = ['.claude-plugin', 'hooks', 'dist', 'skills', 'types'];
const RUN_TIMEOUT_MS = 30 * 60_000;
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com' };

interface Task {
  prompt: string;
  memory: { scope: string; type: string; statement: string; anchor?: string }[];
}

interface Run {
  agentFailed: boolean;
  passed: boolean;
  usage: { input: number; cacheRead: number; turns: number } | null;
  hooks: { event: string; ms: number }[];
  injected: { items: number; tokens: number };
}

export const labTasks = (): string[] => readdirSync(TASKS).filter((t) => existsSync(join(TASKS, t, 'task.json'))).sort();

/** The process environment without the variables that would point git at another repository. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const k of REPOSITORY_VARIABLES) delete env[k];
  return env;
}

function check(what: string, r: ReturnType<typeof spawnSync>): void {
  if (r.status !== 0) throw new Error(`the lab could not ${what}: ${String(r.stderr ?? r.error ?? '').trim()}`);
}

/** The run's repository: the task's files committed once, with a github.com origin of a made-up owner. */
function fixtureRepository(task: string, repo: string): void {
  cpSync(join(TASKS, task, 'repo'), repo, { recursive: true });
  const env = cleanEnv(GIT_ENV);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', task], ['remote', 'add', 'origin', 'https://github.com/acme/lab.git']]) {
    check(`set up ${task}'s repository`, spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }));
  }
}

/** The on arm's store: consented for the agent's Claude Code config, holding the task's items, made by memory's own commands. */
function seed(task: string, t: Task, repo: string, data: string): void {
  const memory = (args: string[]) =>
    check(`seed ${task}'s memory`, spawnSync(process.execPath, [BUNDLE, ...args], { cwd: repo, env: cleanEnv({ MEMORY_DATA_DIR: data }), encoding: 'utf8' }));
  memory(['init', '--tenant', 'lab=acme/*', '--bind', 'lab', '--confirm']);
  for (const m of t.memory) memory(['remember', '--scope', m.scope, '--type', m.type, ...(m.anchor === undefined ? [] : ['--anchor', m.anchor]), '--', m.statement]);
}

const jsonLines = (text: string): Record<string, unknown>[] =>
  text.split('\n').flatMap((l) => {
    try {
      const v = JSON.parse(l) as unknown;
      return typeof v === 'object' && v !== null ? [v as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
const readLines = (file: string) => (existsSync(file) ? jsonLines(readFileSync(file, 'utf8')) : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Tokens and turns from the stream's result line: modelUsage covers every model the session used, subagents' too. */
function usage(events: Record<string, unknown>[]): Run['usage'] {
  const result = events.findLast((e) => e.type === 'result');
  const models = result?.modelUsage;
  if (typeof models !== 'object' || models === null) return null;
  const all = Object.values(models as Record<string, Record<string, unknown>>);
  return {
    input: all.reduce((s, m) => s + num(m?.inputTokens), 0),
    cacheRead: all.reduce((s, m) => s + num(m?.cacheReadInputTokens), 0),
    turns: num(result!.num_turns),
  };
}

function runOnce(task: string, t: Task, arm: 'off' | 'on', n: number, agent: string, model: string, plugin: string, base: string): Run {
  const dir = mkdtempSync(join(base, 'run-'));
  const repo = join(dir, 'repo');
  const data = join(dir, 'data');
  const out = join(dir, 'out');
  mkdirSync(data);
  mkdirSync(out);
  fixtureRepository(task, repo);
  if (arm === 'on') seed(task, t, repo, data);
  const env = cleanEnv({
    MEMORY_DATA_DIR: data, MEMORY_LAB_TASK: task, MEMORY_LAB_ARM: arm, MEMORY_LAB_RUN: String(n), MEMORY_LAB_MODEL: model, MEMORY_LAB_OUT: out,
  });
  if (arm === 'on') env['MEMORY_LAB_PLUGIN'] = plugin;
  else delete env['MEMORY_LAB_PLUGIN'];
  const r = spawnSync('/bin/sh', ['-c', agent], {
    cwd: repo, env, input: t.prompt, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'],
  });
  // An agent that exits without reading its prompt leaves EPIPE on stdin; its exit status still decides.
  const agentFailed = (r.error !== undefined && (r.error as NodeJS.ErrnoException).code !== 'EPIPE') || r.status !== 0;
  const hidden = join(TASKS, task, 'hidden');
  const tests = readdirSync(hidden).filter((f) => f.endsWith('.test.mjs')).map((f) => join(hidden, f));
  // The hidden tests never enter the agent's directory; they read the copy it left through LAB_REPO.
  const grade = agentFailed ? null : spawnSync(process.execPath, ['--test', ...tests], { cwd: repo, env: { PATH: process.env['PATH'] ?? '', LAB_REPO: repo }, stdio: 'ignore', timeout: 120_000 });
  const injected = readLines(injectionLog(data)).filter((e) => e.event === 'injected');
  return {
    agentFailed,
    passed: grade?.status === 0,
    usage: agentFailed ? null : usage(jsonLines(r.stdout ?? '')),
    // Memory's own hooks only: Claude Code times every hook the session ran.
    hooks: readLines(join(out, 'session.jsonl')).flatMap((e) => {
      const a = e.attachment as Record<string, unknown> | undefined;
      return typeof a?.hookEvent === 'string' && typeof a.durationMs === 'number' && String(a.command ?? '').includes('memory.mjs')
        ? [{ event: a.hookEvent, ms: a.durationMs }]
        : [];
    }),
    injected: { items: injected.length, tokens: injected.reduce((s, e) => s + num(e.tokens), 0) },
  };
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));

/** Per hook event: how many ran, and the 95th percentile of their durations by nearest rank. */
function hookMs(runs: Run[]): Record<string, { count: number; p95: number }> {
  const by = new Map<string, number[]>();
  for (const h of runs.flatMap((r) => r.hooks)) by.set(h.event, [...(by.get(h.event) ?? []), h.ms]);
  return Object.fromEntries([...by.keys()].sort().map((event) => {
    const ms = by.get(event)!.sort((a, b) => a - b);
    return [event, { count: ms.length, p95: ms[Math.ceil(0.95 * ms.length) - 1]! }];
  }));
}

function figures(runs: Run[]) {
  const used = runs.flatMap((r) => (r.usage === null ? [] : [r.usage]));
  return {
    samples: { runs: runs.length, agent_failed: runs.filter((r) => r.agentFailed).length },
    pass_rate: Math.round((runs.filter((r) => r.passed).length / runs.length) * 1000) / 1000,
    input_tokens: mean(used.map((u) => u.input)),
    cache_read_tokens: mean(used.map((u) => u.cacheRead)),
    turns: mean(used.map((u) => u.turns)),
    hook_ms: hookMs(runs),
    injected: { items: runs.reduce((s, r) => s + r.injected.items, 0), tokens: runs.reduce((s, r) => s + r.injected.tokens, 0) },
  };
}

/** Every task, or only `only`, off then on, RUNS times each; two rows per task. */
export function lab(version: string, agent: string, model: string, only?: string): Row[] {
  const base = mkdtempSync(join(tmpdir(), 'memory-lab-'));
  try {
    const plugin = join(base, 'plugin');
    for (const part of PLUGIN_PARTS) if (existsSync(join(ROOT, part))) cpSync(join(ROOT, part), join(plugin, part), { recursive: true });
    return (only === undefined ? labTasks() : [only]).flatMap((task) => {
      const t = JSON.parse(readFileSync(join(TASKS, task, 'task.json'), 'utf8')) as Task;
      const arms = (['off', 'on'] as const).map((arm) => figures(Array.from({ length: RUNS }, (_, i) => runOnce(task, t, arm, i + 1, agent, model, plugin, base))));
      const [off, on] = arms as [ReturnType<typeof figures>, ReturnType<typeof figures>];
      return [
        row(version, LAB, 'off', 'measured', { task, model, ...off }),
        // A run that failed to start counts as failed, but the bar is not judged on it: a lab whose agent never ran,
        // or whose off arm lost runs, would otherwise show memory no worse.
        on.samples.agent_failed + off.samples.agent_failed > 0
          ? row(version, LAB, 'on', 'measured', { task, model, ...on, meets_bar: null, note: 'a run failed to start, so the bar is not judged; run the lab again' })
          : row(version, LAB, 'on', 'measured', { task, model, ...on, meets_bar: on.pass_rate >= off.pass_rate }),
      ];
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Scorecard rows, one JSON object per line, as `memory eval` prints them; an error names the line that is not one. */
export function parseRows(text: string): Row[] {
  return text.split('\n').flatMap((line, i) => {
    if (line.trim() === '') return [];
    let r: Partial<Row> | null = null;
    try {
      r = JSON.parse(line) as Partial<Row>;
    } catch {
      // Reported below.
    }
    if (typeof r?.measure !== 'string' || typeof r.arm !== 'string' || typeof r.status !== 'string') throw new Error(`line ${i + 1} is not a scorecard row`);
    return [r as Row];
  });
}

/**
 * FR-004 of #6: auto memory may be switched off only when slice 5's scorecard and the lab each show memory no worse:
 * at least one measured row that holds its bar, and none that misses it. A row not run shows nothing either way.
 * It only prints; the owner changes the setting.
 */
export function verdict(scorecard: Row[], labRows: Row[], configDir: string): string {
  for (const [name, rows] of [
    ['the scorecard', scorecard.filter((r) => r.measure !== LAB.measure)],
    ['the lab', labRows.filter((r) => r.measure === LAB.measure)],
  ] as const) {
    const missed = rows.find((r) => r.status === 'measured' && r.meets_bar === false);
    if (missed !== undefined) {
      return `auto memory stays on: ${missed.measure}${typeof missed.task === 'string' ? ` ${missed.task}` : ''} (${missed.arm} arm) does not hold its bar, ${missed.bar}`;
    }
    if (!rows.some((r) => r.status === 'measured' && r.meets_bar === true)) return `auto memory stays on: ${name} holds no measured row that meets its bar`;
  }
  return `auto memory may be switched off in ${configDir}`;
}
