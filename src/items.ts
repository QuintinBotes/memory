import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { authorityViolations } from './authority.ts';
import { visibleText } from './codefree.ts';
import { READS_EXPIRED } from './recall/rank.ts';
import { recordAudit } from './store/audit.ts';
import { inTransaction } from './store/transaction.ts';

export const SCOPES = ['repository', 'organisation', 'person', 'global'] as const;
export const TYPES = ['preference', 'convention', 'decision', 'hazard', 'precedent', 'failure-pattern', 'repair-recipe', 'open_question', 'toolset'] as const;
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
  /** What a code anchor provider reported when it last resolved `symbol` (docs/provider.md); all present or none. */
  signature?: string;
  contentHash?: string;
  fileHash?: string;
  snapshot?: string;
  /** The nearest test that executes `symbol`, as the provider named it at snapshot `testsAt` (docs/provider.md); none when no test does. */
  test?: { name: string; path: string; line?: number };
  testsAt?: string;
  /** On a stale anchor whose key is gone: the added symbols the owner may re-anchor to (`memory anchors adopt`). */
  candidates?: string[];
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
  /** Only the exact statement joins an existing item: a near match never merges or conflicts (a failure keyed by check and fingerprint). */
  exactOnly?: boolean;
  /** The external content the session that made this had read, named by its source; see `cleanTaint`. */
  taint?: string;
  /** The repository (`owner/repo`) this was learned in, null when unknown. Absent: a repository item's own, else unknown. */
  originRepository?: string | null;
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
  /** The external sources its evidence came from or was made after reading (FR-006 of #22), comma-separated; absent when none. */
  taint?: string;
  /** The repository it was learned in, null when unknown. */
  origin?: string | null;
  /** A search's full-text match, against the best match in the same store: 1 is the best. */
  textRatio?: number;
}

/**
 * A taint label as stored: one line, no comma (the list a reader sees is comma-separated) and no longer than 120
 * characters. Null when there is none.
 */
export const cleanTaint = (taint: string | undefined): string | null => {
  const t = (taint ?? '').replace(/[\s,]+/g, '_').slice(0, 120);
  return t === '' ? null : t;
};

/** The taint of an item as a reader sees it: every distinct label on its evidence. */
export const taintList = (taint: string | null | undefined): string => (taint ?? '').split(',').join(', ');

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
         authority, origin_trust, quarantine, anchors_json, valid_from, valid_to, created_at, supersedes, origin_repository)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'advisory', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, item.tenant, item.scope, item.scopeKey, item.type, item.statement, statementKey(item.statement), item.rationale,
      item.status ?? 'active', item.statusReason ?? null, trust, quarantineOf(item), JSON.stringify(item.anchors), now,
      item.validTo ?? null, now, item.supersedes ?? null, item.originRepository !== undefined ? item.originRepository : item.scope === 'repository' ? item.scopeKey : null,
    );
    db.prepare(
      `INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor, taint)
       VALUES (?, ?, ?, ?, ?, ?, 'deterministic', ?)`,
    ).run(`e-${randomBytes(5).toString('hex')}`, id, item.source, trust, sha256(item.statement), item.evidenceAt ?? now, cleanTaint(item.taint));
  });
  return id;
}

/** Active items that do not read as expired: the only ones any recall shows. */
const SELECT = `SELECT id, scope, type, statement, support, helped, wrong, contradictions,
  coalesce(reinforced_at, valid_from) AS reinforced, anchors_json,
  (SELECT source_ref FROM evidence e WHERE e.item_id = items.id ORDER BY captured_at, id LIMIT 1) AS source,
  (SELECT group_concat(DISTINCT taint) FROM evidence e WHERE e.item_id = items.id AND taint IS NOT NULL) AS taint,
  origin_repository AS origin
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
  taint: string | null;
  origin: string | null;
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
    ...(r.taint === null ? {} : { taint: r.taint }),
    origin: r.origin,
  }));

/** The items of a tenant file one repository may see, given tenant, repository and owner. The tenant column is checked as well as the file. */
export const TENANT_SCOPE = "tenant = ? AND ((scope = 'repository' AND scope_key = ?) OR (scope = 'organisation' AND scope_key = ?))";
export const PERSON_SCOPE = "tenant = '' AND scope IN ('person', 'global')";

/** Active items of `tenant` for this repository and its owner. */
export function tenantItems(db: DatabaseSync, tenant: string, repository: string, owner: string): Visible[] {
  return visible(db.prepare(`${SELECT} AND ${TENANT_SCOPE}`).all(tenant, repository, owner) as unknown as Row[]);
}

/** The anchor paths a touch of `path` can hit: the path itself and each directory above it. */
const anchorPaths = (path: string): string[] => path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));

/**
 * Active items of `tenant` for this repository and its owner with an anchor at `path` or on a directory above it,
 * read through the anchor-path index: only those rows are loaded, and none when nothing is anchored there.
 */
export function anchoredItems(db: DatabaseSync, tenant: string, repository: string, owner: string, path: string): Visible[] {
  const paths = anchorPaths(path);
  const marks = paths.map(() => '?').join(', ');
  const ids = (db.prepare(`SELECT DISTINCT item_id FROM item_anchors WHERE path IN (${marks})`).all(...paths) as { item_id: string }[]).map((r) => r.item_id);
  if (ids.length === 0) return [];
  return visible(db.prepare(`${SELECT} AND ${TENANT_SCOPE} AND id IN (${ids.map(() => '?').join(', ')})`).all(tenant, repository, owner, ...ids) as unknown as Row[]);
}

/**
 * Active items of `tenant` for this repository and its owner with an anchor at `target` or under it, read through the
 * anchor-path index. A target with `#` is a symbol key: its file's items whose symbol starts with it. `depth` limits the
 * path segments below the target (0 is the target itself).
 */
export function anchoredUnder(db: DatabaseSync, tenant: string, repository: string, owner: string, target: string, depth = Infinity): Visible[] {
  const file = target.split('#')[0]!;
  const rows = db
    .prepare('SELECT DISTINCT item_id FROM item_anchors WHERE path = ? OR (path >= ? AND path < ?)')
    .all(file, `${file}/`, `${file}0`) as { item_id: string }[];
  if (rows.length === 0) return [];
  const items = visible(db.prepare(`${SELECT} AND ${TENANT_SCOPE} AND id IN (${rows.map(() => '?').join(', ')})`).all(tenant, repository, owner, ...rows.map((r) => r.item_id)) as unknown as Row[]);
  const inside = (a: Anchor): boolean =>
    target.includes('#')
      ? a.path === file && a.symbol?.startsWith(target) === true
      : a.path === target || (a.path.startsWith(`${target}/`) && a.path.slice(target.length + 1).split('/').length <= depth);
  return items.filter((i) => i.anchors.some(inside));
}

/** The id and statement of each active failure pattern and repair recipe this repository may see, and nothing else of them. */
export function failureStatements(db: DatabaseSync, tenant: string, repository: string, owner: string): { id: string; statement: string }[] {
  return db
    .prepare(`SELECT id, statement FROM items WHERE status = 'active' AND valid_to IS NULL AND NOT ${READS_EXPIRED} AND type IN ('failure-pattern', 'repair-recipe') AND ${TENANT_SCOPE}`)
    .all(tenant, repository, owner) as { id: string; statement: string }[];
}

/** The active items of these ids, whole, as the slice shows them. */
export const itemsById = (db: DatabaseSync, ids: string[]): Visible[] =>
  ids.length === 0 ? [] : visible(db.prepare(`${SELECT} AND id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as unknown as Row[]);

/** Active items of the person file; with `origin`, only those learned in that repository. */
export function personItems(db: DatabaseSync, origin?: string): Visible[] {
  return origin === undefined
    ? visible(db.prepare(`${SELECT} AND ${PERSON_SCOPE}`).all() as unknown as Row[])
    : visible(db.prepare(`${SELECT} AND ${PERSON_SCOPE} AND origin_repository = ?`).all(origin) as unknown as Row[]);
}

/** Every active item of `tenant`'s file, whatever repository it belongs to. */
export function allTenantItems(db: DatabaseSync, tenant: string): Visible[] {
  return visible(db.prepare(`${SELECT} AND tenant = ?`).all(tenant) as unknown as Row[]);
}

/**
 * Closes an active open question: it leaves recall at once and stays on record as closed. Only the owner's
 * `memory close` calls this; no MCP tool does. False when no active open question of that id is in `tenant`'s file.
 */
export function closeQuestion(db: DatabaseSync, id: string): boolean {
  return inTransaction(db, () => {
    const { changes } = db
      .prepare("UPDATE items SET status = 'closed', valid_to = ?, status_reason = 'closed by the owner' WHERE id = ? AND type = 'open_question' AND status = 'active'")
      .run(new Date().toISOString(), id);
    if (changes === 1) recordAudit(db, 'question_closed', { type: 'item', id }, {});
    return changes === 1;
  });
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
