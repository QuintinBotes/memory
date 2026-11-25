import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { repeats } from './consolidate.ts';
import { visibleText } from './codefree.ts';
import { git } from './context.ts';
import type { Visible } from './items.ts';
import { defang, safe } from './render/rows.ts';
import { recordAudit } from './store/audit.ts';

/**
 * Instruction files (CLAUDE.md, AGENTS.md and the like) are the source of truth: the agent loads them whole. Memory
 * reads them, read-only and deterministically, to leave out what they already say and what they contradict. It never
 * writes one on its own: a contradiction or a promotion is a stored proposal, and only `memory conflicts apply
 * --confirm`, run by the owner in a terminal, changes a file. Their text is never an item and never evidence.
 */

/** Files an agent loads from a repository root; an @-import of any of them is followed too. */
const ROOT_FILES = ['AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md'];
/** Files Claude Code loads from the working directory and each parent up to the repository root. */
const DIR_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'];
/** An instruction file is matched only up to this many bytes. */
const MAX_BYTES = 256 * 1024;
const MAX_IMPORT_DEPTH = 5;
/** Owner-approved support from which an item that no tool can check is proposed for an instruction file. */
export const PROMOTE_SUPPORT = 3;
export const PROMOTABLE = new Set(['convention', 'preference', 'decision']);

export interface InstructionLine {
  file: string;
  line: number;
  raw: string;
  text: string;
}

export interface Instructions {
  /** The repository root, or null outside one. */
  top: string | null;
  lines: InstructionLine[];
  /** Every path an edit may name: the loaded files and where a promotion would go. */
  allowed: Set<string>;
  repositoryTarget: string | null;
  userTarget: string;
}

export const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The file's text up to `MAX_BYTES`, or null when it is missing, not a file, or reaches outside `root` through a link. */
function readInside(path: string, root: string): string | null {
  try {
    const real = realpathSync(path);
    if (!inside(realpathSync(root), real) || !statSync(real).isFile()) return null;
    return readFileSync(real).subarray(0, MAX_BYTES).toString('utf8');
  } catch {
    return null;
  }
}

/** The `@path` imports of a file, outside code fences and code spans, as Claude Code expands them. */
function importsOf(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(?:^|\s)@(\S+)/g)) out.push(m[1]!.replace(/[.,;:)]+$/, ''));
  }
  return out;
}

const NEGATORS = new Set(['not', 'no', 'never', 'cannot', 'without', 'avoid', 'optional', 'skip', 'unnecessary', 'forbidden', 'prohibited', 'ignore', 'disable']);
const STOP = new Set(
  'a an the is are be been to of in on for and or before after every each any all this that with it we you your our at by from as when then if so do does did should must shall will can may always only also use using'.split(' '),
);

/** Lower-case words, with "don't" read as "do not", and a plural read as its singular. */
const tokens = (text: string): string[] =>
  (visibleText(text).toLowerCase().replace(/n't\b/g, ' not').match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/** True when the statement is a prohibition or a waiver: an odd number of negators. */
const negative = (text: string): boolean => tokens(text).filter((w) => NEGATORS.has(w)).length % 2 === 1;
const subject = (text: string): Set<string> => new Set(tokens(text).filter((w) => !STOP.has(w) && !NEGATORS.has(w)));

/**
 * Two statements share a subject when at least two content words are common and they cover 80% of the shorter.
 * shortcut: words, not meaning; a paraphrase with other words is missed, and a shared-word pair can read as one subject.
 * Upgrade to a model only if the owner's replay shows misses.
 */
function sameSubject(a: string, b: string): boolean {
  const [x, y] = [subject(a), subject(b)];
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared >= 2 && shared / Math.min(x.size, y.size) >= 0.8;
}

/** A scoped statement ("only when docs changed", "for hot paths") is an exception, not a flat opposite. */
const scoped = (text: string): boolean => /\b(when|whenever|only|unless|except|if)\b|\bfor\s+\S/i.test(text);

/** One line as a statement: no list marker, heading, quote or emphasis; null for a line too short to be one. */
function statementOf(raw: string): string | null {
  const text = visibleText(raw).replace(/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/, '').replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  return text.split(/\s+/).length >= 3 ? text : null;
}

function linesOf(file: string, text: string): InstructionLine[] {
  const out: InstructionLine[] = [];
  let fenced = false;
  for (const [i, raw] of text.split('\n').entries()) {
    if (/^\s{0,3}(```|~~~)/.test(raw)) fenced = !fenced;
    if (fenced || /^\s*@\S+\s*$/.test(raw)) continue;
    const statement = statementOf(raw.replace(/\r$/, ''));
    if (statement !== null) out.push({ file, line: i + 1, raw: raw.replace(/\r$/, ''), text: statement });
  }
  return out;
}

/**
 * The instruction files an agent in `cwd` loads: CLAUDE.md files from here up to the repository root, the root's
 * AGENTS.md, GEMINI.md and Copilot file, the user's CLAUDE.md in the config directory, and every @-import of those, up
 * to five deep. A file or import that leaves its root (the repository, or the home directory for the user's file) is not read.
 */
export function loadInstructions(cwd: string, configDir: string): Instructions {
  const top = git(cwd, 'rev-parse', '--show-toplevel')?.trim() ?? null;
  const lines: InstructionLine[] = [];
  const allowed = new Set<string>();
  const seen = new Set<string>();
  const read = (path: string, root: string, depth: number): void => {
    const abs = resolve(path);
    if (seen.has(abs)) return;
    seen.add(abs);
    const text = readInside(abs, root);
    if (text === null) return;
    allowed.add(abs);
    lines.push(...linesOf(abs, text));
    if (depth >= MAX_IMPORT_DEPTH) return;
    for (const target of importsOf(text)) {
      const to = target.startsWith('~/') ? join(homedir(), target.slice(2)) : isAbsolute(target) ? target : resolve(dirname(abs), target);
      read(to, root, depth + 1);
    }
  };
  const userTarget = join(configDir, 'CLAUDE.md');
  if (top !== null) {
    const start = resolve(cwd);
    for (let dir = inside(top, start) ? start : top; ; dir = dirname(dir)) {
      for (const f of DIR_FILES) read(join(dir, f), top, 1);
      if (dir === top || dirname(dir) === dir) break;
    }
    for (const f of ROOT_FILES) read(join(top, f), top, 1);
  }
  read(userTarget, homedir(), 1);
  const repositoryTarget = top === null ? null : [join(top, 'CLAUDE.md'), join(top, 'AGENTS.md')].find((p) => existsSync(p)) ?? join(top, 'CLAUDE.md');
  if (repositoryTarget !== null) allowed.add(repositoryTarget);
  allowed.add(userTarget);
  return { top, lines, allowed, repositoryTarget, userTarget };
}

/** How a file is named to the owner: relative to the repository, or with `~`. */
export const displayPath = (ins: Pick<Instructions, 'top'>, file: string): string => {
  if (ins.top !== null && inside(ins.top, file)) return relative(ins.top, file);
  const home = homedir();
  return inside(home, file) ? `~${sep}${relative(home, file)}` : file;
};

export type Verdict = { kind: 'repeats' | 'contradicts'; line: InstructionLine };

/** What the loaded files say about one statement: it repeats a line, contradicts one, or neither. A repeat wins over a contradiction. */
export function judge(ins: Instructions, statement: string): Verdict | null {
  const polarity = negative(statement);
  const flat = !scoped(statement);
  const same = ins.lines.find((l) => negative(l.text) === polarity && repeats(statement, l.text));
  if (same !== undefined) return { kind: 'repeats', line: same };
  const against = ins.lines.find((l) => flat && negative(l.text) !== polarity && !scoped(l.text) && sameSubject(statement, l.text));
  return against === undefined ? null : { kind: 'contradicts', line: against };
}

/** An item recall left out, and why, for the injection log. */
export interface Withheld {
  item: Visible;
  reason: 'repeats' | 'contradicts';
}

/** The list marker and indent of a line, kept when the item's statement replaces it. */
const marker = (raw: string): string => /^\s*(?:[-*+]|\d+[.)])?\s*/.exec(raw)![0];

/** The edit that makes a file say what the item says: the contradicted line, replaced. */
function conflictEdit(line: InstructionLine, statement: string): string {
  const end = /[.;]\s*$/.test(line.raw) && !/[.;]\s*$/.test(statement) ? '.' : '';
  return `${marker(line.raw)}${statement.trim()}${end}`;
}

function propose(db: DatabaseSync, kind: 'conflict' | 'promotion', item: Visible, file: string, line: number, oldLine: string, newLine: string): void {
  const id = `c-${randomBytes(5).toString('hex')}`;
  const { changes } = db
    .prepare(`INSERT OR IGNORE INTO instruction_edits (id, kind, item_id, file, line, old_line, new_line, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, kind, item.id, file, line, oldLine, newLine, new Date().toISOString());
  if (Number(changes) === 1) recordAudit(db, 'instruction_edit_proposed', { type: 'item', id: item.id }, { kind, edit: id });
}

/**
 * `items` without those a loaded instruction file repeats or contradicts, which go to `withheld`. A contradiction and
 * an item proven by the owner's support (and with no anchor a tool could check) become stored proposals for the owner.
 * A store that is busy or read-only costs the proposals, never the recall.
 */
export function screen(db: DatabaseSync, items: Visible[], ins: Instructions, personal: boolean, withheld: Withheld[]): Visible[] {
  const kept: Visible[] = [];
  for (const item of items) {
    const verdict = judge(ins, item.statement);
    if (verdict === null) {
      kept.push(item);
      try {
        const target = personal ? ins.userTarget : ins.repositoryTarget;
        if (target !== null && item.support >= PROMOTE_SUPPORT && PROMOTABLE.has(item.type) && item.anchors.length === 0) {
          propose(db, 'promotion', item, target, 0, '', `- ${item.statement.trim()}`);
        }
      } catch {
        // The proposal is retried at the next recall.
      }
      continue;
    }
    withheld.push({ item, reason: verdict.kind });
    if (verdict.kind === 'contradicts') {
      try {
        propose(db, 'conflict', item, verdict.line.file, verdict.line.line, verdict.line.raw, conflictEdit(verdict.line, item.statement));
      } catch {
        // As above.
      }
    }
  }
  return kept;
}

export interface Edit {
  id: string;
  kind: 'conflict' | 'promotion';
  item_id: string;
  statement: string;
  file: string;
  line: number;
  old_line: string;
  new_line: string;
  status: 'open' | 'applied' | 'resolved';
}

export function edits(db: DatabaseSync, id?: string): Edit[] {
  return db
    .prepare(
      `SELECT e.id, e.kind, e.item_id, i.statement, e.file, e.line, e.old_line, e.new_line, e.status
       FROM instruction_edits e JOIN items i ON i.id = e.item_id ${id === undefined ? '' : 'WHERE e.id = ?'} ORDER BY e.created_at, e.id`,
    )
    .all(...(id === undefined ? [] : [id])) as unknown as Edit[];
}

/** The edit as a diff against its file, every line defanged: the item's text is data, not instructions. */
export function renderEdit(ins: Pick<Instructions, 'top'>, e: Edit): string {
  const name = safe(displayPath(ins, e.file));
  const where = e.kind === 'conflict' ? `${name}:${e.line}` : name;
  const head = e.kind === 'conflict'
    ? `[${e.id}] conflict, ${e.status}: item [${e.item_id}] contradicts ${where}; the file wins and the item is not recalled`
    : `[${e.id}] promotion, ${e.status}: item [${e.item_id}] has proved itself; proposed for ${where}`;
  const body = e.kind === 'conflict'
    ? [`@@ ${where} @@`, `-${defang(e.old_line)}`, `+${defang(e.new_line)}`]
    : [`@@ ${name} (end of file) @@`, `+${defang(e.new_line)}`];
  const next = e.status === 'open' ? [`  apply: memory conflicts apply ${e.id} --confirm   reject: memory conflicts reject ${e.id}`] : [];
  return [head, ...body.map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')), ...next].join('\n') + '\n';
}

/** Why `e` cannot be applied to its file now, or null. Run before anything is written. */
function applyRefusal(ins: Instructions, e: Edit, text: string | null): string | null {
  if (!ins.allowed.has(resolve(e.file))) return `${displayPath(ins, e.file)} is not an instruction file of this repository or config; nothing was written`;
  if (e.status !== 'open') return `${e.id} is already ${e.status}`;
  if (e.kind === 'promotion') return text !== null && text.split('\n').some((l) => l.replace(/\r$/, '') === e.new_line) ? `${displayPath(ins, e.file)} already holds that line` : null;
  const at = text?.split('\n')[e.line - 1]?.replace(/\r$/, '');
  return at === e.old_line ? null : `${displayPath(ins, e.file)} changed since this edit was proposed (line ${e.line} is not what it was); nothing was written`;
}

/** The path to write for `file`, or throws: the user's own file must not be a link; a repository file must stay inside the repository. */
function writableTarget(ins: Instructions, file: string): string {
  const name = displayPath(ins, file);
  if (file === resolve(ins.userTarget)) {
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`${name} is a symbolic link; nothing was written. Edit the real file it points to`);
    return file;
  }
  if (ins.top === null) throw new Error(`${name} is not inside a repository; nothing was written`);
  const real = existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file));
  if (!inside(realpathSync(ins.top), real)) throw new Error(`${name} resolves outside the repository; nothing was written`);
  return real;
}

/** The whole file as text, or throws when it is over the cap or not valid UTF-8: a lossy rewrite would damage it. */
export function readWhole(path: string, name: string): string {
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw new Error(`${name} is too large to edit (over ${MAX_BYTES / 1024} KB); nothing was written`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} is not valid UTF-8; nothing was written`);
  }
}

/** Temp file in the same directory, then rename: the file is whole either way. Keeps the mode of an existing file. */
export function writeAtomic(path: string, content: string): void {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error(`${basename(path)} would exceed ${MAX_BYTES / 1024} KB; nothing was written`);
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: 'wx' });
    if (existsSync(path)) chmodSync(tmp, statSync(path).mode & 0o7777);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never created.
    }
    throw error;
  }
}

/**
 * The owner's yes: writes the stored edit to its file, exactly, and marks the item superseded by the file (a
 * conflict) or promoted into it. The one place memory writes an instruction file. Throws a message when it cannot.
 */
export function applyEdit(db: DatabaseSync, ins: Instructions, e: Edit): string {
  const file = resolve(e.file);
  if (!ins.allowed.has(file)) throw new Error(applyRefusal(ins, e, null)!);
  const target = writableTarget(ins, file);
  const text = existsSync(target) ? readWhole(target, displayPath(ins, file)) : null;
  const why = applyRefusal(ins, e, text);
  if (why !== null) throw new Error(why);
  if (e.kind === 'conflict') {
    const lines = text!.split('\n');
    lines[e.line - 1] = e.new_line + (lines[e.line - 1]!.endsWith('\r') ? '\r' : '');
    writeAtomic(target, lines.join('\n'));
  } else {
    const base = text ?? '';
    writeAtomic(target, `${base}${base === '' || base.endsWith('\n') ? '' : '\n'}${e.new_line}\n`);
  }
  const now = new Date().toISOString();
  const name = displayPath(ins, file);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE instruction_edits SET status = 'applied', resolved_at = ? WHERE id = ?").run(now, e.id);
    db.prepare("UPDATE items SET status = ?, valid_to = ?, status_reason = ?, promoted_to = ? WHERE id = ?").run(
      e.kind === 'conflict' ? 'superseded' : 'promoted', now, e.kind === 'conflict' ? `superseded by ${name}` : `promoted to ${name}`, e.kind === 'promotion' ? name : null, e.item_id,
    );
    recordAudit(db, 'instruction_edit_applied', { type: 'item', id: e.item_id }, { kind: e.kind, edit: e.id });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return `wrote ${name}; ${e.item_id} is ${e.kind === 'conflict' ? `superseded by ${name}` : `promoted into ${name} and leaves recall`}`;
}

/** The owner's no: the proposal is resolved and the file is not touched. A conflicting item stays withheld, as the file still wins. */
export function rejectEdit(db: DatabaseSync, e: Edit): void {
  if (e.status !== 'open') throw new Error(`${e.id} is already ${e.status}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE instruction_edits SET status = 'resolved', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), e.id);
    recordAudit(db, 'instruction_edit_rejected', { type: 'item', id: e.item_id }, { kind: e.kind, edit: e.id });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
