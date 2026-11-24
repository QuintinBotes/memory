import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inside } from './silos.ts';

/**
 * Orbit's validated lessons, contradictions and run-end observations, read from its knowledge store
 * (`.orbit/knowledge.sqlite`, schema migration 2 or later) and never written: the store is opened read-only.
 * A lesson of the global graph (scope `global`) came from any repository, so only repository lessons are read.
 */
export interface OrbitFinding {
  /** `lesson` or `observation`. */
  kind: 'lesson' | 'observation' | 'repair';
  statement: string;
  type: string;
  /** The run the finding rests on: its newest supporting run for a lesson. */
  run: string;
  /** When that run supported it, so a lesson nobody used for a while can be left out of prompts. */
  at: string;
  anchorPath: string | null;
  fingerprints: string[];
  checks: string[];
  /** Distinct runs that contradicted the lesson. */
  contradictions: number;
  /** For a repair (#18): the evidence source it carries, naming both runs and the `passed-after:` marker. */
  evidence?: string;
}

/** The states of a run that ended without a failure; any other state is a failed run. */
const PASSED = /^(?:passed|succeeded|success|completed|done)$/i;

const TYPES: Record<string, string> = { practice: 'convention', convention: 'convention', hazard: 'hazard', 'failure-pattern': 'failure-pattern', 'repair-recipe': 'repair-recipe' };
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/** The findings in the store at `path`, or why it cannot be read. */
export function orbitFindings(path: string): { findings: OrbitFinding[]; unreadable: string[] } | { reason: string } {
  // Opening a WAL store, even read-only, creates -shm and -wal files beside it, and ignoring the WAL misses lessons
  // not yet checkpointed. So a copy of the file and its WAL is opened in a temporary directory, and removed after.
  let dir: string | undefined;
  let db: DatabaseSync;
  try {
    dir = mkdtempSync(join(tmpdir(), 'memory-orbit-'));
    const copy = join(dir, 'knowledge.sqlite');
    copyFileSync(path, copy);
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    db = new DatabaseSync(copy);
  } catch (error) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    return { reason: `cannot be opened (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  try {
    const nodes = db.prepare("SELECT id, lesson_json, created_at FROM nodes WHERE status = 'validated' AND scope = 'repo' AND stale_reason IS NULL ORDER BY id").all() as unknown as { id: string; lesson_json: string; created_at: number }[];
    const edges = db.prepare("SELECT src, type, run_id, created_at FROM edges WHERE type IN ('SUPPORTED_BY', 'CONTRADICTED_BY') AND run_id IS NOT NULL ORDER BY src, created_at, run_id").all() as unknown as {
      src: string; type: string; run_id: string; created_at: number;
    }[];
    const observations = db.prepare('SELECT run_id, state, failure_class, data_json, created_at FROM observations ORDER BY created_at, id').all() as unknown as {
      run_id: string; state: string; failure_class: string | null; data_json: string; created_at: number;
    }[];

    const findings: OrbitFinding[] = [];
    const unreadable: string[] = [];
    for (const n of nodes) {
      try {
        const lesson = JSON.parse(n.lesson_json) as {
          kind?: string; statement?: unknown; citation?: { run_id?: unknown; path?: unknown } | null; applicability?: { fingerprints?: unknown; check_ids?: unknown };
        };
        const mine = edges.filter((e) => e.src === n.id);
        const support = mine.filter((e) => e.type === 'SUPPORTED_BY').at(-1);
        const run = support?.run_id ?? (typeof lesson.citation?.run_id === 'string' ? lesson.citation.run_id : null);
        if (typeof lesson.statement !== 'string' || lesson.statement.trim() === '' || run === null) {
          unreadable.push(`lesson ${n.id}: no statement or no run`);
          continue;
        }
        const cited = lesson.citation?.path;
        findings.push({
          kind: 'lesson',
          statement: lesson.statement.trim(),
          type: TYPES[lesson.kind ?? ''] ?? 'failure-pattern',
          run,
          // Orbit's own last support: the newest supporting run, or the lesson's creation.
          at: new Date(Math.max(n.created_at, support?.created_at ?? 0)).toISOString(),
          anchorPath: typeof cited === 'string' && inside(cited) && !cited.includes('\\') ? cited : null,
          fingerprints: strings(lesson.applicability?.fingerprints),
          checks: strings(lesson.applicability?.check_ids),
          contradictions: new Set(mine.filter((e) => e.type === 'CONTRADICTED_BY').map((e) => e.run_id)).size,
        });
      } catch {
        unreadable.push(`lesson ${n.id}: not JSON`);
      }
    }
    // The latest failing run of each check, until a later run of that check passes: that pair is a repair (#18).
    const failing = new Map<string, { run: string; fingerprint: string }>();
    for (const o of observations) {
      try {
        const { checks } = JSON.parse(o.data_json) as { checks?: { check_id?: unknown; signature?: unknown }[] };
        for (const c of checks ?? []) {
          if (typeof c.check_id !== 'string') continue;
          if (PASSED.test(o.state)) {
            const failed = failing.get(c.check_id);
            if (failed === undefined) continue;
            failing.delete(c.check_id);
            findings.push({
              kind: 'repair',
              statement: `check ${c.check_id} failing with ${failed.fingerprint} => a later Orbit run passed the check (run ${o.run_id} after run ${failed.run})`,
              type: 'repair-recipe',
              run: o.run_id,
              at: new Date(o.created_at).toISOString(),
              anchorPath: null,
              fingerprints: [failed.fingerprint],
              checks: [c.check_id],
              contradictions: 0,
              evidence: `orbit failed-run:${failed.run} passed-run:${o.run_id} passed-after:${o.run_id}`,
            });
            continue;
          }
          if (typeof c.signature !== 'string' || c.signature === '') continue;
          failing.set(c.check_id, { run: o.run_id, fingerprint: c.signature });
          findings.push({
            kind: 'observation',
            statement: `A run that ended ${o.state}${o.failure_class === null ? '' : ` (${o.failure_class})`} failed check ${c.check_id} with ${c.signature}`,
            type: 'failure-pattern',
            run: o.run_id,
            at: new Date(o.created_at).toISOString(),
            anchorPath: null,
            fingerprints: [c.signature],
            checks: [c.check_id],
            contradictions: 0,
          });
        }
      } catch {
        unreadable.push(`observation of run ${o.run_id}: not JSON`);
      }
    }
    return { findings, unreadable };
  } catch (error) {
    return { reason: `is not an Orbit knowledge store this version reads (${(error as Error).message})` };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
