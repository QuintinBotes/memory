import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { covers } from '../consent/plan.ts';
import type { Config } from '../config.ts';
import type { Context } from '../context.ts';

const RELATIONS = new Set(['caller', 'implementer', 'importer']);
const STATUSES = new Set(['changed', 'tested', 'neither']);

export interface Dependent {
  path: string;
  /** True when the change neither edits nor tests this dependent. */
  neither: boolean;
}

/** A provider that does not answer in this long counts as failed; recall must stay cheap. */
const PROVIDER_TIMEOUT_MS = 5000;
const MAX_DEPENDENTS = 1000;

/**
 * Asks the configured code anchor provider (D1 of #1) for the impact of a change. The request is one JSON line on stdin,
 * `{op: "impact", repository, range, changed: [path]}`; the answer is `{status: "no_snapshot"}` or `{status: "ok", dependents:
 * [{path, relation: caller|implementer|importer, status: changed|tested|neither, repository?, symbol?}]}`, depth 1.
 * A `changed` dependent is already among the changed paths and a dependent of another repository is dropped: items are kept
 * per repository. Null means no provider is configured; a `note` says why impact was not used, and recall goes on with path overlap.
 */
export function impact(config: Config, context: Context, cwd: string, range: string, changed: string[]): { dependents: Dependent[] } | { note: string } | null {
  if (config.impactProvider === undefined) return null;
  if (!covers(config, 'impact')) return { note: 'The impact provider was not run: agree to the current plan with memory init, then recall again. Path overlap only.' };
  const [program, ...args] = config.impactProvider.command as [string, ...string[]];
  // Only what a provider needs reaches it; the data directory and keys in the environment do not.
  const env = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' };
  const r = spawnSync(program, args, {
    cwd,
    env,
    input: `${JSON.stringify({ op: 'impact', repository: context.repository, range, changed })}\n`,
    encoding: 'utf8',
    timeout: PROVIDER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const failed = { note: 'The impact provider failed or answered unexpectedly. Path overlap only.' };
  if (r.error !== undefined || r.status !== 0) return failed;
  let answer: { status?: unknown; dependents?: unknown } | null;
  try {
    answer = JSON.parse(r.stdout) as typeof answer;
  } catch {
    return failed;
  }
  if (answer?.status === 'no_snapshot') return { note: 'No impact snapshot for this change yet. Path overlap only.' };
  if (answer?.status !== 'ok' || !Array.isArray(answer.dependents)) return failed;
  const dependents: Dependent[] = [];
  for (const d of answer.dependents.slice(0, MAX_DEPENDENTS) as Record<string, unknown>[]) {
    if (typeof d?.['path'] !== 'string' || !RELATIONS.has(d['relation'] as string) || !STATUSES.has(d['status'] as string)) return failed;
    const repository = d['repository'];
    if (repository !== undefined && (typeof repository !== 'string' || repository.toLowerCase() !== context.repository)) continue;
    const path = posix.normalize(d['path']);
    if (d['status'] === 'changed' || path.startsWith('/') || path.split('/').includes('..')) continue;
    dependents.push({ path, neither: d['status'] === 'neither' });
  }
  return { dependents };
}
