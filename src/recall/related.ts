import { isAbsolute, normalize, relative } from 'node:path';
import { recheck } from '../anchors.ts';
import { managedBy } from '../anchors/refresh.ts';
import { DEFAULT_SESSION_BUDGET, currentConfigDir, type Config } from '../config.ts';
import { git, type Context } from '../context.ts';
import { loadInstructions, screen, type Withheld } from '../instructions.ts';
import { anchoredUnder } from '../items.ts';
import { chooseSlice } from '../slice.ts';
import { openStore } from '../store/db.ts';
import { withRefreshLock } from '../store/refresh-lock.ts';
import { tenantFile } from '../store/paths.ts';

/** A path or symbol key as the index holds it: relative to the repository root, no `..`, no trailing slash. Null when it cannot be one. */
export function relatedTarget(cwd: string, target: string): string | null {
  const top = isAbsolute(target) ? git(cwd, 'rev-parse', '--show-toplevel')?.trim() : undefined;
  const clean = normalize(isAbsolute(target) && top !== undefined ? relative(top, target) : target).replace(/\/+$/, '');
  return clean === '' || clean === '.' || isAbsolute(clean) || clean.split(/[\\/]/).includes('..') ? null : clean;
}

/**
 * The active items of this repository's tenant anchored at or under `target`, as whole rows within the session budget.
 * Read through the anchor-path index, after the same re-check of citations a recall makes, and with the same
 * withholding of lines an instruction file already says. `depth` limits the segments matched below the target.
 */
export function related(data: string, config: Config, context: Context, cwd: string, target: string, depth?: number): string {
  if (context.tenant === null || context.repository === null || context.owner === null) return '';
  const file = tenantFile(data, context.tenant);
  const db = openStore(file, false);
  if (db === null) return '';
  try {
    withRefreshLock(file, () => recheck(db, context.tenant!, context.repository!, cwd, { managed: managedBy(data) }));
    const found = anchoredUnder(db, context.tenant, context.repository, context.owner, target, depth);
    const items = screen(db, found, loadInstructions(cwd, currentConfigDir()), false, [] as Withheld[]);
    return chooseSlice(items, config.sessionBudget ?? DEFAULT_SESSION_BUDGET).text;
  } finally {
    db.close();
  }
}
