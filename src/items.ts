import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { visibleText } from './codefree.ts';
import { recordAudit } from './store/audit.ts';

export const SCOPES = ['repository', 'organisation', 'person', 'global'] as const;
export const TYPES = ['preference', 'convention', 'decision', 'hazard', 'precedent', 'failure-pattern', 'repair-recipe'] as const;
export type Scope = (typeof SCOPES)[number];

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
  status?: 'active' | 'proposed' | 'rejected';
  trust?: 'owner' | 'agent';
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
  anchors: Anchor[];
  source: string;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * What a duplicate and a tombstone are matched by: the hash of the statement
 * as a reader sees it, with no list marker, case, repeated spaces or closing
 * full stop (stack-retro's comparison).
 */
export const statementKey = (text: string): string =>
  sha256(visibleText(text).replace(/^[ \t]*[-*][ \t]+/, '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '').toLowerCase());

/** One item and its one piece of evidence: by default active with owner trust, as "remember this" makes it. */
export function insertItem(db: DatabaseSync, item: NewItem): string {
  const id = `m-${randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();
  const trust = item.trust ?? 'owner';
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO items (id, tenant, scope, scope_key, type, statement, statement_key, rationale, status, status_reason,
         authority, origin_trust, anchors_json, valid_from, valid_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'advisory', ?, ?, ?, ?, ?)`,
    ).run(
      id, item.tenant, item.scope, item.scopeKey, item.type, item.statement, statementKey(item.statement), item.rationale,
      item.status ?? 'active', item.statusReason ?? null, trust, JSON.stringify(item.anchors), now, item.validTo ?? null, now,
    );
    db.prepare(
      `INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor)
       VALUES (?, ?, ?, ?, ?, ?, 'deterministic')`,
    ).run(`e-${randomBytes(5).toString('hex')}`, id, item.source, trust, sha256(item.statement), now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return id;
}

const SELECT = `SELECT id, scope, type, statement, support, anchors_json,
  (SELECT source_ref FROM evidence e WHERE e.item_id = items.id ORDER BY captured_at, id LIMIT 1) AS source
  FROM items WHERE status = 'active' AND valid_to IS NULL`;

interface Row {
  id: string;
  scope: Scope;
  type: string;
  statement: string;
  support: number;
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
    anchors: JSON.parse(r.anchors_json) as Anchor[],
    source: r.source ?? '',
  }));

/** Active items of `tenant` for this repository and its owner. The tenant column is checked as well as the file. */
export function tenantItems(db: DatabaseSync, tenant: string, repository: string, owner: string): Visible[] {
  return visible(
    db
      .prepare(
        `${SELECT} AND tenant = ? AND ((scope = 'repository' AND scope_key = ?) OR (scope = 'organisation' AND scope_key = ?))`,
      )
      .all(tenant, repository, owner) as unknown as Row[],
  );
}

export function personItems(db: DatabaseSync): Visible[] {
  return visible(db.prepare(`${SELECT} AND scope IN ('person', 'global')`).all() as unknown as Row[]);
}

/** How long a rejected or expired item keeps its text, in days. */
const TOMBSTONE_DAYS = 30;

/**
 * Reduces rejected and expired items older than 30 days to their statement's
 * hash and their type: the hash still blocks the statement from being
 * proposed again. Run on every open, and checked first, so a reader takes no
 * write lock when there is nothing to reduce.
 */
export function reduceTombstones(db: DatabaseSync): void {
  const due = `status IN ('rejected', 'expired') AND statement != '' AND valid_to < ?`;
  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86_400_000).toISOString();
  if (db.prepare(`SELECT 1 FROM items WHERE ${due} LIMIT 1`).get(cutoff) === undefined) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM evidence WHERE item_id IN (SELECT id FROM items WHERE ${due})`).run(cutoff);
    const { changes } = db
      .prepare(`UPDATE items SET statement = '', rationale = NULL, status_reason = NULL, scope_key = '', anchors_json = '[]' WHERE ${due}`)
      .run(cutoff);
    recordAudit(db, 'tombstones_reduced', null, { count: Number(changes) });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
