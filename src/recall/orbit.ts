import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../context.ts';
import { git } from '../context.ts';
import { estimate } from '../slice.ts';
import { openStore } from '../store/db.ts';
import { tenantFile } from '../store/paths.ts';
import { LEAN_ROW_TOKENS, leanRow } from '../render/rows.ts';
import { rank } from './rank.ts';
import { visibleItems } from './visible.ts';

/** Most items one Orbit prompt gets: Orbit's own `max_prompt_lessons` default. */
export const ORBIT_ITEMS = 3;
/** An Orbit lesson no run supported for this long is not offered, as Orbit's own `lesson_expiry_days`. */
export const ORBIT_EXPIRY_DAYS = 28;

export interface OrbitContext {
  paths: string[];
  fingerprints: string[];
  checks: string[];
  /** Orbit's advisory budget in estimated tokens, rows only; none is no limit beyond the three items. */
  maxTokens: number;
}

/**
 * Whether `.orbit/config.yaml` in `root` turns lessons into prompts: `knowledge.lessons_in_prompts: true`, with
 * `knowledge.enabled` not false. No YAML library: only keys one indent level directly under a top-level `knowledge:`
 * line are read, booleans case-insensitively, and anything unclear (a duplicate key or section, a quoted or unknown
 * value, flow style, a tab, an odd indent) reads as off, as Orbit refuses a file it cannot read.
 */
export function lessonsInPrompts(root: string): boolean {
  const file = join(root, '.orbit', 'config.yaml');
  if (!existsSync(file)) return false;
  let sections = 0;
  let inKnowledge = false;
  let indent = 0;
  const seen: Record<string, boolean> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (line.includes('\t')) return false;
    const spaces = /^ */.exec(line)![0].length;
    if (spaces === 0) {
      if (/^knowledge\s*:/.test(line)) {
        if (!/^knowledge:\s*(#.*)?$/.test(line) || ++sections > 1) return false;
        inKnowledge = true;
      } else inKnowledge = false;
      continue;
    }
    if (!inKnowledge) continue;
    indent ||= spaces;
    if (spaces < indent) return false;
    if (spaces > indent) continue;
    const m = /^ +(enabled|lessons_in_prompts):\s*(\S+?)\s*(?:\s#.*)?$/.exec(line);
    if (m === null) {
      if (/^ +(?:"?enabled"?|"?lessons_in_prompts"?)\s*:/.test(line)) return false;
      continue;
    }
    const value = m[2]!.toLowerCase();
    if ((value !== 'true' && value !== 'false') || m[1]! in seen) return false;
    seen[m[1]!] = value === 'true';
  }
  return seen['lessons_in_prompts'] === true && seen['enabled'] !== false;
}

/**
 * The items for one Orbit run's context, as lean rows one per line (Orbit puts them in its own advisory fence), or
 * nothing: when the switch is off, when no item matches, and for an Orbit lesson no run supported in 28 days. At most
 * three rows, whole rows within `maxTokens`. Ranked by the points a search uses, without their reasons, and read as of
 * the day's start, so a retry of one attempt reads what the first read.
 */
export function orbitRecall(data: string, context: Context, cwd: string, ask: OrbitContext): string {
  const root = git(cwd, 'rev-parse', '--show-toplevel')?.trim() ?? cwd;
  if (!lessonsInPrompts(root) || context.tenant === null || context.repository === null) return '';
  // One day start for the 28-day cutoff and the ranking, so the clock inside a day changes no row.
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const visible = visibleItems(data, context, cwd);
  const db = openStore(tenantFile(data, context.tenant), false);
  if (db === null) return '';
  const keyed = new Set<string>();
  const stale = new Set<string>();
  try {
    const at = (id: string): { kind: string; key: string }[] => db.prepare('SELECT kind, key FROM item_keys WHERE item_id = ?').all(id) as { kind: string; key: string }[];
    const cutoff = new Date(today - ORBIT_EXPIRY_DAYS * 86_400_000).toISOString();
    for (const item of visible) {
      if (at(item.id).some((k) => (k.kind === 'fingerprint' ? ask.fingerprints : ask.checks).includes(k.key))) keyed.add(item.id);
      const last = db.prepare('SELECT max(captured_at) AS at FROM evidence WHERE item_id = ?').get(item.id) as { at: string | null };
      if (item.source.startsWith('orbit run ') && (last.at ?? '') < cutoff) stale.add(item.id);
    }
  } finally {
    db.close();
  }
  const rows: string[] = [];
  for (const h of rank(visible.filter((i) => !stale.has(i.id)), ask.paths, today, undefined, keyed)) {
    if (rows.length === ORBIT_ITEMS) break;
    const row = `${leanRow(h.item, '', LEAN_ROW_TOKENS)}\n`;
    if (estimate([...rows, row].join('')) > ask.maxTokens) break;
    rows.push(row);
  }
  return rows.join('');
}
