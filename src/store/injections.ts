import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import type { Withheld } from '../instructions.ts';
import { estimate, row } from '../slice.ts';
import { withFileLock } from './refresh-lock.ts';
import { injectionLog } from './paths.ts';

/** How long a hook waits for the injection log's lock. */
export const LOG_LOCK_HOOK_MS = 2000;
export const injectionLock = (data: string): string => `${injectionLog(data)}.lock`;

/** One write per slice, under the log's lock, so lines from parallel subagents do not interleave and a purge's rewrite never drops one. */
export function appendInjections(data: string, lines: string[]): void {
  const file = injectionLog(data);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  withFileLock(injectionLock(data), () => appendFileSync(file, lines.join(''), { mode: 0o600 }), LOG_LOCK_HOOK_MS);
}

/** Items an instruction file kept out of a recall, by id and the tokens that saved, never their text. Silent on any failure. */
export function logWithheld(data: string, config: Config, via: string, session: string, withheld: Withheld[], agent?: string): void {
  if (withheld.length === 0 || !covers(config, 'injections')) return;
  try {
    appendInjections(
      data,
      withheld.map((w) => `${JSON.stringify({ event: 'withheld', reason: w.reason, session, ...(agent === undefined ? {} : { agent }), item: w.item.id, via, tokens: estimate(row(w.item)), at: new Date().toISOString() })}\n`),
    );
  } catch {
    // A busy log costs the count, never the recall.
  }
}
