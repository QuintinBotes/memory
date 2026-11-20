import type { DatabaseSync } from 'node:sqlite';
import { git } from './context.ts';
import { sha256, type Anchor } from './items.ts';
import { recordAudit } from './store/audit.ts';

/** How far, in lines, cited text may move within its file and still be found. */
const WINDOW = 50;

export type Citation = { ok: true; anchor: Anchor } | { ok: false; reason: 'path gone' | 'cited text gone' };

/**
 * Memory's default code anchor provider: a path, an optional line range and a
 * hash of the cited text, checked against the file at HEAD. `text` is that
 * file, or null when HEAD has no such path. Cited lines found nearby move the
 * anchor with them; the nearest copy wins.
 */
export function checkAnchor(anchor: Anchor, text: string | null): Citation {
  if (text === null) return { ok: false, reason: 'path gone' };
  if (anchor.start === undefined) {
    return sha256(text) === anchor.citedHash ? { ok: true, anchor } : { ok: false, reason: 'cited text gone' };
  }
  const lines = text === '' ? [] : text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const length = (anchor.end ?? anchor.start) - anchor.start + 1;
  for (let d = 0; d <= WINDOW; d++) {
    for (const start of d === 0 ? [anchor.start] : [anchor.start - d, anchor.start + d]) {
      if (start < 1 || start + length - 1 > lines.length) continue;
      if (sha256(lines.slice(start - 1, start - 1 + length).join('\n')) === anchor.citedHash) {
        return { ok: true, anchor: { ...anchor, start, end: start + length - 1 } };
      }
    }
  }
  return { ok: false, reason: 'cited text gone' };
}

export interface Recheck {
  checked: number;
  current: number;
  stale: number;
  restored: number;
}

/**
 * Checks the anchored repository items of `repository` in `tenant` against
 * HEAD of the checkout at `root`. A failing citation makes an active item
 * stale; a holding one restores a stale item and updates moved lines. Both
 * happen without the owner's yes: stale only lowers influence, and a restore
 * returns an item the owner approved to the state they approved.
 */
export function recheck(
  db: DatabaseSync,
  tenant: string,
  repository: string,
  root: string,
  statuses: readonly ('active' | 'stale')[],
  id?: string,
): Recheck {
  const rows = db
    .prepare(
      `SELECT id, status, anchors_json FROM items
       WHERE tenant = ? AND scope = 'repository' AND scope_key = ? AND anchors_json != '[]'
         AND status IN (${statuses.map(() => '?').join(', ')}) ${id === undefined ? '' : 'AND id = ?'}
       ORDER BY id`,
    )
    .all(tenant, repository, ...statuses, ...(id === undefined ? [] : [id])) as { id: string; status: string; anchors_json: string }[];

  const files = new Map<string, string | null>();
  const read = (path: string): string | null => {
    if (!files.has(path)) files.set(path, git(root, 'cat-file', 'blob', `HEAD:${path}`));
    return files.get(path)!;
  };

  const result: Recheck = { checked: rows.length, current: 0, stale: 0, restored: 0 };
  for (const row of rows) {
    const anchors = JSON.parse(row.anchors_json) as Anchor[];
    const checks = anchors.map((a) => checkAnchor(a, read(a.path)));
    const failed = checks.find((c) => !c.ok);
    if (failed !== undefined && !failed.ok) {
      result.stale++;
      if (row.status === 'active') {
        db.prepare("UPDATE items SET status = 'stale', status_reason = ? WHERE id = ?").run(failed.reason, row.id);
        recordAudit(db, 'item_stale', { type: 'item', id: row.id }, { reason: failed.reason });
      }
      continue;
    }
    result.current++;
    const moved = JSON.stringify(checks.map((c) => (c.ok ? c.anchor : null)));
    if (moved !== row.anchors_json) db.prepare('UPDATE items SET anchors_json = ? WHERE id = ?').run(moved, row.id);
    if (row.status === 'stale') {
      result.restored++;
      db.prepare("UPDATE items SET status = 'active', status_reason = NULL WHERE id = ?").run(row.id);
      recordAudit(db, 'item_restored', { type: 'item', id: row.id });
    }
  }
  return result;
}
