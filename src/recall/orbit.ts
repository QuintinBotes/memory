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
 * `knowledge.enabled` not false. Orbit's own reading of its file, as far as these two keys go: a key of another
 * section, a comment or a quoted value is not the switch.
 */
export function lessonsInPrompts(root: string): boolean {
  const file = join(root, '.orbit', 'config.yaml');
  if (!existsSync(file)) return false;
  let inKnowledge = false;
  const seen: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) inKnowledge = /^knowledge:\s*(#.*)?$/.test(line);
    else if (inKnowledge) {
      const m = /^\s+(enabled|lessons_in_prompts):\s*(true|false)\s*(#.*)?$/.exec(line);
      if (m) seen[m[1]!] = m[2]!;
    }
  }
  return seen['lessons_in_prompts'] === 'true' && seen['enabled'] !== 'false';
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
  const visible = visibleItems(data, context, cwd);
  const db = openStore(tenantFile(data, context.tenant), false);
  if (db === null) return '';
  const keyed = new Set<string>();
  const stale = new Set<string>();
  try {
    const at = (id: string): { kind: string; key: string }[] => db.prepare('SELECT kind, key FROM item_keys WHERE item_id = ?').all(id) as { kind: string; key: string }[];
    const cutoff = new Date(Date.now() - ORBIT_EXPIRY_DAYS * 86_400_000).toISOString();
    for (const item of visible) {
      if (at(item.id).some((k) => (k.kind === 'fingerprint' ? ask.fingerprints : ask.checks).includes(k.key))) keyed.add(item.id);
      const last = db.prepare('SELECT max(captured_at) AS at FROM evidence WHERE item_id = ?').get(item.id) as { at: string | null };
      if (item.source.startsWith('orbit run ') && (last.at ?? '') < cutoff) stale.add(item.id);
    }
  } finally {
    db.close();
  }
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const rows: string[] = [];
  for (const h of rank(visible.filter((i) => !stale.has(i.id)), ask.paths, today, undefined, keyed)) {
    if (rows.length === ORBIT_ITEMS) break;
    const row = `${leanRow(h.item, '', LEAN_ROW_TOKENS)}\n`;
    if (estimate([...rows, row].join('')) > ask.maxTokens) break;
    rows.push(row);
  }
  return rows.join('');
}
