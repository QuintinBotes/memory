import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { visibleText } from './codefree.ts';
import { cleanTaint, insertItem, knownItem, sha256, statementKey, type Anchor, type NewItem, type Visible } from './items.ts';
import { recordAudit } from './store/audit.ts';
import { inTransaction } from './store/transaction.ts';

/**
 * What happens when a statement arrives: a repeat becomes evidence on the item
 * it repeats, a statement on the same subject that disagrees becomes a
 * supersession the owner decides, anything else is stored as before. Matching
 * is deterministic (the normalised key, word overlap, anchor overlap); nothing
 * is ever rewritten or deleted, and nothing becomes active without the owner.
 */

/** Word overlap (Jaccard) from which two statements are the same, and from which they are about the same thing. */
const REPEAT = 0.8;
const CONFLICT = 0.5;

const words = (text: string): Set<string> => new Set(visibleText(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** The words that hold a digit, in order: two statements with different ones are about different numbers. */
const numberKey = (s: Set<string>): string => [...s].filter((w) => /\d/.test(w)).sort().join(' ');
const sameNumbers = (a: Set<string>, b: Set<string>): boolean => numberKey(a) === numberKey(b);

/** Whether two statements say the same thing, by the matcher a new statement meets: the same normalised key, or a close word overlap with the same numbers. */
export const repeats = (a: string, b: string): boolean =>
  statementKey(a) === statementKey(b) || (similarity(words(a), words(b)) >= REPEAT && sameNumbers(words(a), words(b)));

/** Two items can only be about the same subject if neither is anchored, or they cite a common file. */
const anchorsOverlap = (a: Anchor[], b: Anchor[]): boolean => a.length === 0 || b.length === 0 || a.some((x) => b.some((y) => x.path === y.path));

interface Related {
  id: string;
  status: string;
  scope: string;
  scope_key: string;
  statement: string;
  statement_key: string;
  type: string;
  anchors_json: string;
}

export type Stored =
  | { kind: 'rejected'; id: string }
  | { kind: 'known'; id: string }
  | { kind: 'merged'; id: string; audit: string; support: number }
  | { kind: 'inserted'; id: string; supersedes?: string }
  | { kind: 'superseded-on-arrival'; id: string; by: string };

/**
 * Writes what the scan decided, under the write lock, after asking once more the one question another writer may have
 * answered since the scan: is this exact statement already here? If so it becomes evidence on it, so a statement
 * proposed by two sessions at once stays one item. Near matches are decided by the scan alone.
 */
function place(db: DatabaseSync, c: NewItem, key: string, write: () => Stored): Stored {
  return inTransaction(db, () => {
    // A tombstone another writer left while this one queued blocks it too.
    const blocked = priorDecision(db, c);
    if (blocked !== undefined) return blocked;
    const same = db
      .prepare(
        `SELECT id, anchors_json FROM items WHERE tenant = ? AND statement_key = ? AND status IN ('active', 'proposed') AND statement != ''
           AND (tenant = '' OR (scope = ? AND scope_key = ?) OR (scope = 'organisation' AND scope_key = ?)) ORDER BY created_at, id`,
      )
      .all(c.tenant, key, c.scope, c.scopeKey, c.scopeKey.split('/')[0]!) as { id: string; anchors_json: string }[];
    const repeat = same.find((r) => anchorsOverlap(c.anchors, JSON.parse(r.anchors_json) as Anchor[]));
    return repeat === undefined ? write() : mergeEvidence(db, repeat.id, c);
  });
}

/** A tombstone, or a stale or superseded item, already settles this statement: it is not proposed again. */
function priorDecision(db: DatabaseSync, c: NewItem): Stored | undefined {
  const was = knownItem(db, c);
  if (c.status !== 'active' && was !== undefined && (was.status === 'rejected' || was.status === 'expired')) return { kind: 'rejected', id: was.id };
  // Stale and superseded items keep their statement: it is not proposed again either.
  if (was !== undefined && !['active', 'proposed', 'rejected', 'expired'].includes(was.status)) return { kind: 'known', id: was.id };
  return undefined;
}

/** Adds `c`, consolidating it with what the store holds. `c.status` of `active` is the owner's own "remember this". */
export function addItem(db: DatabaseSync, c: NewItem): Stored {
  const blocked = priorDecision(db, c);
  if (blocked !== undefined) return blocked;

  const key = statementKey(c.statement);
  const mine = words(c.statement);
  const rows = db
    .prepare(
      `SELECT id, status, scope, scope_key, statement, statement_key, type, anchors_json FROM items
       WHERE tenant = ? AND status IN ('active', 'proposed') AND statement != ''
         AND (tenant = '' OR (scope = ? AND scope_key = ?) OR (scope = 'organisation' AND scope_key = ?))
       ORDER BY created_at, id`,
    )
    .all(c.tenant, c.scope, c.scopeKey, c.scopeKey.split('/')[0]!) as unknown as Related[];
  let conflict: { row: Related; sim: number } | undefined;
  for (const r of rows) {
    if (!anchorsOverlap(c.anchors, JSON.parse(r.anchors_json) as Anchor[])) continue;
    // The exact statement is a repeat whatever its type, as it always was; a looser match needs the same type.
    if (r.statement_key === key) return mergeEvidence(db, r.id, c);
    if (r.type !== c.type || c.exactOnly === true) continue;
    const theirs = words(r.statement);
    const sim = similarity(mine, theirs);
    // "retry 3 times" and "retry 5 times" are about one subject, not one claim.
    if (sim >= REPEAT && sameNumbers(mine, theirs)) return mergeEvidence(db, r.id, c);
    if (sim >= CONFLICT && r.status === 'active' && r.scope === c.scope && r.scope_key === c.scopeKey && sim > (conflict?.sim ?? 0)) conflict = { row: r, sim };
  }
  if (conflict === undefined) return place(db, c, key, () => ({ kind: 'inserted', id: insertItem(db, c) }));

  // The newer statement is the one whose evidence is newer, not the one memory captured last.
  const older = (db.prepare('SELECT min(captured_at) AS at FROM evidence WHERE item_id = ?').get(conflict.row.id) as { at: string | null }).at;
  if (c.evidenceAt !== undefined && older !== null && c.evidenceAt < older) {
    return place(db, c, key, () => ({ kind: 'superseded-on-arrival', id: insertItem(db, { ...c, status: 'superseded', validTo: older, statusReason: `superseded by ${conflict.row.id}` }), by: conflict.row.id }));
  }
  return place(db, c, key, () => ({ kind: 'inserted', id: insertItem(db, { ...c, supersedes: conflict.row.id }), supersedes: conflict.row.id }));
}

/** Attaches `c` as evidence to `id`, with its own trust. Only the owner's evidence raises support. */
function mergeEvidence(db: DatabaseSync, id: string, c: NewItem): Stored {
  const trust = c.trust ?? 'owner';
  const delta = trust === 'owner' ? 1 : 0;
  const evidenceId = `e-${randomBytes(5).toString('hex')}`;
  return inTransaction(db, () => {
    // Asked under the lock: the same source arriving twice at once is one piece of evidence.
    if (db.prepare('SELECT 1 FROM evidence WHERE item_id = ? AND source_ref = ?').get(id, c.source) !== undefined) return { kind: 'known', id };
    db.prepare(
      `INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor, taint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(evidenceId, id, c.source, trust, sha256(c.statement), c.evidenceAt ?? new Date().toISOString(), c.extractor ?? 'deterministic', cleanTaint(c.taint));
    db.prepare('UPDATE items SET support = support + ? WHERE id = ?').run(delta, id);
    const audit = recordAudit(db, 'evidence_merged', { type: 'item', id }, { evidenceId, supportDelta: delta, trust });
    const { support } = db.prepare('SELECT support FROM items WHERE id = ?').get(id) as { support: number };
    return { kind: 'merged', id, audit, support };
  });
}

/**
 * Ends the validity of `olderId`, which stays on record whole, and links the newer item to it. The caller's
 * transaction. Null when the older item is no longer active.
 */
export function applySupersession(db: DatabaseSync, newerId: string, olderId: string, newerWas: string, pending: boolean): string | null {
  const { changes } = db
    .prepare("UPDATE items SET status = 'superseded', valid_to = ?, status_reason = ? WHERE id = ? AND status = 'active'")
    .run(new Date().toISOString(), `superseded by ${newerId}`, olderId);
  if (changes !== 1) return null;
  db.prepare('UPDATE items SET supersedes = ? WHERE id = ?').run(olderId, newerId);
  return recordAudit(db, 'supersession_applied', { type: 'item', id: newerId }, { older: olderId, newerWas, pending });
}

/** `remember --supersedes`: the owner's own word, applied at once. Null when `olderId` is not an active item here. */
export function supersedeNow(db: DatabaseSync, c: NewItem, olderId: string): { id: string; audit: string } | null {
  if (db.prepare("SELECT 1 FROM items WHERE id = ? AND tenant = ? AND status = 'active'").get(olderId, c.tenant) === undefined) return null;
  const id = insertItem(db, c);
  db.exec('BEGIN IMMEDIATE');
  try {
    const audit = applySupersession(db, id, olderId, 'active', false);
    db.exec('COMMIT');
    return audit === null ? null : { id, audit };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Reverses one merge or supersession by its audit id. False when this store holds no such undoable event. */
export function undo(db: DatabaseSync, auditId: string): string | false {
  const e = db.prepare('SELECT action, subject_id, metadata_json FROM audit_events WHERE audit_id = ?').get(auditId) as
    | { action: string; subject_id: string; metadata_json: string }
    | undefined;
  if (e === undefined || (e.action !== 'evidence_merged' && e.action !== 'supersession_applied')) return false;
  const m = JSON.parse(e.metadata_json) as Record<string, unknown>;
  db.exec('BEGIN IMMEDIATE');
  try {
    let what: string | false;
    if (e.action === 'evidence_merged') {
      const gone = db.prepare('DELETE FROM evidence WHERE id = ? AND item_id = ?').run(m['evidenceId'] as string, e.subject_id);
      if (gone.changes === 1) db.prepare('UPDATE items SET support = support - ? WHERE id = ?').run(m['supportDelta'] as number, e.subject_id);
      what = gone.changes === 1 ? `removed the merged evidence from ${e.subject_id}` : false;
    } else {
      const older = m['older'] as string;
      const back = db
        .prepare("UPDATE items SET status = 'active', valid_to = NULL, status_reason = NULL WHERE id = ? AND status = 'superseded' AND status_reason = ?")
        .run(older, `superseded by ${e.subject_id}`);
      if (back.changes === 1) {
        // A supersession that was queued is queued again; one the owner asked for outright is simply undone.
        db.prepare("UPDATE items SET supersedes = ?, status = ? WHERE id = ?").run(m['pending'] === true ? older : null, m['newerWas'] as string, e.subject_id);
      }
      what = back.changes === 1 ? `${older} is active again` : false;
    }
    if (what !== false) recordAudit(db, 'undone', { type: 'audit', id: auditId }, { action: e.action });
    db.exec('COMMIT');
    return what;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const NARROWNESS = ['person', 'repository', 'organisation', 'global'];

/**
 * Recall's rule for a conflict across scopes: of two visible items of one type that are about the same thing, only
 * the narrower scope is shown. "The same thing" is the consolidation matcher: a repeat or a conflict, and never a pair
 * whose numbers differ. Nothing is superseded or changed; the broader item is shown again where it stands alone.
 */
export function narrowerWins(items: Visible[]): Visible[] {
  const w = items.map((i) => words(i.statement));
  const keys = items.map((item, i) => `${item.type}\u0000${numberKey(w[i]!)}`);
  // Prefix filter: order every statement's words rarest first; two statements whose overlap reaches CONFLICT share a
  // word among the first `size - ceil(size * CONFLICT) + 1` of each. So only those words are indexed and probed.
  const frequency = new Map<string, number>();
  for (const set of w) for (const word of set) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const prefixes = w.map((set) =>
    [...set].sort((x, y) => frequency.get(x)! - frequency.get(y)! || (x < y ? -1 : 1)).slice(0, set.size - Math.ceil(set.size * CONFLICT) + 1),
  );
  // Only items of one type and one number key are compared, and only with a narrower scope.
  const index = new Map<string, Map<string, number[]>>();
  for (const [i, item] of items.entries()) {
    for (const word of prefixes[i]!) {
      const posting = index.get(`${keys[i]}\u0000${item.scope}`) ?? new Map<string, number[]>();
      (posting.get(word) ?? posting.set(word, []).get(word)!).push(i);
      index.set(`${keys[i]}\u0000${item.scope}`, posting);
    }
  }
  return items.filter((a, i) => {
    for (const scope of NARROWNESS.slice(0, NARROWNESS.indexOf(a.scope))) {
      const posting = index.get(`${keys[i]}\u0000${scope}`);
      if (posting === undefined) continue;
      for (const j of new Set(prefixes[i]!.flatMap((word) => posting.get(word) ?? []))) {
        // Jaccard cannot reach CONFLICT when the smaller set is under CONFLICT of the larger.
        if (Math.min(w[i]!.size, w[j]!.size) < CONFLICT * Math.max(w[i]!.size, w[j]!.size)) continue;
        if (anchorsOverlap(a.anchors, items[j]!.anchors) && similarity(w[i]!, w[j]!) >= CONFLICT) return false;
      }
    }
    return true;
  });
}

const DAY = 86_400_000;

/**
 * FR-006: the same matching over the active items of one store. Of two that repeat each other, the newer is left
 * active and named as superseding the older, which is the supersession proposal `memory review` already shows;
 * the owner approves or rejects it. Nothing is applied here, and a pair already waiting is not proposed twice.
 * shortcut: compares every pair of the store's active items, quadratic; index by type if a store passes ~5,000 items.
 */
export function sweep(db: DatabaseSync): number {
  // Read under the write lock: two sweeps queue, and the second sees what the first proposed and any row purged since.
  return inTransaction(db, () => {
    const rows = (
      db
        .prepare(
          `SELECT id, status, scope, scope_key, statement, statement_key, type, anchors_json, supersedes FROM items
           WHERE status = 'active' AND statement != '' ORDER BY created_at, id`,
        )
        .all() as unknown as (Related & { supersedes: string | null })[]
    ).map((r) => ({ ...r, w: words(r.statement), anchors: JSON.parse(r.anchors_json) as Anchor[] }));
    const taken = new Set(rows.map((r) => r.supersedes).filter((id) => id !== null));
    let proposed = 0;
    for (const [j, newer] of rows.entries()) {
      if (newer.supersedes !== null) continue;
      const older = rows.slice(0, j).find((r) => {
        if (taken.has(r.id) || r.type !== newer.type || r.scope !== newer.scope || r.scope_key !== newer.scope_key) return false;
        if (!anchorsOverlap(r.anchors, newer.anchors)) return false;
        return r.statement_key === newer.statement_key || (similarity(newer.w, r.w) >= REPEAT && sameNumbers(newer.w, r.w));
      });
      if (older === undefined) continue;
      db.prepare('UPDATE items SET supersedes = ? WHERE id = ?').run(older.id, newer.id);
      recordAudit(db, 'merge_proposed', { type: 'item', id: newer.id }, { older: older.id });
      taken.add(older.id);
      proposed++;
    }
    recordAudit(db, 'sweep', null, { proposed });
    return proposed;
  });
}

/** Above this many active items the session start leaves the sweep to `memory sweep`: about half a million pairs, well under a second. */
export const START_SWEEP_MAX = 1000;

/** The sweep, unless this store was swept in the last day or is too large to sweep at a session start. */
export function sweepIfDue(db: DatabaseSync, now = Date.now()): number | null {
  const last = (db.prepare("SELECT max(created_at) AS at FROM audit_events WHERE action = 'sweep'").get() as { at: string | null }).at;
  if (last !== null && now - Date.parse(last) < DAY) return null;
  const { n } = db.prepare("SELECT count(*) AS n FROM items WHERE status = 'active' AND statement != ''").get() as { n: number };
  return n > START_SWEEP_MAX ? null : sweep(db);
}
