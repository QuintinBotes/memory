import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { git } from '../context.ts';
import { refusal } from '../gate.ts';
import { MAX_BYTES, PROMOTABLE, PROMOTE_SUPPORT, inside, resolveOthers, writeAtomic } from '../instructions.ts';
import type { Anchor } from '../items.ts';
import { READS_EXPIRED } from '../recall/rank.ts';
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
  status: 'open' | 'applied' | 'rejected' | 'resolved';
}

/**
 * The bar every proposal and every apply passes: the owner's own, untainted, active repository item with support and
 * no contradiction. `id` narrows it to one item.
 */
const BAR = `tenant = ? AND scope = 'repository' AND scope_key = ? AND status = 'active' AND valid_to IS NULL AND NOT ${READS_EXPIRED}
  AND origin_trust = 'owner' AND quarantine IS NULL AND support >= ${PROMOTE_SUPPORT} AND contradictions = 0
  AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = items.id AND e.taint IS NOT NULL)`;
interface Eligible {
  id: string;
  type: string;
  statement: string;
  anchors_json: string;
}
const eligible = (db: DatabaseSync, tenant: string, repository: string, id?: string): Eligible[] =>
  db.prepare(`SELECT id, type, statement, anchors_json FROM items WHERE ${BAR}${id === undefined ? '' : ' AND id = ?'} ORDER BY id`).all(tenant, repository, ...(id === undefined ? [] : [id])) as unknown as Eligible[];

/** An anchor whose provider lookup (slice 15) ran and found no test that executes the symbol. */
const untested = (item: Eligible): string | null =>
  (JSON.parse(item.anchors_json) as Anchor[]).find((a) => a.symbol !== undefined && a.testsAt !== undefined && a.test === undefined)?.symbol ?? null;

const FORBIDDEN_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'gemini.md', 'copilot-instructions.md']);

/** A path relative to the repository, or null when it is absolute or climbs out. */
export const insidePath = (rel: string): string | null => {
  const clean = normalize(rel);
  if (isAbsolute(rel) || clean === '..' || clean.startsWith('../') || clean.startsWith('..\\')) return null;
  const path = clean.replace(/\\/g, '/');
  const parts = path.toLowerCase().split('/');
  // A standards file is a plain document: never git's own files, an instruction file or a workflow, which run or steer an agent.
  const forbidden = parts[0] === '.git' || parts[0] === '.claude' || (parts[0] === '.github' && parts[1] === 'workflows') || FORBIDDEN_FILES.has(parts[parts.length - 1]!);
  return forbidden ? null : path;
};

/**
 * The committers' names of the last 500 commits, which a line must not carry.
 * shortcut: full names only, from the last 500 commits; a shallow clone sees fewer. Upgrade to the whole history if a name slips through. */
const committers = (top: string): string[] => [...new Set((git(top, 'log', '-n', '500', '--format=%an%n%cn') ?? '').split('\n').map((n) => n.trim()).filter((n) => n.length >= 3))];

/** Why this line must not be written to a repository file, or null. Names the kind, never the text. */
export function lineRefusal(statement: string, top: string): string | null {
  const why = refusal(statement);
  if (why !== null) return why;
  const names = committers(top);
  return names.some((n) => new RegExp(`(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(statement)) ? 'it names a committer' : null;
}

/** Stores a proposal for each item that passes the bar and has none yet, rejected ones included. Returns how many are new. */
export function propose(db: DatabaseSync, tenant: string, repository: string, top: string, file: string | null): number {
  let made = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO promotions (id, item_id, target, symbol, file, line, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  );
  inTransaction(db, () => {
    for (const item of eligible(db, tenant, repository)) {
      const symbol = untested(item);
      // Code no test executes asks for a test first; a line in a standards file is only for what a tool cannot check.
      const row =
        symbol !== null ? (['test', symbol, null, null] as const)
        : file !== null && PROMOTABLE.has(item.type) && lineRefusal(item.statement, top) === null
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

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/** The path to write, or throws: a symbolic link (dangling too), or a place that resolves outside the repository, is refused. */
function writable(top: string, rel: string): string {
  const clean = insidePath(rel);
  if (clean === null) throw new Error(`${rel} is outside the repository or not a place for a standards file; nothing was written`);
  const target = resolve(top, clean);
  if (exists(target) && lstatSync(target).isSymbolicLink()) throw new Error(`${clean} is a symbolic link; nothing was written. Edit the real file it points to`);
  let dir = dirname(target);
  while (!exists(dir)) dir = dirname(dir);
  let real: string;
  try {
    real = join(realpathSync(dir), relative(dir, target));
  } catch {
    throw new Error(`${clean} resolves outside the repository; nothing was written`);
  }
  if (!inside(realpathSync(top), real)) throw new Error(`${clean} resolves outside the repository; nothing was written`);
  return real;
}

/** The file's text without following a link, with the identity of what was read; null when it does not exist. Throws when too large or not UTF-8. */
function readPlain(path: string, name: string): { text: string; dev: number; ino: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error(`${name} is a symbolic link; nothing was written`);
    throw error;
  }
  try {
    const { dev, ino } = fstatSync(fd);
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_BYTES) throw new Error(`${name} is too large to edit (over ${MAX_BYTES / 1024} KB); nothing was written`);
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), dev, ino };
    } catch {
      throw new Error(`${name} is not valid UTF-8; nothing was written`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The owner's yes to a standards line: appends exactly the stored line and marks the item promoted into the file.
 * Throws a message when it cannot. A test proposal is not applied: the item stays until a test exists.
 */
export function applyPromotion(db: DatabaseSync, p: Promotion & { statement: string }, top: string, tenant: string, repository: string): string {
  if (p.status !== 'open') throw new Error(`${p.id} is already ${p.status}`);
  if (p.target === 'test') throw new Error(`${p.id} asks for a test, which only you can write; reject it, or it stops being proposed once a test executes the symbol`);
  // The whole bar again: the item may have been contradicted, tainted or edited since it was proposed.
  const [item] = eligible(db, tenant, repository, p.item_id);
  if (item === undefined || !PROMOTABLE.has(item.type)) throw new Error(`item ${p.item_id} no longer passes the bar for promotion; nothing was written`);
  const why = lineRefusal(item.statement, top);
  if (why !== null || `- ${item.statement.trim()}` !== p.line) throw new Error(`the line is refused (${why ?? 'the item changed since it was proposed'}); nothing was written`);
  const target = writable(top, p.file!);
  const read = readPlain(target, p.file!);
  const text = read?.text ?? '';
  if (text.split('\n').some((l) => l.replace(/\r$/, '') === p.line)) throw new Error(`${p.file} already holds that line; nothing was written`);
  mkdirSync(dirname(target), { recursive: true });
  // The file must still be the one that was read (not swapped for a link) at the moment it is replaced.
  if (read !== null) {
    const now = lstatSync(target);
    if (now.isSymbolicLink() || now.dev !== read.dev || now.ino !== read.ino) throw new Error(`${p.file} changed while it was being read; nothing was written`);
  }
  writeAtomic(target, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${p.line}\n`);
  const now = new Date().toISOString();
  inTransaction(db, () => {
    db.prepare("UPDATE promotions SET status = 'applied', resolved_at = ? WHERE id = ?").run(now, p.id);
    resolveOthers(db, p.item_id, p.id, now);
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
