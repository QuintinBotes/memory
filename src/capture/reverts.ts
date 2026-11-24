import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../store/transaction.ts';

/** Reverts further back than this many commits are not read. */
const READ = 200;
const WEEK = 7 * 864e5;

export interface RevertScan {
  /** Reverts counted by this scan: each raised the contradictions of the items shown with the reverted commit. */
  counted: number;
  /** The newest pair of memory-linked reverts less than seven days apart, when this scan found one. */
  pair: [string, string] | null;
}

/**
 * Reads the revert commits of the repository at `cwd` (`This reverts commit <sha>`). A revert of a commit memory linked
 * items to (#18, FR-004) counts once as a contradiction of each of them, however many times it is scanned; one of an
 * unknown commit is not memory-linked and is ignored. Two linked reverts less than seven days apart (by commit date)
 * make a pair (FR-005). Under the write lock only when there is something to count.
 */
export function scanReverts(db: DatabaseSync, cwd: string): RevertScan {
  let log: string;
  try {
    log = execFileSync('git', ['log', '-n', String(READ), '--format=%H%x1f%cI%x1f%B%x1e'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return { counted: 0, pair: null };
  }
  const found: { sha: string; at: string; reverted: string }[] = [];
  for (const entry of log.split('\x1e')) {
    const [sha = '', at = '', body = ''] = entry.trim().split('\x1f');
    const reverted = /This reverts commit ([0-9a-f]{7,40})/.exec(body)?.[1];
    if (sha !== '' && reverted !== undefined && db.prepare('SELECT 1 FROM reverts WHERE revert_sha = ?').get(sha) === undefined) found.push({ sha, at: Number.isNaN(Date.parse(at)) ? new Date().toISOString() : new Date(at).toISOString(), reverted });
  }
  const linked = found.filter((f) => db.prepare("SELECT 1 FROM commit_items WHERE commit_sha LIKE ? || '%' LIMIT 1").get(f.reverted) !== undefined);
  if (linked.length === 0) return { counted: 0, pair: null };
  inTransaction(db, () => {
    for (const f of linked.sort((a, b) => a.at.localeCompare(b.at))) {
      const rows = db.prepare("SELECT DISTINCT item_id FROM commit_items WHERE commit_sha LIKE ? || '%'").all(f.reverted) as { item_id: string }[];
      for (const r of rows) db.prepare('UPDATE items SET contradictions = contradictions + 1 WHERE id = ?').run(r.item_id);
      db.prepare('INSERT OR IGNORE INTO reverts (revert_sha, reverted_sha, at, seen_at) VALUES (?, ?, ?, ?)').run(f.sha, f.reverted, f.at, new Date().toISOString());
    }
  });
  const all = db.prepare('SELECT revert_sha, at FROM reverts ORDER BY at, revert_sha').all() as { revert_sha: string; at: string }[];
  let pair: [string, string] | null = null;
  const fresh = new Set(linked.map((f) => f.sha));
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1]!;
    const b = all[i]!;
    if (Date.parse(b.at) - Date.parse(a.at) < WEEK && (fresh.has(a.revert_sha) || fresh.has(b.revert_sha))) pair = [a.revert_sha, b.revert_sha];
  }
  return { counted: linked.length, pair };
}
