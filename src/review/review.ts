import type { DatabaseSync } from 'node:sqlite';
import { organisationTerms, type Config } from '../config.ts';
import { ownerOf, type Context } from '../context.ts';
import { embedAfterWrite } from '../embed/vectors.ts';
import { Refusal, refusal } from '../gate.ts';
import { taintList, type Scope } from '../items.ts';
import { EXPIRY_DAYS } from '../recall/rank.ts';
import { safe } from '../render/rows.ts';
import { applySupersession } from '../consolidate.ts';
import { recordAudit } from '../store/audit.ts';
import { inTransaction } from '../store/transaction.ts';
import { openStore } from '../store/db.ts';
import { personFile, tenantFile } from '../store/paths.ts';

/**
 * The owner's review of proposals. Approve and reject are terminal commands
 * only; each records the owner's decision beside the shadow gate's, so the
 * gate can be judged after 50 decisions.
 */

export interface Proposal {
  id: string;
  /**
   * `proposed`; `active` for an item agents reported stale while its citation held; or `stale` for one
   * an older install sharing this data directory hid on an agent's report, which the owner may restore.
   */
  status: string;
  stale_reports: number;
  status_reason: string | null;
  scope: string;
  scope_key: string;
  type: string;
  statement: string;
  origin_trust: string;
  /** Orbit's authority rule ids when the statement reads as an instruction, else null. */
  quarantine: string | null;
  contradictions: number;
  anchors_json: string;
  evidence: { source_ref: string; author_role: string; taint: string | null; agent: string | null }[];
  /** The active item this one would replace, when the owner has not yet decided. */
  supersedes: string | null;
  older: { id: string; type: string; statement: string; evidence: Proposal['evidence'] } | null;
}

/** The keys a stale item's anchor could move to, when the refresh could not decide (`memory anchors adopt`). */
export const reanchorCandidates = (p: Pick<Proposal, 'status' | 'status_reason' | 'anchors_json'>): string[] =>
  p.status === 'stale' && p.status_reason === 'key gone' ? (JSON.parse(p.anchors_json) as { candidates?: string[] }[]).flatMap((a) => a.candidates ?? []) : [];

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
      `SELECT id, status, scope, scope_key, type, statement, origin_trust, quarantine, contradictions, anchors_json, stale_reports, status_reason, supersedes FROM items
       WHERE (status = 'proposed' OR (status = 'active' AND stale_reports > 0)
              OR (status = 'active' AND EXISTS (SELECT 1 FROM items o WHERE o.id = items.supersedes AND o.status = 'active')) OR (status = 'stale' AND status_reason = 'reported stale')
              OR (status = 'stale' AND status_reason = 'key gone' AND anchors_json LIKE '%"candidates"%')) AND tenant = ? ${id === undefined ? '' : 'AND id = ?'}
         AND EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = items.id)
       ORDER BY created_at, id`,
    )
    .all(tenant, ...(id === undefined ? [] : [id])) as unknown as Proposal[];
  const evidence = db.prepare("SELECT source_ref, author_role, taint, CASE WHEN extractor LIKE 'mcp:%' THEN substr(extractor, 5) END AS agent FROM evidence WHERE item_id = ? ORDER BY captured_at, id");
  const older = db.prepare("SELECT id, type, statement FROM items WHERE id = ? AND status = 'active'");
  for (const r of rows) {
    r.evidence = evidence.all(r.id) as Proposal['evidence'];
    const o = r.supersedes === null ? undefined : (older.get(r.supersedes) as { id: string; type: string; statement: string } | undefined);
    r.older = o === undefined ? null : { ...o, evidence: evidence.all(o.id) as Proposal['evidence'] };
  }
  return rows;
}

/** The distinct taint labels of a proposal's evidence, as a reader sees them, or null. */
const taintOf = (evidence: Proposal['evidence']): string | null => {
  const all = [...new Set(evidence.flatMap((e) => (e.taint === null ? [] : [e.taint])))];
  return all.length === 0 ? null : taintList(all.join(','));
};
const evidenceLine = (indent: string, e: Proposal['evidence'][number]): string =>
  safe(`${indent}evidence: ${e.source_ref} (${e.author_role})${e.agent === null ? '' : ` via ${e.agent}`}${e.taint === null ? '' : `, tainted by ${taintList(e.taint)}`}`);

export function renderProposals(list: Proposal[]): string {
  return list
    .map((p) => {
      const g = shadow(p);
      const where = p.scope_key === '' ? p.scope : `${p.scope} ${p.scope_key}`;
      const taint = taintOf(p.evidence);
      return [
        // Quoted, so the statement reads as data, whatever it says; normalised first, so the quoting escapes what normalising makes.
        safe(`- [${p.id}] ${p.type}, ${where}, trust ${p.origin_trust}${taint === null ? '' : `, tainted by ${taint}`}${p.quarantine === null ? '' : `, quarantined (${p.quarantine})`}${p.status === 'stale' ? (reanchorCandidates(p).length > 0 ? ', stale: its symbol is gone' : ', hidden by an agent through an older install') : p.stale_reports === 0 ? '' : `, active, reported stale by an agent ${p.stale_reports} time${p.stale_reports === 1 ? '' : 's'}`}: ${JSON.stringify(safe(p.statement))}`),
        ...p.evidence.map((e) => evidenceLine('  ', e)),
        ...(reanchorCandidates(p).length === 0 ? [] : [safe(`  re-anchor candidates: ${reanchorCandidates(p).join(', ')}; the owner decides with memory anchors adopt ${p.id} <key>`)]),
        ...(p.older === null
          ? []
          : [
              safe(`  supersedes [${p.older.id}] ${p.older.type}: ${JSON.stringify(safe(p.older.statement))}`),
              ...p.older.evidence.map((e) => evidenceLine('    ', e)),
            ]),
        ...(p.status !== 'proposed' ? [] : [`  shadow gate: ${g.decision} (${g.signals} signal${g.signals === 1 ? '' : 's'}, ${g.owner} from the owner)`]),
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
): string | null {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const { changes } =
      'scope' in change
        ? db
            .prepare("UPDATE items SET status = 'active', status_reason = NULL, stale_reports = 0, scope = ?, scope_key = ?, valid_from = ? WHERE id = ? AND status = ?")
            .run(change.scope, change.scopeKey, now, p.id, p.status)
        : db
            .prepare("UPDATE items SET status = 'rejected', valid_to = ?, status_reason = ? WHERE id = ? AND status = ?")
            .run(now, change.reason, p.id, p.status);
    if (changes !== 1) throw new Error(`proposal ${p.id} changed while it was being decided`);
    // Approving a supersession proposal is the owner's yes to both halves.
    const superseded = 'scope' in change && p.older !== null ? applySupersession(db, p.id, p.older.id, p.status, true) : null;
    recordAudit(db, decision === 'approve' ? 'proposal_approved' : 'proposal_rejected', { type: 'item', id: p.id }, {
      decision,
      shadow: shadow(p).decision,
      ...('scope' in change ? { scope: change.scope } : {}),
    });
    db.exec('COMMIT');
    return superseded;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** The stores whose proposals may be reviewed here: this repository's tenant, then the person file. */
export function proposalStores(data: string, context: Context): { file: string; tenant: string }[] {
  return [...(context.tenant === null ? [] : [{ file: tenantFile(data, context.tenant), tenant: context.tenant }]), { file: personFile(data), tenant: '' }];
}

/**
 * The owner's decision on one proposal of the stores this repository may see, as `memory approve`, `memory reject` and
 * the page make it: what was done, or null when no proposal has that id here. Throws Refusal when it may not be made.
 */
export async function decideById(
  data: string,
  config: Config,
  context: Context,
  id: string,
  decision: 'approve' | 'reject',
  options: { scope?: Scope | undefined; reason?: string | undefined },
): Promise<string | null> {
  const reason = options.reason?.trim() ?? '';
  for (const { file, tenant } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      const [p] = proposals(db, tenant, id);
      if (p === undefined) continue;
      if (decision === 'approve' && reanchorCandidates(p).length > 0) {
        throw new Refusal(`${id} is stale because its symbol is gone; choose a new anchor with memory anchors adopt ${id} <key> (candidates: ${reanchorCandidates(p).join(', ')}), or memory reject ${id}`);
      }
      if (decision === 'reject') {
        // A reason kept in the person file follows the owner into every organisation, as the statement does.
        const why = reason === '' ? null : refusal(reason, tenant === '' ? organisationTerms(config, context.repository) : undefined);
        if (why !== null) throw new Refusal(`not rejected: the reason is refused because ${why}`);
        if (isPendingSupersession(p)) {
          declineSupersession(db, p);
          return `declined: ${id} stays active and ${p.older!.id} stays active`;
        }
        decide(db, p, 'reject', { reason: reason === '' ? null : reason });
        return `rejected ${id}; the same statement will not be proposed again`;
      }
      // A proposal keeps to its file: moving between the person file and a tenant is a new item.
      const allowed = tenant === '' ? ['person', 'global'] : p.scope === 'repository' ? ['repository', 'organisation'] : [p.scope];
      const to = options.scope ?? p.scope;
      if (!allowed.includes(to)) throw new Refusal(`this ${p.scope} proposal can be approved as ${allowed.join(' or ')} only`);
      if (to === 'organisation' && p.anchors_json !== '[]') throw new Refusal('only a repository item can have an anchor');
      const scopeKey = to === 'organisation' && p.scope === 'repository' ? ownerOf(p.scope_key) : p.scope_key;
      const superseded = decide(db, p, 'approve', { scope: to, scopeKey });
      const flag = p.quarantine === null ? '' : `; it was quarantined (${p.quarantine}) as text that reads as an instruction`;
      const replaced = superseded === null ? '' : `; it supersedes ${p.older!.id}, which stays on record; undo with memory undo ${superseded}`;
      await embedAfterWrite(db, config, tenant);
      return `approved ${id} (${to}${scopeKey ? ` ${scopeKey}` : ''}${tenant ? `, tenant ${tenant}` : ''})${flag}${replaced}`;
    } finally {
      db.close();
    }
  }
  return null;
}

/** Whether `p` is an active item whose only question is whether it replaces an older one. */
export const isPendingSupersession = (p: Proposal): boolean => p.status === 'active' && p.stale_reports === 0 && p.older !== null;

/** An active, unpinned item near or past its expiry, for the owner (#142). `days_left` is 0 or less once it has expired. */
export interface Expiring {
  id: string;
  scope: string;
  scope_key: string;
  type: string;
  statement: string;
  days_left: number;
}

/** Days until an item reads as expired, as SQL on `items`: negative once it has. */
const LEFT = `${EXPIRY_DAYS} - (julianday('now') - julianday(coalesce(reinforced_at, valid_from)))`;

/**
 * The active, unpinned items of `tenant` in one store that expire within 14 days or expired in the last 30, soonest
 * first; with `expired`, every one that has expired.
 */
export function expiring(db: DatabaseSync, tenant: string, expired = false): Expiring[] {
  const rows = db
    .prepare(
      `SELECT id, scope, scope_key, type, statement, ${LEFT} AS left FROM items
       WHERE tenant = ? AND status = 'active' AND valid_to IS NULL AND pinned_at IS NULL AND ${LEFT} ${expired ? '< 0' : 'BETWEEN -30 AND 14'}
       ORDER BY left, id`,
    )
    .all(tenant) as unknown as (Omit<Expiring, 'days_left'> & { left: number })[];
  // + 0 turns the -0 of an item expired less than a day ago into 0.
  return rows.map(({ left, ...r }) => ({ ...r, days_left: Math.ceil(left) + 0 }));
}

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

export function renderExpiring(list: Expiring[]): string {
  return list
    .map((e) => {
      const when = e.days_left > 0 ? `${days(e.days_left)} left` : e.days_left === 0 ? 'expired today' : `expired ${days(-e.days_left)} ago`;
      return `${safe(`- [${e.id}] ${e.type}, ${e.scope_key === '' ? e.scope : `${e.scope} ${e.scope_key}`}: ${JSON.stringify(safe(e.statement))}, ${when}`)}\n`;
    })
    .join('');
}

const ACTIVE = "id = ? AND status = 'active' AND valid_to IS NULL";

/**
 * The owner's `memory renew`: resets an active item's reinforcement date, so expiry counts from now. Support is
 * unchanged. Returns the audit id `memory undo` takes, or null when no active item has that id here.
 */
export function renew(db: DatabaseSync, id: string): string | null {
  return inTransaction(db, () => {
    const row = db.prepare(`SELECT reinforced_at FROM items WHERE ${ACTIVE}`).get(id) as { reinforced_at: string | null } | undefined;
    if (row === undefined) return null;
    const at = new Date().toISOString();
    db.prepare('UPDATE items SET reinforced_at = ? WHERE id = ?').run(at, id);
    return recordAudit(db, 'item_renewed', { type: 'item', id }, { was: row.reinforced_at, at });
  });
}

/**
 * The owner's `memory pin` and `unpin`: a pinned item never reads as expired, and nothing else about it changes. Only an
 * item the owner stated (owner evidence) or approved can be pinned; otherwise its trust is returned, for the refusal.
 */
export function setPin(db: DatabaseSync, id: string, pin: boolean): 'done' | 'already' | 'missing' | { trust: string } {
  return inTransaction(db, () => {
    const row = db
      .prepare(
        `SELECT pinned_at, origin_trust, EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = items.id AND e.author_role = 'owner')
           OR EXISTS (SELECT 1 FROM audit_events a WHERE a.subject_id = items.id AND a.action = 'proposal_approved') AS owned
         FROM items WHERE ${ACTIVE}`,
      )
      .get(id) as { pinned_at: string | null; origin_trust: string; owned: number } | undefined;
    if (row === undefined) return 'missing';
    if ((row.pinned_at !== null) === pin) return 'already';
    if (pin && row.owned === 0) return { trust: row.origin_trust };
    db.prepare('UPDATE items SET pinned_at = ? WHERE id = ?').run(pin ? new Date().toISOString() : null, id);
    recordAudit(db, pin ? 'item_pinned' : 'item_unpinned', { type: 'item', id });
    return 'done';
  });
}

/** The owner declined to replace the older item: both stay active, and the link is dropped. */
export function declineSupersession(db: DatabaseSync, p: Proposal): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE items SET supersedes = NULL WHERE id = ?').run(p.id);
    recordAudit(db, 'proposal_rejected', { type: 'item', id: p.id }, { decision: 'reject', supersession: p.older?.id });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
