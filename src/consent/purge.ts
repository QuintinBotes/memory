// Adapted from Review Voice, plugins/review-voice/src/consent/purge.ts at 707ba60
// (https://github.com/QuintinBotes/review-voice, MIT).
import type { DatabaseSync } from 'node:sqlite';
import { recordAudit } from '../store/audit.ts';

export interface PurgeScope {
  tenant?: string | undefined;
  repository?: string | undefined;
  /** Evidence captured before this ISO time is deleted; computed once, so preview and delete agree. */
  before?: string | undefined;
  all?: boolean | undefined;
}

export interface PurgePreview {
  items: number;
  evidence: number;
  /** Items left with no evidence, which return to proposed instead of being deleted. */
  returnedToProposed: number;
}

const count = (db: DatabaseSync, sql: string, ...params: string[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/** Items deleted outright by this scope, as a WHERE clause on `items`. */
function itemClause(scope: PurgeScope): { where: string; params: string[] } {
  if (scope.all === true || scope.tenant !== undefined) return { where: '1=1', params: [] };
  if (scope.repository !== undefined) return { where: "scope = 'repository' AND scope_key = ?", params: [scope.repository] };
  return { where: '1=0', params: [] };
}

/**
 * Counts what a purge would remove, so the user sees the damage before
 * agreeing to it rather than after.
 */
export function previewPurge(db: DatabaseSync, scope: PurgeScope): PurgePreview {
  const { where, params } = itemClause(scope);
  const items = count(db, `SELECT COUNT(*) AS n FROM items WHERE ${where}`, ...params);
  let evidence = count(db, `SELECT COUNT(*) AS n FROM evidence WHERE item_id IN (SELECT id FROM items WHERE ${where})`, ...params);
  let returnedToProposed = 0;
  const before = scope.before;
  if (before !== undefined) {
    evidence = count(db, 'SELECT COUNT(*) AS n FROM evidence WHERE captured_at < ?', before);
    returnedToProposed = count(
      db,
      `SELECT COUNT(*) AS n FROM items i WHERE status NOT IN ('proposed', 'rejected')
         AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = i.id AND e.captured_at >= ?)`,
      before,
    );
  }
  return { items, evidence, returnedToProposed };
}

/**
 * Deletes in one transaction. Evidence goes with its item; an item that loses
 * all its evidence returns to `proposed`, because an item without evidence
 * must not be recalled.
 */
export function executePurge(db: DatabaseSync, scope: PurgeScope): PurgePreview {
  const preview = previewPurge(db, scope);
  const { where, params } = itemClause(scope);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM items WHERE ${where}`).run(...params);
    if (scope.before !== undefined) {
      db.prepare('DELETE FROM evidence WHERE captured_at < ?').run(scope.before);
      db.prepare(
        "UPDATE items SET status = 'proposed' WHERE status != 'rejected' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = items.id)",
      ).run();
    }
    // In the same transaction: a purge that cannot be audited does not happen.
    // The entry survives the purge it records.
    recordAudit(db, 'purge', null, { scope, removed: preview });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return preview;
}
