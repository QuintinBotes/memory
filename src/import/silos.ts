import { isAbsolute, normalize } from 'node:path';

/**
 * Readers for the silos `memory import` reads. Each returns the statements a
 * file holds, with their line, and touches nothing else; deciding where a
 * statement goes, and whether it may be stored, is the importer's job.
 */

export interface Statement {
  line: number;
  text: string;
  /** Notes: the item type its kind maps to, and its symbol key. */
  type?: string;
  symbol?: string;
  /** Rejections: when it was rejected. Notes: when the evidence happened. */
  at?: string;
  /** Codex's MEMORY.md: the working directory its task group applies to. */
  cwd?: string;
}

export interface Parsed {
  statements: Statement[];
  /** Markdown: relative links to other files, for the dangling-link check. */
  links: string[];
  /** Lines that are not what the format says, reported by line. */
  unreadable: number[];
  /** Notes of a kind memory does not import. */
  skippedNotes: number;
}

const parsed = (statements: Statement[], rest: Partial<Parsed> = {}): Parsed => ({ statements, links: [], unreadable: [], skippedNotes: 0, ...rest });

/** A YAML scalar as written on one line, without its quotes. */
function unquote(v: string): string {
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (!/^".*"$/.test(v)) return v;
  try {
    return JSON.parse(v) as string; // Review Voice writes each rule with JSON.stringify
  } catch {
    return v.slice(1, -1);
  }
}

const lines = (text: string): string[] => text.split(/\r?\n/);

/**
 * A Markdown silo. A file with frontmatter (an auto memory topic file) holds
 * one statement, its `description`; the body is detail the model wrote. Any
 * other file (an auto memory index, a review-standards file) holds its list
 * items, except an item that is a link to another file, which is a pointer.
 */
export function markdown(text: string): Parsed {
  const all = lines(text);
  if (all[0]?.trim() === '---') {
    const end = all.findIndex((l, i) => i > 0 && l.trim() === '---');
    for (let i = 1; i < end; i++) {
      const m = /^description:\s*(.*?)\s*$/.exec(all[i]!);
      // A folded or literal block (> or |) is not one line; it is not read.
      if (m && m[1] !== '' && !/^[>|]/.test(m[1]!)) return parsed([{ line: i + 1, text: unquote(m[1]!) }]);
    }
    return parsed([]);
  }
  const statements: Statement[] = [];
  const links: string[] = [];
  let fenced = false;
  all.forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const item = fenced ? null : /^\s*[-*+]\s+(.*\S)\s*$/.exec(line);
    if (!item) return;
    const link = /^\[[^\]]*\]\(([^)\s]+)\)/.exec(item[1]!);
    if (link === null) statements.push({ line: i + 1, text: item[1]! });
    else if (!/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link[1]!)) links.push(link[1]!);
  });
  return parsed(statements, { links });
}

const POLICY_KEYS = new Set(['suppressed_patterns', 'required_checks']);

/** A Review Voice policy file: the strings under `suppressed_patterns` and `required_checks`. */
export function policy(text: string): Parsed {
  const statements: Statement[] = [];
  let key = '';
  lines(text).forEach((line, i) => {
    const top = /^([A-Za-z_][\w-]*):/.exec(line);
    if (top) key = top[1]!;
    const item = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (!top && item && POLICY_KEYS.has(key)) statements.push({ line: i + 1, text: unquote(item[1]!) });
  });
  return parsed(statements);
}

/** One JSON object per line; blank lines are skipped. */
function jsonLines(text: string, each: (entry: Record<string, unknown>, line: number) => boolean): number[] {
  const unreadable: number[] = [];
  lines(text).forEach((raw, i) => {
    if (raw.trim() === '') return;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      // counted below
    }
    const ok = typeof entry === 'object' && entry !== null && !Array.isArray(entry) && each(entry as Record<string, unknown>, i + 1);
    if (!ok) unreadable.push(i + 1);
  });
  return unreadable;
}

/** stack-retro's record of rejected proposals: `{kind, text, at}` per line. */
export function rejections(text: string): Parsed {
  const statements: Statement[] = [];
  const unreadable = jsonLines(text, (e, line) => {
    if (typeof e['text'] !== 'string' || e['text'].trim() === '') return false;
    const at = typeof e['at'] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e['at']) && !Number.isNaN(Date.parse(e['at'])) ? e['at'] : undefined;
    statements.push({ line, text: e['text'].trim(), ...(at !== undefined ? { at: new Date(at).toISOString() } : {}) });
    return true;
  });
  return parsed(statements, { unreadable });
}

/** The note kinds that correct an agent, and the item type each becomes. Others describe code and stay in their tool. */
const NOTE_TYPES: Record<string, string> = { gotcha: 'hazard', invariant: 'convention', decision: 'decision' };
export const SYMBOL_KEY = /^([^#\s]+)#[^#\n]+#[^#\s]+$/;

/** Memory's notes import format: `{kind, text, symbol?, at?}` per line, `at` being when the evidence happened, the symbol key as `path#qualified_name#kind`. */
export function notes(text: string): Parsed {
  const statements: Statement[] = [];
  let skippedNotes = 0;
  const unreadable = jsonLines(text, (e, line) => {
    const { kind, text: body, symbol } = e;
    if (typeof kind !== 'string' || typeof body !== 'string' || body.trim() === '') return false;
    if (symbol !== undefined && (typeof symbol !== 'string' || !SYMBOL_KEY.test(symbol) || !inside(symbolPath(symbol)))) return false;
    const type = Object.hasOwn(NOTE_TYPES, kind) ? NOTE_TYPES[kind] : undefined;
    if (type === undefined) {
      skippedNotes++;
      return true;
    }
    const at = typeof e['at'] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e['at']) && !Number.isNaN(Date.parse(e['at'])) ? new Date(e['at']).toISOString() : undefined;
    statements.push({ line, text: body.trim(), type, ...(symbol !== undefined ? { symbol } : {}), ...(at !== undefined ? { at } : {}) });
    return true;
  });
  return parsed(statements, { unreadable, skippedNotes });
}

/** The sections of Codex's memory files that hold lessons; the others are task lists, keywords, a profile or pointers. */
const CODEX_SECTIONS = new Set(['user preferences', 'reusable knowledge', 'failures and how to do differently', 'general tips']);

/**
 * One of Codex's memory files, in the layout its consolidation prompt writes (codex-rs/memories/write/templates): MEMORY.md
 * is `# Task Group:` blocks, each with `applies_to: cwd=<path>`, and memory_summary.md starts with the line `v1`. Each `-`
 * item under a lesson section is a statement, without its `[Task n]` references. Any other layout is a string saying so:
 * the reader does not guess.
 */
export function codexMemory(name: string, text: string): Parsed | string {
  const all = lines(text);
  const summary = name === 'memory_summary.md';
  if (summary ? all[0] !== 'v1' : !all.some((l) => /^# Task Group:/.test(l))) return 'not a layout of Codex memories that memory knows; not read';
  const statements: Statement[] = [];
  let section = '';
  let cwd: string | undefined;
  all.forEach((line, i) => {
    if (/^# Task Group:/.test(line)) [section, cwd] = ['', undefined];
    const applies = /^applies_to:\s*cwd=([^;]+)/.exec(line);
    if (applies !== null && !summary) cwd = applies[1]!.trim();
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (heading !== null) section = heading[1]!.toLowerCase();
    const item = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (heading !== null || item === null || !CODEX_SECTIONS.has(section)) return;
    const body = item[1]!.replace(/(?:\s*\[Task \d+\])+$/, '').trim();
    if (body !== '') statements.push({ line: i + 1, text: body, ...(cwd !== undefined ? { cwd } : {}) });
  });
  return parsed(statements);
}

export const symbolPath = (symbol: string): string => SYMBOL_KEY.exec(symbol)![1]!;

/** A relative path that stays inside its root. */
export const inside = (path: string): boolean => !isAbsolute(path) && !normalize(path).split(/[\\/]/).includes('..');
