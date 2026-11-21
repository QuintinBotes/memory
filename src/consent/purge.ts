// Adapted from Review Voice, plugins/review-voice/src/consent/purge.ts at 707ba60
// (https://github.com/QuintinBotes/review-voice, MIT).
import type { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../items.ts';
import { recordAudit } from '../store/audit.ts';

export interface PurgeScope {
  tenant?: string | undefined;
  repository?: string | undefined;
  item?: string | undefined;
  /** Evidence from this source reference is deleted. */
  source?: string | undefined;
  /** With `source`: an item left without evidence is deleted instead of returning to proposed. */
  withDerived?: boolean | undefined;
  /** Evidence captured before this ISO time is deleted; computed once, so preview and delete agree. */
  before?: string | undefined;
  all?: boolean | undefined;
}

export interface PurgePreview {
  items: number;
  evidence: number;
  /** Items left with no evidence, which return to proposed instead of being deleted. */
  returnedToProposed: number;
  /** Promoted checks built from an item the purge deletes or takes evidence from, for the owner to review. */
  checks: string[];
}

interface Clause {
  where: string;
  params: string[];
}

const count = (db: DatabaseSync, sql: string, ...params: string[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/** Items deleted outright by this scope, as a WHERE clause on `items`. */
function itemClause(scope: PurgeScope): Clause {
  if (scope.all === true || scope.tenant !== undefined) return { where: '1=1', params: [] };
  if (scope.repository !== undefined) return { where: "scope = 'repository' AND scope_key = ?", params: [scope.repository] };
  if (scope.item !== undefined) return { where: 'id = ?', params: [scope.item] };
  return { where: '1=0', params: [] };
}

/** Evidence deleted by this scope on its own, as a WHERE clause on `evidence`, or null when it deletes only with items. */
function evidenceClause(scope: PurgeScope): Clause | null {
  if (scope.before !== undefined) return { where: 'captured_at < ?', params: [scope.before] };
  if (scope.source !== undefined) return { where: 'source_ref = ?', params: [scope.source] };
  return null;
}

/** On `items`: items with evidence the clause deletes, and of those, items it leaves with none. */
const touched = (e: Clause): Clause => ({ where: `id IN (SELECT item_id FROM evidence WHERE ${e.where})`, params: e.params });
const orphaned = (e: Clause): Clause => ({
  where: `${touched(e).where} AND NOT EXISTS (SELECT 1 FROM evidence k WHERE k.item_id = items.id AND NOT (${e.where}))`,
  params: [...e.params, ...e.params],
});
const SHOWN = "status IN ('active', 'stale')";

/**
 * Counts what a purge would remove, so the user sees the damage before
 * agreeing to it rather than after.
 */
export function previewPurge(db: DatabaseSync, scope: PurgeScope): PurgePreview {
  const i = itemClause(scope);
  const e = evidenceClause(scope);
  let items = count(db, `SELECT COUNT(*) AS n FROM items WHERE ${i.where}`, ...i.params);
  let evidence = count(db, `SELECT COUNT(*) AS n FROM evidence WHERE item_id IN (SELECT id FROM items WHERE ${i.where})`, ...i.params);
  let returnedToProposed = 0;
  let reached = i;
  if (e !== null) {
    const o = orphaned(e);
    evidence = count(db, `SELECT COUNT(*) AS n FROM evidence WHERE ${e.where}`, ...e.params);
    if (scope.withDerived === true) items = count(db, `SELECT COUNT(*) AS n FROM items WHERE ${o.where}`, ...o.params);
    else returnedToProposed = count(db, `SELECT COUNT(*) AS n FROM items WHERE ${SHOWN} AND ${o.where}`, ...o.params);
    reached = touched(e);
  }
  const checks = (
    db.prepare(`SELECT DISTINCT promoted_to AS c FROM items WHERE promoted_to IS NOT NULL AND ${reached.where} ORDER BY c`).all(...reached.params) as { c: string }[]
  ).map((r) => r.c);
  return { items, evidence, returnedToProposed, checks };
}

/**
 * Deletes in one transaction. Evidence goes with its item; an item that loses
 * all its evidence returns to `proposed`, because an item without evidence
 * must not be recalled, or with `withDerived` is deleted. Secure deletion
 * (see openStore) overwrites what is deleted, and the checkpoint leaves none of it in a write-ahead log.
 */
export function executePurge(db: DatabaseSync, scope: PurgeScope): PurgePreview {
  const preview = previewPurge(db, scope);
  const i = itemClause(scope);
  const e = evidenceClause(scope);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM items WHERE ${i.where}`).run(...i.params);
    if (e !== null) {
      const t = touched(e);
      const o = orphaned(e);
      db.prepare(
        `UPDATE items SET support = MAX(1, support - (SELECT COUNT(*) FROM evidence k WHERE k.item_id = items.id AND ${e.where})) WHERE ${t.where}`,
      ).run(...e.params, ...t.params);
      // Only an item that was shown goes back: a tombstone stays one.
      if (scope.withDerived === true) db.prepare(`DELETE FROM items WHERE ${o.where}`).run(...o.params);
      else db.prepare(`UPDATE items SET status = 'proposed' WHERE ${SHOWN} AND ${o.where}`).run(...o.params);
      db.prepare(`DELETE FROM evidence WHERE ${e.where}`).run(...e.params);
    }
    // In the same transaction: a purge that cannot be audited does not happen.
    // The entry survives the purge it records, and names a source only by its hash.
    const audited = scope.source === undefined ? scope : { ...scope, source: sha256(scope.source) };
    recordAudit(db, 'purge', null, { scope: audited, removed: preview });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return preview;
}
