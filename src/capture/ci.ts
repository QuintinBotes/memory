import { execFileSync } from 'node:child_process';
import { currentConfigDir, type Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { resolveContext } from '../context.ts';
import { openStore } from '../store/db.ts';
import { tenantFile } from '../store/paths.ts';
import { committerNames, proposeRepair, scrubFailure, signatureOf } from './failures.ts';

interface Run {
  databaseId: number;
  conclusion: string;
  headSha: string;
  headBranch: string;
  workflowName: string;
  createdAt: string;
}

const gh = (cwd: string, ...args: string[]): string =>
  execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

/** `gh run view --log-failed` lines are `job<TAB>step<TAB>text`; the text is what a local command would have printed. */
const text = (log: string): string => log.split('\n').map((l) => (l.split('\t').length >= 3 ? l.split('\t').slice(2).join('\t') : l)).join('\n');

/** The last failed run before each passing run on a different commit, per workflow and branch (#18, FR-003). */
export function repairedRuns(runs: Run[]): { failed: Run; passed: Run }[] {
  const groups = new Map<string, Run[]>();
  for (const r of runs) groups.set(`${r.workflowName}\0${r.headBranch}`, [...(groups.get(`${r.workflowName}\0${r.headBranch}`) ?? []), r]);
  const pairs: { failed: Run; passed: Run }[] = [];
  for (const list of groups.values()) {
    let failed: Run | undefined;
    for (const r of list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.databaseId - b.databaseId)) {
      if (r.conclusion === 'failure') failed = r;
      else if (r.conclusion === 'success' && failed !== undefined && r.headSha !== failed.headSha) {
        pairs.push({ failed, passed: r });
        failed = undefined;
      }
    }
  }
  return pairs;
}

/**
 * `memory ci`: reads this repository's recent Actions runs with `gh run list`; for each failed run followed by a passing
 * run on another commit, reads the failed run's log with `gh run view --log-failed`, scrubs it, and proposes a repair
 * recipe whose evidence names the fingerprint, the fix commit and both runs. A failure with no later pass gives nothing.
 * Returns what it did, one line per proposal or skip.
 */
export function captureCi(data: string, config: Config, cwd: string, limit = 100): string[] {
  if (!covers(config, 'failures')) return ['your consent does not cover reading CI runs yet; run memory init and confirm'];
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null) return [`nothing captured: ${context.reason}`];
  const repo = { tenant: context.tenant, repository: context.repository };
  let runs: Run[];
  try {
    runs = JSON.parse(gh(cwd, 'run', 'list', '--json', 'databaseId,conclusion,headSha,headBranch,workflowName,createdAt', '--limit', String(limit))) as Run[];
  } catch (error) {
    return [`nothing captured: gh run list failed (${(error as { code?: string }).code ?? 'error'})`];
  }
  const pairs = repairedRuns(runs);
  if (pairs.length === 0) return ['no failed run was followed by a passing run on another commit'];
  const names = committerNames(cwd);
  const out: string[] = [];
  const db = openStore(tenantFile(data, repo.tenant), true)!;
  try {
    for (const { failed, passed } of pairs) {
      let log: string;
      try {
        log = gh(cwd, 'run', 'view', String(failed.databaseId), '--log-failed');
      } catch {
        out.push(`run ${failed.databaseId}: its log could not be read`);
        continue;
      }
      const { fingerprint, signature } = signatureOf(scrubFailure(text(log), names), null);
      if (signature === null) {
        out.push(`run ${failed.databaseId}: no line of its log names the failure well enough to recall it by`);
        continue;
      }
      if (!/^[0-9a-f]{7,40}$/.test(passed.headSha)) {
        out.push(`run ${passed.databaseId}: its commit is not a hash`);
        continue;
      }
      const fix = passed.headSha.slice(0, 7);
      // The workflow's name is free text from the repository: kept only when scrubbing leaves it as it was.
      const clean = scrubFailure(String(failed.workflowName), names);
      const flow = clean === failed.workflowName && /^[\w .-]{1,40}$/.test(clean) ? `the ${clean} run` : 'a CI run';
      const id = proposeRepair(db, repo, {
        signature, fingerprint, fix, how: `${flow} passed`,
        source: `ci failed-run:${failed.databaseId} passed-run:${passed.databaseId} fingerprint:${fingerprint} passed-after:${fix}`, evidenceAt: passed.createdAt,
      });
      out.push(id === null ? `run ${failed.databaseId}: the proposal was refused` : `run ${failed.databaseId} then ${passed.databaseId}: repair proposal ${id}`);
    }
  } finally {
    db.close();
  }
  return out;
}
