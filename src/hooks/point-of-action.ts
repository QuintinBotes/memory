import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileLines, rangeHash } from '../anchors.ts';
import { recallOn, currentConfigDir, loadConfig, subagentAllowed, type Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { git, resolveContext } from '../context.ts';
import { anchoredItems, type Anchor, type Visible } from '../items.ts';
import { ITEMS_LABEL, fence, safe } from '../render/rows.ts';
import { chooseSlice, estimate, row } from '../slice.ts';
import { HOOK_BUSY_MS, openStore } from '../store/db.ts';
import { MAIN_AGENT, claim, resetMain, shownIn } from '../store/ledger.ts';
import { tenantFile } from '../store/paths.ts';

/** What one injection may take, fence included. */
export const INJECTION_BUDGET = 120;
/** What PreCompact prints at most, fence included. */
export const COMPACT_CHARS = 1000;

type Input = Record<string, unknown>;
export type Log = (lines: object[]) => void;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined);

/** What a tool call touches: the whole file, or the lines it reads, or the text it replaces. */
interface Touch {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  ranges: [number, number][] | null;
  replaced: string[];
}

/** The hook's on switch: one of `switches` is configured on, and the owner's consent covers the injection log. */
export function enabled(data: string, switches: ('pointOfAction' | 'promptRecall')[] = ['pointOfAction']): Config | null {
  const config = loadConfig(data);
  return recallOn(config) && switches.some((s) => config[s] === true) && covers(config, 'injections') ? config : null;
}
/** The switches whose items the ledger holds: a compaction treats either alike. */
const LEDGER_SWITCHES: ('pointOfAction' | 'promptRecall')[] = ['pointOfAction', 'promptRecall'];

/** The root of the repository holding `abs`, and its path there; null outside one. The deepest existing directory is asked, so a new file works. */
function locate(abs: string): { root: string; path: string } | null {
  let dir = dirname(abs);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const top = git(dir, 'rev-parse', '--show-toplevel')?.trim();
  if (top === undefined || top === '') return null;
  const root = realpathSync(top);
  const path = relative(root, join(realpathSync(dir), relative(dir, abs)));
  return path.startsWith('..') || isAbsolute(path) ? null : { root, path: path.split(sep).join('/') };
}

function touched(input: Input, cwd: string): { root: string; touch: Touch } | null {
  const tool = input['tool_name'];
  const args = (input['tool_input'] ?? {}) as Input;
  const file = str(args['file_path']) ?? str(args['notebook_path']);
  if (file === undefined || typeof tool !== 'string') return null;
  const at = locate(resolve(cwd, file));
  if (at === null) return null;
  let ranges: Touch['ranges'] = null;
  let replaced: string[] = [];
  if (tool === 'Read') {
    const offset = num(args['offset']);
    const limit = num(args['limit']);
    if (offset !== undefined || limit !== undefined) ranges = [[offset ?? 1, limit === undefined ? Infinity : (offset ?? 1) + limit - 1]];
  } else if (tool === 'Edit') {
    replaced = [str(args['old_string'])].filter((s): s is string => s !== undefined);
    ranges = [];
  } else if (tool === 'MultiEdit') {
    const edits = Array.isArray(args['edits']) ? (args['edits'] as Input[]) : [];
    replaced = edits.map((e) => str(e['old_string'])).filter((s): s is string => s !== undefined);
    ranges = [];
  } else if (tool !== 'Write' && tool !== 'NotebookEdit') {
    return null;
  }
  return { root: at.root, touch: { path: at.path, ranges, replaced } };
}

/** The anchor's symbol name, `a.b` of `path#a.b#function`, which an edit's old text may mention. */
const symbolName = (a: Anchor): string | undefined => a.symbol?.split('#')[1];

function anchorHit(a: Anchor, t: Touch, file: () => string | null): boolean {
  if (a.path !== t.path && !t.path.startsWith(`${a.path}/`)) return false;
  // A whole file or a directory, or a call that touches the whole file (a Read of all of it, a Write).
  if (a.start === undefined || t.ranges === null) return true;
  const text = file();
  const lines = text === null ? [] : fileLines(text);
  // Lines that moved: the anchor's numbers say nothing now, so a Read matches the whole file's items, and an Edit the symbols it names.
  const moved = a.citedHash === undefined || text === null || a.end === undefined || a.end > lines.length || rangeHash(lines, a.start, a.end) !== a.citedHash;
  const name = symbolName(a);
  if (t.replaced.length === 0) {
    return moved || t.ranges.some(([from, to]) => from <= (a.end ?? a.start!) && to >= a.start!);
  }
  return t.replaced.some((old) => {
    if (!moved && text !== null) {
      const at = text.indexOf(old);
      if (at >= 0) {
        const first = text.slice(0, at).split('\n').length;
        const last = first + old.split('\n').length - 1;
        return first <= (a.end ?? a.start!) && last >= a.start!;
      }
    }
    return name !== undefined && old.includes(name.split(/[.:]+/).pop()!);
  });
}

/** The items whose anchors the call touches, from the few already found anchored at its path. */
function anchored(items: Visible[], root: string, t: Touch): Visible[] {
  let text: string | null | undefined;
  const read = (): string | null => {
    if (text === undefined) {
      try {
        text = readFileSync(resolve(root, t.path), 'utf8');
      } catch {
        text = null;
      }
    }
    return text;
  };
  return items.filter((i) => i.anchors.some((a) => anchorHit(a, t, read)));
}

/**
 * The PreToolUse hook on Read, Edit, Write, MultiEdit and NotebookEdit: the items anchored where the call lands,
 * once per agent per session, within the injection and session budgets. Returns the hook's JSON, or '' for nothing.
 * It never returns a permission decision. A store that cannot be had in time is logged as skipped and costs no output.
 */
export function pointOfAction(data: string, input: Input, log: Log): string {
  const config = enabled(data);
  const agentType = str(input['agent_type']);
  if (config === null || (agentType !== undefined && !subagentAllowed(config, agentType))) return '';
  const cwd = str(input['cwd']) ?? process.cwd();
  const hit = touched(input, cwd);
  if (hit === null) return '';
  const context = resolveContext(hit.root, config, currentConfigDir());
  if (context.tenant === null || context.repository === null || context.owner === null) return '';
  const session = str(input['session_id']) ?? 'unknown';
  const agent = str(input['agent_id']) ?? MAIN_AGENT;
  const base = { session, agent, via: 'point-of-action', at: new Date().toISOString() };
  try {
    const db = openStore(tenantFile(data, context.tenant), false, HOOK_BUSY_MS);
    if (db === null) return '';
    try {
      const found = anchored(anchoredItems(db, context.tenant, context.repository, context.owner, hit.touch.path), hit.root, hit.touch);
      if (found.length === 0) return '';
      const byId = new Map(found.map((i) => [i.id, i]));
      const result = claim(db, session, agent, found.map((i) => i.id), (unseen, left) => {
        const slice = chooseSlice(unseen.map((id) => byId.get(id)!), Math.min(INJECTION_BUDGET, left));
        // The fence and any "more" line belong to the first row, so the rows' tokens add up to the injection's.
        const rows = slice.shown.map((i) => ({ id: i.id, tokens: estimate(row(i)) }));
        if (rows.length > 0) rows[0]!.tokens += estimate(slice.text) - rows.reduce((sum, r) => sum + r.tokens, 0);
        return { text: slice.text, shown: rows };
      });
      if (result.text === '') return '';
      log(result.shown.map((s) => ({ event: 'injected', ...base, item: s.id, anchors: [hit.touch.path], tokens: s.tokens })));
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: result.text } });
    } finally {
      db.close();
    }
  } catch {
    log([{ event: 'skipped', ...base }]);
    return '';
  }
}

/** The PreCompact hook: the ids and statements shown at the point of action or the prompt this session, at most 1,000 characters. */
export function preCompact(data: string, input: Input): string {
  const config = enabled(data, LEDGER_SWITCHES);
  const session = str(input['session_id']);
  if (config === null || session === undefined) return '';
  const context = resolveContext(str(input['cwd']) ?? process.cwd(), config, currentConfigDir());
  if (context.tenant === null) return '';
  const db = openStore(tenantFile(data, context.tenant), false, HOOK_BUSY_MS);
  if (db === null) return '';
  try {
    const rows: string[] = [];
    for (const item of shownIn(db, session)) {
      const next = `${safe(`- [${item.id}] ${item.statement}`)}\n`;
      if (fence(ITEMS_LABEL, [...rows, next].join('')).length > COMPACT_CHARS) break;
      rows.push(next);
    }
    return rows.length === 0 ? '' : fence(ITEMS_LABEL, rows.join(''));
  } catch {
    return '';
  } finally {
    db.close();
  }
}

/** A `compact` session start: the main agent may be shown its items again. */
export function afterCompaction(data: string, input: Input): void {
  const config = enabled(data, LEDGER_SWITCHES);
  const session = str(input['session_id']);
  if (config === null || session === undefined) return;
  const context = resolveContext(str(input['cwd']) ?? process.cwd(), config, currentConfigDir());
  if (context.tenant === null) return;
  const db = openStore(tenantFile(data, context.tenant), false, HOOK_BUSY_MS);
  if (db === null) return;
  try {
    resetMain(db, session);
  } finally {
    db.close();
  }
}
