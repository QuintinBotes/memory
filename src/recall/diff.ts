import { posix } from 'node:path';
import type { Config } from '../config.ts';
import type { Context } from '../context.ts';
import { git } from '../context.ts';
import { estimate } from '../slice.ts';
import { ITEMS_LABEL, LEAN_ROW_TOKENS, fence, leanRow } from '../render/rows.ts';
import { impact } from './impact.ts';
import { rank, searchTerms } from './rank.ts';
import { visibleItems } from './visible.ts';

/** What `memory recall --diff` prints at most, fence included. */
export const DIFF_BUDGET = 600;

/** The types a reviewer wants for a change: what was decided about findings, and what bites. */
const TYPES = new Set(['precedent', 'hazard']);

/**
 * The precedents and hazards for the paths `range` (`<base>..<head>`) changes, and with a configured impact provider for
 * the dependents those paths reach (#16), ranked as a search ranks them, their
 * citations re-checked first, whole rows only within `DIFF_BUDGET` estimated tokens. `reason` when the range does not resolve.
 */
export function diffRecall(data: string, config: Config, context: Context, cwd: string, range: string): { text: string } | { reason: string } {
  if (!range.includes('..') || range.startsWith('-')) return { reason: `--diff takes a range <base>..<head>, not "${range}"` };
  const out = git(cwd, 'diff', '--name-only', '--no-renames', '-z', range, '--');
  if (out === null) return { reason: `the range ${range} does not resolve to two commits here` };
  const changed = out.split('\0').filter((p) => p !== '');
  const terms = searchTerms(changed.map((p) => posix.basename(p, posix.extname(p))).join(' '));
  const reach = impact(config, context, cwd, range, changed);
  const dependents = reach !== null && 'dependents' in reach ? reach.dependents : [];
  const note = reach !== null && 'note' in reach ? `${reach.note}\n` : '';
  const hits = rank(visibleItems(data, context, cwd, terms).filter((i) => TYPES.has(i.type)), changed, Date.now(), undefined, undefined, dependents);
  const rows: string[] = [];
  for (const h of hits) {
    const row = `${leanRow(h.item, h.why, LEAN_ROW_TOKENS)}\n`;
    if (estimate(fence(ITEMS_LABEL, [...rows, row].join(''))) > DIFF_BUDGET) break;
    rows.push(row);
  }
  return { text: (rows.length === 0 ? 'No precedent or hazard matches this change.\n' : fence(ITEMS_LABEL, rows.join(''))) + note };
}
