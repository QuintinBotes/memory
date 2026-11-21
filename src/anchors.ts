import type { DatabaseSync } from 'node:sqlite';
import { git } from './context.ts';
import { sha256, type Anchor } from './items.ts';
import { recordAudit } from './store/audit.ts';

/** How far, in lines, cited text may move within its file and still be found. */
const WINDOW = 50;

/** A file's lines, without the empty one after a final newline. Remembering and checking both use it. */
export function fileLines(text: string): string[] {
  const lines = text === '' ? [] : text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** The hash of lines `start` to `end`, counted from 1, as an anchor stores it. */
export const rangeHash = (lines: readonly string[], start: number, end: number): string =>
  sha256(lines.slice(start - 1, end).join('\n'));

export type Citation = { ok: true; anchor: Anchor } | { ok: false; reason: 'path gone' | 'cited text gone' };

/**
 * Memory's default code anchor provider: a path, an optional line range and a
 * hash of the cited text, checked against the file at HEAD. `text` is that
 * file, or null when HEAD has no such path. Cited lines found nearby move the
 * anchor with them, up to `window` lines away; the nearest copy wins.
 */
export function checkAnchor(anchor: Anchor, text: string | null, window = WINDOW): Citation {
  if (text === null) return { ok: false, reason: 'path gone' };
  // shortcut: a symbol anchor from a notes import is checked by its path only, until a code anchor provider checks the symbol (slice 9).
  if (anchor.citedHash === undefined) return { ok: true, anchor };
  if (anchor.start === undefined) {
    return sha256(text) === anchor.citedHash ? { ok: true, anchor } : { ok: false, reason: 'cited text gone' };
  }
  const lines = fileLines(text);
  const length = (anchor.end ?? anchor.start) - anchor.start + 1;
  for (let d = 0; d <= window && (anchor.start - d >= 1 || anchor.start + d + length - 1 <= lines.length); d++) {
    for (const start of d === 0 ? [anchor.start] : [anchor.start - d, anchor.start + d]) {
      if (start < 1 || start + length - 1 > lines.length) continue;
      if (rangeHash(lines, start, start + length - 1) === anchor.citedHash) {
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
  /** Every item that fails its citation now, with why, so the owner can find it. */
  staleItems: { id: string; reason: string }[];
}

const at = (a: Anchor): string => (a.start === undefined ? a.path : `${a.path}:${a.start}-${a.end ?? a.start}`);

/** One status change and its audit row, or neither. */
function transition(db: DatabaseSync, apply: () => boolean, audit: () => void): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = apply();
    if (changed) audit();
    db.exec('COMMIT');
    return changed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Checks the anchored repository items of `repository` in `tenant`, stale ones
 * included, against HEAD of the repository at `cwd` (a work tree, a
 * subdirectory or a bare clone). A failing citation makes an active item
 * stale; a holding one restores a stale item and updates moved lines. Session
 * start searches 50 lines either side; `memory recheck` passes a wider window,
 * so an item whose lines moved further can be restored by asking. Both happen without the
 * owner's yes: stale only lowers influence, and a restore returns an item to
 * the state the owner approved. A repository with no HEAD, or a file git
 * cannot read, changes nothing.
 */
export function recheck(
  db: DatabaseSync,
  tenant: string,
  repository: string,
  cwd: string,
  { id, window = WINDOW }: { id?: string | undefined; window?: number } = {},
): Recheck {
  const result: Recheck = { checked: 0, current: 0, stale: 0, restored: 0, staleItems: [] };
  const rows = db
    .prepare(
      `SELECT id, status, anchors_json FROM items
       WHERE tenant = ? AND scope = 'repository' AND scope_key = ? AND anchors_json != '[]'
         AND status IN ('active', 'stale') ${id === undefined ? '' : 'AND id = ?'}
       ORDER BY id`,
    )
    .all(tenant, repository, ...(id === undefined ? [] : [id])) as { id: string; status: string; anchors_json: string }[];
  // No anchored items, no git; no HEAD, nothing can be checked.
  if (rows.length === 0 || git(cwd, 'rev-parse', '--verify', '-q', 'HEAD') === null) return result;

  // HEAD:<path> is relative to the tree root, whatever directory git runs in.
  const files = new Map<string, string | null | undefined>();
  const read = (path: string): string | null | undefined => {
    if (!files.has(path)) {
      let text: string | null | undefined;
      try {
        text = git(cwd, 'cat-file', 'blob', `HEAD:${path}`);
      } catch {
        text = undefined;
      }
      files.set(path, text);
    }
    return files.get(path);
  };
  const toStale = db.prepare("UPDATE items SET status = 'stale', status_reason = ? WHERE id = ? AND status = 'active'");
  // Only a stale citation is restored here: an agent's stale report holds until the owner acts.
  const toActive = db.prepare(
    "UPDATE items SET status = 'active', status_reason = NULL WHERE id = ? AND status = 'stale' AND status_reason IN ('path gone', 'cited text gone')",
  );

  for (const row of rows) {
    const anchors = JSON.parse(row.anchors_json) as Anchor[];
    const texts = anchors.map((a) => read(a.path));
    if (texts.includes(undefined)) continue; // could not read: leave the item as it is
    result.checked++;
    const checks = anchors.map((a, i) => checkAnchor(a, texts[i] as string | null, window));
    const failed = checks.find((c) => !c.ok);
    if (failed !== undefined && !failed.ok) {
      result.stale++;
      result.staleItems.push({ id: row.id, reason: failed.reason });
      transition(
        db,
        () => toStale.run(failed.reason, row.id).changes === 1,
        () => recordAudit(db, 'item_stale', { type: 'item', id: row.id }, { reason: failed.reason }),
      );
      continue;
    }
    result.current++;
    const now = checks.map((c) => (c.ok ? c.anchor : anchors[0]!));
    const moved = JSON.stringify(now);
    if (moved !== row.anchors_json) {
      // Logged with the old and new lines, so a wrong move can be seen and undone by hand.
      transition(
        db,
        () => db.prepare('UPDATE items SET anchors_json = ? WHERE id = ?').run(moved, row.id).changes === 1,
        () => recordAudit(db, 'anchor_moved', { type: 'item', id: row.id }, { from: anchors.map(at), to: now.map(at) }),
      );
    }
    const restored = transition(
      db,
      () => toActive.run(row.id).changes === 1,
      () => recordAudit(db, 'item_restored', { type: 'item', id: row.id }),
    );
    if (restored) result.restored++;
  }
  return result;
}
