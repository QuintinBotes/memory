import { DatabaseSync } from 'node:sqlite';
import { posix } from 'node:path';
import type { Trust } from '../items.ts';
import { authorityViolations } from '../authority.ts';
import { MAX_STATEMENT } from '../gate.ts';
import { inside } from './silos.ts';

/**
 * Review Voice's decisions about its own findings, read from its store and never written. The store is opened
 * read-only, so memory adds no second sync of GitHub and cannot change what Review Voice knows.
 */
export interface Decision {
  /** `owner/repo` the review ran on. */
  repository: string;
  /** What the decision is quoted from: the pull request link, or the run and finding when the run had none. */
  source: string;
  statement: string;
  /** The finding's directory, as an anchor: the decision holds for its siblings. */
  anchorPath: string;
  trust: Trust;
}

interface Run {
  review_run_id: string;
  repository: string | null;
  pull_number: number | null;
  output_json: string;
}
interface Found {
  path: string;
  text: string;
}

/**
 * A decision's statement within the gate's limit (#120): a finding may run to 40 words, and with its prefix pass it.
 * Cut between words, with an ellipsis; the evidence's source points to the whole finding.
 */
function fit(statement: string): string {
  if (statement.length <= MAX_STATEMENT) return statement;
  const room = statement.slice(0, MAX_STATEMENT - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}…`;
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** The owner's decisions that mean something to another reviewer: what was kept, declined or reworded. */
const OWNER_STATEMENTS: Record<string, (text: string, replacement: string | null) => string | null> = {
  keep: (text) => `Owner kept this finding: ${text}`,
  dismiss: (text) => `Owner declined this finding: ${text}`,
  never_flag: (text) => `Owner declined this finding: ${text}`,
  rewrite: (_text, replacement) => (replacement === null ? null : `Owner reworded a finding to: ${replacement}`),
};

/**
 * Every owner decision in the store at `path`, then each strong dismissal someone else made that no owner row covers,
 * with team trust. A store of another shape reads as the reason it cannot be read.
 */
export function reviewVoiceDecisions(path: string): { decisions: Decision[]; unreadable: string[] } | { reason: string } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    return { reason: `cannot be opened (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  try {
    const runs = db.prepare('SELECT review_run_id, repository, pull_number, output_json FROM review_runs ORDER BY created_at, review_run_id').all() as unknown as Run[];
    const feedback = db.prepare('SELECT review_run_id, finding_id, action, replacement_text FROM feedback ORDER BY created_at, feedback_id').all() as unknown as {
      review_run_id: string; finding_id: string; action: string; replacement_text: string | null;
    }[];
    const outcomes = db
      .prepare("SELECT review_run_id, finding_id, decided_by FROM finding_outcomes WHERE outcome = 'dismissed' AND strength = 'strong' ORDER BY review_run_id, finding_id")
      .all() as unknown as { review_run_id: string; finding_id: string; decided_by: string | null }[];

    const unreadable: string[] = [];
    const byRun = new Map<string, { run: Run; findings: Map<string, Found> }>();
    for (const run of runs) {
      try {
        const parsed = JSON.parse(run.output_json) as { findings?: { findingId?: unknown; path?: unknown; text?: unknown }[] };
        const findings = new Map<string, Found>();
        for (const f of parsed.findings ?? []) {
          if (typeof f.findingId === 'string' && typeof f.path === 'string' && typeof f.text === 'string' && f.text.trim() !== '') findings.set(f.findingId, { path: f.path, text: f.text.trim() });
        }
        byRun.set(run.review_run_id, { run, findings });
      } catch {
        unreadable.push(`review run ${run.review_run_id}: the output is not JSON`);
      }
    }

    const decisions: Decision[] = [];
    const decided = new Set<string>();
    const add = (runId: string, findingId: string, trust: Trust, say: (text: string) => string | null): void => {
      const known = byRun.get(runId);
      const found = known?.findings.get(findingId);
      const { repository, pull_number: pull } = known?.run ?? {};
      if (found === undefined || repository == null || !REPOSITORY.test(repository)) return;
      if (!inside(found.path) || found.path.includes('\\')) return;
      const said = say(found.text);
      if (said === null) return;
      const statement = fit(said);
      const dir = posix.dirname(found.path);
      decisions.push({
        repository: repository.toLowerCase(),
        source: pull == null ? `review-voice ${runId}:${findingId}` : `https://github.com/${repository}/pull/${pull}`,
        statement,
        // A file at the root has no directory to stand for: its own path is the anchor.
        anchorPath: dir === '.' ? found.path : dir,
        // The decision is the owner's; the finding text was written by a model from the pull request, so text that reads as an instruction is not.
        trust: trust === 'owner' && authorityViolations(found.text).length > 0 ? 'agent' : trust,
      });
    };
    for (const f of feedback) {
      decided.add(`${f.review_run_id}\n${f.finding_id}`);
      const statement = OWNER_STATEMENTS[f.action];
      if (statement !== undefined) add(f.review_run_id, f.finding_id, 'owner', (text) => statement(text, f.replacement_text?.trim() || null));
    }
    for (const o of outcomes) {
      if (!decided.has(`${o.review_run_id}\n${o.finding_id}`)) add(o.review_run_id, o.finding_id, o.decided_by == null ? 'agent' : 'team', (text) => `Declined in review by ${o.decided_by == null ? 'someone unnamed' : 'a team member'}: ${text}`);
    }
    return { decisions, unreadable };
  } catch (error) {
    return { reason: `is not a Review Voice store this version reads (${(error as Error).message})` };
  } finally {
    db.close();
  }
}
