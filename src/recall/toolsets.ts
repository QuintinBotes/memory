import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { personItems, sha256, textMatches } from '../items.ts';
import { ITEMS_LABEL, fence, leanRow } from '../render/rows.ts';
import { recordAudit } from '../store/audit.ts';
import { inTransaction } from '../store/transaction.ts';
import { rank, searchTerms } from './rank.ts';
import { withTextRatio } from './visible.ts';

export const OUTCOMES = ['accepted', 'rejected'] as const;
export type Outcome = (typeof OUTCOMES)[number];

interface Counts {
  accepted: number;
  rejected: number;
  cost: number;
}

/**
 * Records one run's outcome as evidence on an active toolset of the person file; an accepted one reinforces it, as
 * helped feedback does. False when `id` is no active toolset.
 */
export function recordOutcome(db: DatabaseSync, id: string, outcome: Outcome, cost: number, source: string): boolean {
  return inTransaction(db, () => {
    const item = db.prepare("SELECT statement FROM items WHERE id = ? AND type = 'toolset' AND status = 'active' AND valid_to IS NULL").get(id) as { statement: string } | undefined;
    if (item === undefined) return false;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor, outcome, cost)
       VALUES (?, ?, ?, 'owner', ?, ?, 'deterministic', ?, ?)`,
    ).run(`e-${randomBytes(5).toString('hex')}`, id, source, sha256(item.statement), now, outcome, cost);
    if (outcome === 'accepted') db.prepare('UPDATE items SET reinforced_at = ? WHERE id = ?').run(now, id);
    recordAudit(db, 'toolset_outcome', { type: 'item', id }, { outcome, cost });
    return true;
  });
}

/**
 * The active toolsets ranked against a task by the search's own sum, text measured against the best toolset only; equal
 * scores go to more accepted outcomes, then fewer rejected. Each row carries its outcome counts and total cost.
 */
export function routeToolsets(db: DatabaseSync, task: string): string {
  const toolsets = personItems(db).filter((i) => i.type === 'toolset');
  const counts = db.prepare(
    `SELECT count(*) FILTER (WHERE outcome = 'accepted') AS accepted, count(*) FILTER (WHERE outcome = 'rejected') AS rejected,
       coalesce(sum(cost), 0) AS cost FROM evidence WHERE item_id = ?`,
  );
  const hits = rank(withTextRatio(toolsets, textMatches(db, searchTerms(task))), [])
    .map((h) => ({ ...h, ...(counts.get(h.item.id) as unknown as Counts) }))
    .sort((a, b) => b.score - a.score || b.accepted - a.accepted || a.rejected - b.rejected);
  if (hits.length === 0) return '';
  return fence(ITEMS_LABEL, hits.map((h) => `${leanRow(h.item, h.why)} · accepted ${h.accepted} · rejected ${h.rejected} · cost ${h.cost}\n`).join(''));
}
