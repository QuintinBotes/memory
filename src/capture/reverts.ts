import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../store/transaction.ts';

/** Reverts further back than this many commits are not read. */
const READ = 200;
const WEEK = 7 * 864e5;

export interface RevertScan {
  /** Memory-linked reverts first seen by this scan. */
  counted: number;
  /** The newest pair of memory-linked reverts first seen less than seven days apart, when this scan found one. */
  pair: [string, string] | null;
}

/** A command that is a `git revert` invocation: first word git (after env assignments and -C <dir>), subcommand revert. */
export const isGitRevert = (command: string): boolean => /^\s*(?:[A-Za-z_]\w*=\S*\s+)*git\s+(?:-[Cc]\s+\S+\s+)*revert(?:\s|$)/.test(command);

/**
 * Reads the revert commits of the repository at `cwd`: a subject `Revert "..."` (git writes `Reapply "..."` for a revert of a revert), a body naming the sha (`This reverts
 * commit <sha>`), made by the local git user (the email of `git var GIT_AUTHOR_IDENT`), so a quoted line in someone else's commit message counts
 * for nothing. A revert of a commit memory linked items to (#18, FR-004) is recorded once, however often it is scanned.
 * A revert of a recorded revert cancels it. An item's contradictions then equal the sessions that made a commit that
 * is still reverted, so many reverts in one session add one, and a cancelled revert adds none. Two linked reverts first
 * seen less than seven days apart (by when memory saw them, which a commit date cannot forge) make a pair (FR-005).
 * The write lock is taken only when there is something to record.
 */
export function scanReverts(db: DatabaseSync, cwd: string): RevertScan {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  let log: string;
  let me: string;
  try {
    me = /<([^>]*)>/.exec(git('var', 'GIT_AUTHOR_IDENT'))?.[1] ?? '';
    log = git('log', '-n', String(READ), '--format=%H%x1f%ae%x1f%cI%x1f%B%x1e');
  } catch {
    return { counted: 0, pair: null };
  }
  if (me === '') return { counted: 0, pair: null };
  const found: { sha: string; at: string; reverted: string }[] = [];
  // git log is newest first; a revert is handled after the commit it reverts.
  for (const entry of log.split('\x1e').reverse()) {
    const [sha = '', email = '', at = '', body = ''] = entry.trim().split('\x1f');
    const reverted = /^(?:Revert|Reapply) ".*"\s*\n[^]*?\bThis reverts commit ([0-9a-f]{7,40})/.exec(body)?.[1];
    if (sha === '' || reverted === undefined || email !== me) continue;
    if (db.prepare('SELECT 1 FROM reverts WHERE revert_sha = ?').get(sha) === undefined) found.push({ sha, at: Number.isNaN(Date.parse(at)) ? new Date().toISOString() : new Date(at).toISOString(), reverted });
  }
  const known = (reverted: string): boolean => db.prepare("SELECT 1 FROM commit_items WHERE commit_sha LIKE ? || '%' LIMIT 1").get(reverted) !== undefined;
  const recorded = (reverted: string): { revert_sha: string; reverted_sha: string; linked: number } | undefined =>
    db.prepare("SELECT revert_sha, reverted_sha, linked FROM reverts WHERE revert_sha LIKE ? || '%' AND cancelled_by IS NULL LIMIT 1").get(reverted) as { revert_sha: string; reverted_sha: string; linked: number } | undefined;
  if (!found.some((f) => known(f.reverted) || recorded(f.reverted) !== undefined || found.some((g) => g.sha.startsWith(f.reverted)))) return { counted: 0, pair: null };
  const fresh: string[] = [];
  inTransaction(db, () => {
    const seen = new Date().toISOString();
    for (const f of found) {
      const cancelled = recorded(f.reverted);
      if (cancelled !== undefined) {
        db.prepare('UPDATE reverts SET cancelled_by = ? WHERE revert_sha = ?').run(f.sha, cancelled.revert_sha);
        // Reverting a cancelling revert puts back what it had cancelled.
        if (cancelled.linked === 0) db.prepare("UPDATE reverts SET cancelled_by = NULL WHERE revert_sha LIKE ? || '%'").run(cancelled.reverted_sha);
        db.prepare('INSERT OR IGNORE INTO reverts (revert_sha, reverted_sha, at, seen_at, linked) VALUES (?, ?, ?, ?, 0)').run(f.sha, f.reverted, f.at, seen);
      } else if (known(f.reverted)) {
        db.prepare('INSERT OR IGNORE INTO reverts (revert_sha, reverted_sha, at, seen_at, linked) VALUES (?, ?, ?, ?, 1)').run(f.sha, f.reverted, f.at, seen);
        fresh.push(f.sha);
      }
    }
    // Each item's contradictions from reverts are the sessions that still have a reverted commit; raise or lower by the difference.
    const target = new Map((db.prepare(
      `SELECT ci.item_id AS id, COUNT(DISTINCT ci.session) AS n FROM reverts r JOIN commit_items ci ON ci.commit_sha LIKE r.reverted_sha || '%'
       WHERE r.linked = 1 AND r.cancelled_by IS NULL GROUP BY ci.item_id`,
    ).all() as { id: string; n: number }[]).map((r) => [r.id, r.n]));
    const applied = new Map((db.prepare('SELECT item_id AS id, applied FROM revert_counts').all() as { id: string; applied: number }[]).map((r) => [r.id, r.applied]));
    for (const id of new Set([...target.keys(), ...applied.keys()])) {
      const delta = (target.get(id) ?? 0) - (applied.get(id) ?? 0);
      if (delta === 0) continue;
      db.prepare('UPDATE items SET contradictions = MAX(0, contradictions + ?) WHERE id = ?').run(delta, id);
      db.prepare('INSERT INTO revert_counts (item_id, applied) VALUES (?, ?) ON CONFLICT (item_id) DO UPDATE SET applied = excluded.applied').run(id, target.get(id) ?? 0);
    }
  });
  const all = db.prepare('SELECT revert_sha, seen_at FROM reverts WHERE linked = 1 AND cancelled_by IS NULL ORDER BY seen_at, revert_sha').all() as { revert_sha: string; seen_at: string }[];
  let pair: [string, string] | null = null;
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1]!;
    const b = all[i]!;
    if (Date.parse(b.seen_at) - Date.parse(a.seen_at) < WEEK && (fresh.includes(a.revert_sha) || fresh.includes(b.revert_sha))) pair = [a.revert_sha, b.revert_sha];
  }
  return { counted: fresh.length, pair };
}
