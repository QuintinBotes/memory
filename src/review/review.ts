import type { DatabaseSync } from 'node:sqlite';
import { oneLine } from '../slice.ts';
import { recordAudit } from '../store/audit.ts';

/**
 * The owner's review of proposals. Approve and reject are terminal commands
 * only; each records the owner's decision beside the shadow gate's, so the
 * gate can be judged after 50 decisions.
 */

export interface Proposal {
  id: string;
  scope: string;
  scope_key: string;
  type: string;
  statement: string;
  origin_trust: string;
  contradictions: number;
  anchors_json: string;
  evidence: { source_ref: string; author_role: string }[];
}

/** What an automatic gate would have done: three corroborating signals, one from the owner, no contradiction. */
export function shadow(p: Proposal): { decision: 'approve' | 'hold'; signals: number; owner: number } {
  const signals = new Set(p.evidence.map((e) => e.source_ref)).size;
  const owner = new Set(p.evidence.filter((e) => e.author_role === 'owner').map((e) => e.source_ref)).size;
  // shortcut: any contradiction holds, as no signal records yet whether the owner made it.
  return { decision: signals >= 3 && owner >= 1 && p.contradictions === 0 ? 'approve' : 'hold', signals, owner };
}

/**
 * Proposals in one store, of `tenant` ('' for the person file), oldest first;
 * or one by id. An item a purge left without evidence is not one: it must not
 * be recalled, so it cannot be approved.
 */
export function proposals(db: DatabaseSync, tenant: string, id?: string): Proposal[] {
  const rows = db
    .prepare(
      `SELECT id, scope, scope_key, type, statement, origin_trust, contradictions, anchors_json FROM items
       WHERE status = 'proposed' AND tenant = ? ${id === undefined ? '' : 'AND id = ?'}
         AND EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = items.id)
       ORDER BY created_at, id`,
    )
    .all(tenant, ...(id === undefined ? [] : [id])) as unknown as Proposal[];
  const evidence = db.prepare('SELECT source_ref, author_role FROM evidence WHERE item_id = ? ORDER BY captured_at, id');
  for (const r of rows) r.evidence = evidence.all(r.id) as Proposal['evidence'];
  return rows;
}

export function renderProposals(list: Proposal[]): string {
  return list
    .map((p) => {
      const g = shadow(p);
      const where = p.scope_key === '' ? p.scope : `${p.scope} ${p.scope_key}`;
      return [
        oneLine(`- [${p.id}] ${p.type}, ${where}, trust ${p.origin_trust}: ${p.statement}`),
        ...p.evidence.map((e) => oneLine(`  evidence: ${e.source_ref} (${e.author_role})`)),
        `  shadow gate: ${g.decision} (${g.signals} signal${g.signals === 1 ? '' : 's'}, ${g.owner} from the owner)`,
      ].join('\n');
    })
    .map((block) => `${block}\n`)
    .join('');
}

/** Sets a proposal's outcome and audits it with the shadow decision, in one transaction. */
export function decide(
  db: DatabaseSync,
  p: Proposal,
  decision: 'approve' | 'reject',
  change: { scope: string; scopeKey: string } | { reason: string | null },
): void {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const { changes } =
      'scope' in change
        ? db
            .prepare("UPDATE items SET status = 'active', scope = ?, scope_key = ?, valid_from = ? WHERE id = ? AND status = 'proposed'")
            .run(change.scope, change.scopeKey, now, p.id)
        : db
            .prepare("UPDATE items SET status = 'rejected', valid_to = ?, status_reason = ? WHERE id = ? AND status = 'proposed'")
            .run(now, change.reason, p.id);
    if (changes !== 1) throw new Error(`proposal ${p.id} changed while it was being decided`);
    recordAudit(db, decision === 'approve' ? 'proposal_approved' : 'proposal_rejected', { type: 'item', id: p.id }, {
      decision,
      shadow: shadow(p).decision,
      ...('scope' in change ? { scope: change.scope } : {}),
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
