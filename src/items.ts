import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { authorityViolations } from './authority.ts';
import { visibleText } from './codefree.ts';
import { READS_EXPIRED } from './recall/rank.ts';
import { recordAudit } from './store/audit.ts';
import { inTransaction } from './store/transaction.ts';

export const SCOPES = ['repository', 'organisation', 'person', 'global'] as const;
export const TYPES = ['preference', 'convention', 'decision', 'hazard', 'precedent', 'failure-pattern', 'repair-recipe'] as const;
export type Scope = (typeof SCOPES)[number];
/** Who an item came from. Only the owner's own `remember`, and the owner's silos, carry owner trust. */
export const ORIGINS = ['agent', 'team', 'external', 'bot'] as const;
export type Trust = 'owner' | (typeof ORIGINS)[number];

export interface Anchor {
  path: string;
  start?: number;
  end?: number;
  /** Absent on a symbol anchor, which a code anchor provider checks. */
  commit?: string;
  citedHash?: string;
  /** A symbol key, `path#qualified_name#kind`. */
  symbol?: string;
}

export interface NewItem {
  tenant: string;
  scope: Scope;
  scopeKey: string;
  type: string;
  statement: string;
  rationale: string | null;
  anchors: Anchor[];
  source: string;
  /** Defaults: an active item with owner trust, as "remember this" makes. */
  status?: 'active' | 'proposed' | 'rejected' | 'superseded';
  trust?: Trust;
  /** The active item this one would replace, or has replaced once it is applied. */
  supersedes?: string;
  /** When the evidence happened (a commit, comment or run), not when memory captured it. */
  evidenceAt?: string;
  /** When a rejected item was rejected. */
  validTo?: string;
  statusReason?: string;
}

/** What the slice and the list show. */
export interface Visible {
  id: string;
  scope: Scope;
  type: string;
  statement: string;
  support: number;
  helped: number;
  wrong: number;
  contradictions: number;
  /** When it was last reinforced (approved, remembered or found helpful), for confidence. */
  reinforced: string;
  anchors: Anchor[];
  source: string;
  /** A search's full-text match, against the best match in the same store: 1 is the best. */
  textRatio?: number;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * What a duplicate and a tombstone are matched by: the hash of the statement
 * as a reader sees it, with no list marker, case, repeated spaces or closing
 * full stop (stack-retro's comparison).
 */
export const statementKey = (text: string): string =>
  sha256(visibleText(text).replace(/^[ \t]*[-*][ \t]+/, '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '').toLowerCase());

/**
 * Why a proposal from anyone but the owner reads as an instruction, as
 * Orbit's authority rule ids, or null. Such a proposal is kept quarantined:
 * never recalled, and shown to the owner with the flag.
 */
export function quarantineOf(item: Pick<NewItem, 'statement' | 'status' | 'trust'>): string | null {
  if ((item.trust ?? 'owner') === 'owner' || item.status !== 'proposed') return null;
  const rules = authorityViolations(item.statement);
  return rules.length === 0 ? null : rules.join(', ');
}

/** One item and its one piece of evidence: by default active with owner trust, as "remember this" makes it. */
export function insertItem(db: DatabaseSync, item: NewItem): string {
  const id = `m-${randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();
  const trust = item.trust ?? 'owner';
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO items (id, tenant, scope, scope_key, type, statement, statement_key, rationale, status, status_reason,
         authority, origin_trust, quarantine, anchors_json, valid_from, valid_to, created_at, supersedes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'advisory', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, item.tenant, item.scope, item.scopeKey, item.type, item.statement, statementKey(item.statement), item.rationale,
      item.status ?? 'active', item.statusReason ?? null, trust, quarantineOf(item), JSON.stringify(item.anchors), now,
      item.validTo ?? null, now, item.supersedes ?? null,
    );
    db.prepare(
      `INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor)
       VALUES (?, ?, ?, ?, ?, ?, 'deterministic')`,
    ).run(`e-${randomBytes(5).toString('hex')}`, id, item.source, trust, sha256(item.statement), item.evidenceAt ?? now);
  });
  return id;
}

/** Active items that do not read as expired: the only ones any recall shows. */
const SELECT = `SELECT id, scope, type, statement, support, helped, wrong, contradictions,
  coalesce(reinforced_at, valid_from) AS reinforced, anchors_json,
  (SELECT source_ref FROM evidence e WHERE e.item_id = items.id ORDER BY captured_at, id LIMIT 1) AS source
  FROM items WHERE status = 'active' AND valid_to IS NULL AND NOT ${READS_EXPIRED}`;

interface Row {
  id: string;
  scope: Scope;
  type: string;
  statement: string;
  support: number;
  helped: number;
  wrong: number;
  contradictions: number;
  reinforced: string;
  anchors_json: string;
  source: string | null;
}

const visible = (rows: Row[]): Visible[] =>
  rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    type: r.type,
    statement: r.statement,
    support: r.support,
    helped: r.helped,
    wrong: r.wrong,
    contradictions: r.contradictions,
    reinforced: r.reinforced,
    anchors: JSON.parse(r.anchors_json) as Anchor[],
    source: r.source ?? '',
  }));

/** The items of a tenant file one repository may see, given tenant, repository and owner. The tenant column is checked as well as the file. */
export const TENANT_SCOPE = "tenant = ? AND ((scope = 'repository' AND scope_key = ?) OR (scope = 'organisation' AND scope_key = ?))";
export const PERSON_SCOPE = "tenant = '' AND scope IN ('person', 'global')";

/** Active items of `tenant` for this repository and its owner. */
export function tenantItems(db: DatabaseSync, tenant: string, repository: string, owner: string): Visible[] {
  return visible(db.prepare(`${SELECT} AND ${TENANT_SCOPE}`).all(tenant, repository, owner) as unknown as Row[]);
}

export function personItems(db: DatabaseSync): Visible[] {
  return visible(db.prepare(`${SELECT} AND ${PERSON_SCOPE}`).all() as unknown as Row[]);
}

/** bm25 of each item whose statement or rationale holds any of `terms`, by id. */
export function textMatches(db: DatabaseSync, terms: readonly string[]): Map<string, number> {
  if (terms.length === 0) return new Map();
  const rows = db
    .prepare('SELECT item_id, bm25(items_fts, 0, 1, 0.5) AS rank FROM items_fts WHERE items_fts MATCH ?')
    .all(terms.map((t) => `"${t}"`).join(' OR ')) as { item_id: string; rank: number }[];
  return new Map(rows.map((r) => [r.item_id, r.rank]));
}

/**
 * The item a new statement repeats, or null: a tombstone blocks it
 * tenant-wide, any other item only where its scope covers the statement's.
 */
export function knownItem(db: DatabaseSync, c: Pick<NewItem, 'tenant' | 'statement' | 'scope' | 'scopeKey'>): { id: string; status: string } | undefined {
  return db
    .prepare(
      `SELECT id, status FROM items WHERE tenant = ? AND statement_key = ?
         AND (status IN ('rejected', 'expired') OR tenant = '' OR (scope = ? AND scope_key = ?) OR (scope = 'organisation' AND scope_key = ?))
       ORDER BY status = 'rejected' DESC LIMIT 1`,
    )
    .get(c.tenant, statementKey(c.statement), c.scope, c.scopeKey, c.scopeKey.split('/')[0]!) as { id: string; status: string } | undefined;
}

/** How long a rejected or expired item keeps its text, in days. */
const TOMBSTONE_DAYS = 30;

/**
 * Reduces rejected and expired items older than 30 days to their statement's
 * hash and their type: the hash still blocks the statement from being
 * proposed again. The scope stays, so a purge by repository still finds it. Run on every open, and checked first, so a reader takes no
 * write lock when there is nothing to reduce.
 */
export function reduceTombstones(db: DatabaseSync): void {
  const due = `status IN ('rejected', 'expired') AND statement != '' AND valid_to < ?`;
  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86_400_000).toISOString();
  if (db.prepare(`SELECT 1 FROM items WHERE ${due} LIMIT 1`).get(cutoff) === undefined) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM evidence WHERE item_id IN (SELECT id FROM items WHERE ${due})`).run(cutoff);
    db.prepare(`DELETE FROM item_vectors WHERE item_id IN (SELECT id FROM items WHERE ${due})`).run(cutoff);
    const { changes } = db
      .prepare(`UPDATE items SET statement = '', rationale = NULL, status_reason = NULL, anchors_json = '[]' WHERE ${due}`)
      .run(cutoff);
    recordAudit(db, 'tombstones_reduced', null, { count: Number(changes) });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
