import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { git } from '../context.ts';
import { refusal } from '../gate.ts';
import { PROMOTABLE, PROMOTE_SUPPORT, inside, readWhole, writeAtomic } from '../instructions.ts';
import { tenantItems, type Visible } from '../items.ts';
import { safe } from '../render/rows.ts';
import { recordAudit } from '../store/audit.ts';
import { inTransaction } from '../store/transaction.ts';

/**
 * Promotion (#19): an item that keeps proving itself becomes a check. A proposal is stored and shown; only
 * `memory promote --apply`, run by the owner in a terminal, writes a file, and it never commits or pushes. A rejected
 * proposal stays as a row, so the same promotion is never proposed again.
 * shortcut: two targets, a review-standards line and a test. The Review Voice policy and Orbit check targets are
 * not proposed; add them when those tools say where such a line goes.
 */
export const DEFAULT_STANDARDS = 'docs/review-standards.md';

export interface Promotion {
  id: string;
  item_id: string;
  target: 'review-standards' | 'test';
  /** The symbol a test proposal names; empty for a standards line. */
  symbol: string;
  /** The file a standards line goes to, relative to the repository; null for a test. */
  file: string | null;
  /** The exact line added. */
  line: string | null;
  status: 'open' | 'applied' | 'rejected';
}

/** An anchor whose provider lookup (slice 15) ran and found no test that executes the symbol. */
const untested = (item: Visible): string | null =>
  item.anchors.find((a) => a.symbol !== undefined && a.testsAt !== undefined && a.test === undefined)?.symbol ?? null;

/** A path relative to the repository, or null when it is absolute or climbs out. */
export const insidePath = (rel: string): string | null => {
  const clean = normalize(rel);
  return isAbsolute(rel) || clean === '..' || clean.startsWith('../') || clean.startsWith('..\\') ? null : clean.replace(/\\/g, '/');
};

/** The committers' names of the last 500 commits, which a line must not carry. */
const committers = (top: string): string[] => [...new Set((git(top, 'log', '-n', '500', '--format=%an%n%cn') ?? '').split('\n').map((n) => n.trim()).filter((n) => n.length >= 3))];

/** Why this line must not be written to a repository file, or null. Names the kind, never the text. */
export function lineRefusal(statement: string, top: string): string | null {
  const why = refusal(statement);
  if (why !== null) return why;
  const names = committers(top);
  return names.some((n) => new RegExp(`(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(statement)) ? 'it names a committer' : null;
}

/** Stores a proposal for each item that passes the bar and has none yet, rejected ones included. Returns how many are new. */
export function propose(db: DatabaseSync, tenant: string, repository: string, owner: string, top: string, file: string | null): number {
  let made = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO promotions (id, item_id, target, symbol, file, line, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  );
  inTransaction(db, () => {
    for (const item of tenantItems(db, tenant, repository, owner).filter((i) => i.scope === 'repository')) {
      const symbol = untested(item);
      // Code no test executes asks for a test first; a line in a standards file is only for what a tool cannot check.
      const row =
        symbol !== null ? (['test', symbol, null, null] as const)
        : file !== null && item.support >= PROMOTE_SUPPORT && item.contradictions === 0 && PROMOTABLE.has(item.type) && lineRefusal(item.statement, top) === null
          ? (['review-standards', '', file, `- ${item.statement.trim()}`] as const)
          : null;
      if (row === null) continue;
      const id = `p-${randomBytes(5).toString('hex')}`;
      if (Number(insert.run(id, item.id, row[0], row[1], row[2], row[3], new Date().toISOString()).changes) === 1) {
        made++;
        recordAudit(db, 'promotion_proposed', { type: 'item', id: item.id }, { promotion: id, target: row[0] });
      }
    }
  });
  return made;
}

export function promotions(db: DatabaseSync, id?: string): (Promotion & { statement: string })[] {
  return db
    .prepare(
      `SELECT p.id, p.item_id, p.target, p.symbol, p.file, p.line, p.status, i.statement
       FROM promotions p JOIN items i ON i.id = p.item_id ${id === undefined ? '' : 'WHERE p.id = ?'} ORDER BY p.created_at, p.id`,
    )
    .all(...(id === undefined ? [] : [id])) as unknown as (Promotion & { statement: string })[];
}

/** The proposal as the owner reads it: its target and the exact line or the symbol to cover. */
export function renderPromotion(p: Promotion): string {
  const next = p.status === 'open' ? [`  ${p.target === 'test' ? '' : `apply: memory promote --apply ${p.id}   `}reject: memory promote --reject ${p.id}`] : [];
  const head =
    p.target === 'test'
      ? `[${p.id}] test, ${p.status}: item [${p.item_id}] sits on a symbol no test executes; write a test for ${safe(p.symbol)}`
      : `[${p.id}] review-standards, ${p.status}: item [${p.item_id}] has proved itself; proposed for ${safe(p.file!)}`;
  return [head, ...(p.target === 'test' ? [] : [`@@ ${safe(p.file!)} (end of file) @@`, `+${safe(p.line!)}`]), ...next].join('\n') + '\n';
}

/** The path to write, or throws: a symbolic link, or a place that resolves outside the repository, is refused. */
function writable(top: string, rel: string): string {
  const clean = insidePath(rel);
  if (clean === null) throw new Error(`${rel} is outside the repository; nothing was written`);
  const target = resolve(top, clean);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`${clean} is a symbolic link; nothing was written. Edit the real file it points to`);
  let dir = dirname(target);
  while (!existsSync(dir)) dir = dirname(dir);
  const real = join(realpathSync(dir), relative(dir, target));
  if (!inside(realpathSync(top), real)) throw new Error(`${clean} resolves outside the repository; nothing was written`);
  return real;
}

/**
 * The owner's yes to a standards line: appends exactly the stored line and marks the item promoted into the file.
 * Throws a message when it cannot. A test proposal is not applied: the item stays until a test exists.
 */
export function applyPromotion(db: DatabaseSync, p: Promotion & { statement: string }, top: string): string {
  if (p.status !== 'open') throw new Error(`${p.id} is already ${p.status}`);
  if (p.target === 'test') throw new Error(`${p.id} asks for a test, which only you can write; reject it, or it stops being proposed once a test executes the symbol`);
  const active = db.prepare("SELECT 1 FROM items WHERE id = ? AND status = 'active'").get(p.item_id);
  if (active === undefined) throw new Error(`item ${p.item_id} is no longer active; nothing was written`);
  const why = lineRefusal(p.statement, top);
  if (why !== null || `- ${p.statement.trim()}` !== p.line) throw new Error(`the line is refused (${why ?? 'the item changed since it was proposed'}); nothing was written`);
  const target = writable(top, p.file!);
  const text = existsSync(target) ? readWhole(target, p.file!) : '';
  if (text.split('\n').some((l) => l.replace(/\r$/, '') === p.line)) throw new Error(`${p.file} already holds that line; nothing was written`);
  mkdirSync(dirname(target), { recursive: true });
  writeAtomic(target, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${p.line}\n`);
  const now = new Date().toISOString();
  inTransaction(db, () => {
    db.prepare("UPDATE promotions SET status = 'applied', resolved_at = ? WHERE id = ?").run(now, p.id);
    db.prepare("UPDATE items SET status = 'promoted', valid_to = ?, status_reason = ?, promoted_to = ? WHERE id = ?").run(now, `promoted to ${p.file}`, p.file, p.item_id);
    recordAudit(db, 'promotion_applied', { type: 'item', id: p.item_id }, { promotion: p.id, target: p.target });
  });
  return `wrote ${p.file}; ${p.item_id} is promoted into it and leaves recall. Nothing was committed: review the file and commit it yourself`;
}

/** The owner's no: the proposal is kept as a tombstone, so it is never proposed again. */
export function rejectPromotion(db: DatabaseSync, p: Promotion): void {
  if (p.status !== 'open') throw new Error(`${p.id} is already ${p.status}`);
  inTransaction(db, () => {
    db.prepare("UPDATE promotions SET status = 'rejected', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), p.id);
    recordAudit(db, 'promotion_rejected', { type: 'item', id: p.item_id }, { promotion: p.id });
  });
}
