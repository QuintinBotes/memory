import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SCOPES = ['repository', 'organisation', 'person', 'global'] as const;
export const TYPES = ['preference', 'convention', 'decision', 'hazard', 'precedent', 'failure-pattern', 'repair-recipe'] as const;
export type Scope = (typeof SCOPES)[number];

export interface Anchor {
  path: string;
  start?: number;
  end?: number;
  commit: string;
  citedHash: string;
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

/** An item the owner asked to remember: active at once, with owner trust and one piece of evidence. */
export function insertItem(db: DatabaseSync, item: NewItem): string {
  const id = `m-${randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO items (id, tenant, scope, scope_key, type, statement, rationale, status, authority, origin_trust,
         anchors_json, valid_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'advisory', 'owner', ?, ?, ?)`,
    ).run(id, item.tenant, item.scope, item.scopeKey, item.type, item.statement, item.rationale, JSON.stringify(item.anchors), now, now);
    db.prepare(
      `INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor)
       VALUES (?, ?, ?, 'owner', ?, ?, 'deterministic')`,
    ).run(`e-${randomBytes(5).toString('hex')}`, id, item.source, sha256(item.statement), now);
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
