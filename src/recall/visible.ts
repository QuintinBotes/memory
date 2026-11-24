import { recheck } from '../anchors.ts';
import { withRefreshLock } from '../store/refresh-lock.ts';
import { narrowerWins } from '../consolidate.ts';
import type { Context } from '../context.ts';
import { personItems, tenantItems, textMatches, type Visible } from '../items.ts';
import { openStore, WRITE_BUSY_MS } from '../store/db.ts';
import { personFile, tenantFile } from '../store/paths.ts';

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
 */
export function visibleItems(data: string, context: Context, cwd: string, terms: readonly string[] = [], busyMs = WRITE_BUSY_MS): Visible[] {
  const out: Visible[] = [];
  const add = (items: Visible[], matches: Map<string, number>): void => void out.push(...withTextRatio(items, matches));
  if (context.tenant !== null && context.repository !== null && context.owner !== null) {
    const file = tenantFile(data, context.tenant);
    const db = openStore(file, false, busyMs);
    if (db !== null) {
      try {
        // A refresh already running elsewhere does the work; this hook goes on without waiting for it.
        withRefreshLock(file, () => recheck(db, context.tenant!, context.repository!, cwd));
        add(tenantItems(db, context.tenant, context.repository, context.owner), textMatches(db, terms));
      } finally {
        db.close();
      }
    }
  }
  const person = openStore(personFile(data), false, busyMs);
  if (person !== null) {
    try {
      add(personItems(person), textMatches(person, terms));
    } finally {
      person.close();
    }
  }
  return narrowerWins(out);
}
