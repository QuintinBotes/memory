import { recheck } from '../anchors.ts';
import { managedBy } from '../anchors/refresh.ts';
import { withRefreshLock } from '../store/refresh-lock.ts';
import { narrowerWins } from '../consolidate.ts';
import type { Context, Reach } from '../context.ts';
import { allTenantItems, personItems, tenantItems, textMatches, type Visible } from '../items.ts';
import { openStore, WRITE_BUSY_MS } from '../store/db.ts';
import { personFile, tenantFile } from '../store/paths.ts';
import { currentConfigDir } from '../config.ts';
import { loadInstructions, screen, type Withheld } from '../instructions.ts';

/** `items` of one file, each that matched carrying its text ratio: bm25 depends on the file's own word counts, so a match is measured against the best in its file. */
export function withTextRatio(items: Visible[], matches: Map<string, number>): Visible[] {
  const best = Math.min(0, ...items.map((i) => matches.get(i.id) ?? 0));
  return items.map((item) => {
    const bm25 = matches.get(item.id);
    return bm25 === undefined || best === 0 ? item : { ...item, textRatio: bm25 / best };
  });
}

/**
 * Active items this process may show here: the bound tenant's, then the person
 * file's. Anchored items are re-checked against HEAD first, so an item whose
 * citation is gone is never shown. With search `terms`, each item that matches
 * them carries its text ratio. A hook passes a short `busyMs`, so a busy store costs it a fraction of a second, never a tool call.
 * Items the loaded instruction files repeat or contradict are left out and pushed to `withheld` (#26, #40); null reads no
 * instruction file and withholds nothing, as `memory list` does.
 *
 * `reach`, already checked by `filterRepository`, widens or moves the read inside the bound tenant's own file and the person
 * file, and nowhere else: a repository names rows, never a file. For another repository the person file gives only its items
 * learned there; `all` gives the whole tenant file and the whole person file. Anchors of another repository cannot be
 * checked against this checkout, and this checkout's instruction files say nothing about it, so neither runs for it.
 */
export function visibleItems(data: string, context: Context, cwd: string, terms: readonly string[] = [], busyMs = WRITE_BUSY_MS, withheld: Withheld[] | null = [], reach?: Reach): Visible[] {
  const out: Visible[] = [];
  const other = reach !== undefined && reach !== 'all' && reach.repository !== context.repository;
  const instructions = withheld === null || other ? null : loadInstructions(cwd, currentConfigDir());
  const add = (items: Visible[], matches: Map<string, number>): void => void out.push(...withTextRatio(items, matches));
  if (context.tenant !== null && context.repository !== null && context.owner !== null) {
    const file = tenantFile(data, context.tenant);
    const db = openStore(file, false, busyMs);
    if (db !== null) {
      try {
        // A refresh already running elsewhere does the work; this hook goes on without waiting for it.
        if (!other) withRefreshLock(file, () => recheck(db, context.tenant!, context.repository!, cwd, { managed: managedBy(data, context.repository) }));
        const named = reach !== undefined && reach !== 'all' ? reach.repository : undefined;
        const items = reach === 'all' ? allTenantItems(db, context.tenant) : tenantItems(db, context.tenant, named ?? context.repository, named === undefined ? context.owner : named.split('/')[0]!);
        add(instructions === null ? items : screen(db, items, instructions, false, withheld!), textMatches(db, terms));
      } finally {
        db.close();
      }
    }
  }
  const person = openStore(personFile(data), false, busyMs);
  if (person !== null) {
    try {
      const items = personItems(person, reach !== undefined && reach !== 'all' ? reach.repository : undefined);
      add(instructions === null ? items : screen(person, items, instructions, true, withheld!), textMatches(person, terms));
    } finally {
      person.close();
    }
  }
  return narrowerWins(out);
}
