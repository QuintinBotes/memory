import { posix } from 'node:path';
import type { Config } from '../config.ts';
import type { Context } from '../context.ts';
import { git } from '../context.ts';
import { estimate } from '../slice.ts';
import { ITEMS_LABEL, LEAN_ROW_TOKENS, fence, leanRow } from '../render/rows.ts';
import { impact } from './impact.ts';
import { fuse, type Ranker } from './fuse.ts';
import { rank, searchTerms } from './rank.ts';
import { rerank } from './rerank.ts';
import { similarities } from './semantic.ts';
import { visibleItems } from './visible.ts';

/** What `memory recall --diff` prints at most, fence included. */
export const DIFF_BUDGET = 600;

/** The types a reviewer wants for a change: what was decided about findings, and what bites. */
const TYPES = new Set(['precedent', 'hazard']);

/**
 * The precedents and hazards for the paths `range` (`<base>..<head>`) changes, and with a configured impact provider for
 * the dependents those paths reach (#16), ranked as a search ranks them, their
 * citations re-checked first, whole rows only within `DIFF_BUDGET` estimated tokens. `reason` when the range does not resolve.
 * With the semantic leg on (#28), the changed files' names are its query, fused with the keyword ranking; the
 * optional reranker reorders the result with the same query.
 */
export async function diffRecall(data: string, config: Config, context: Context, cwd: string, range: string): Promise<{ text: string } | { reason: string }> {
  if (!range.includes('..') || range.startsWith('-')) return { reason: `--diff takes a range <base>..<head>, not "${range}"` };
  const out = git(cwd, 'diff', '--name-only', '--no-renames', '-z', range, '--');
  if (out === null) return { reason: `the range ${range} does not resolve to two commits here` };
  const changed = out.split('\0').filter((p) => p !== '');
  const query = changed.map((p) => posix.basename(p, posix.extname(p))).join(' ');
  const terms = searchTerms(query);
  const reach = impact(config, context, cwd, range, changed);
  const dependents = reach !== null && 'dependents' in reach ? reach.dependents : [];
  const items = visibleItems(data, context, cwd, terms).filter((i) => TYPES.has(i.type));
  const semantic = query === '' ? null : await similarities(data, context, config, query, items);
  const now = Date.now();
  const ranked: Ranker = (list, similarity, near) => rank(list, changed, now, similarity, undefined, dependents, context.repository, near);
  const fused = semantic !== null && 'similarity' in semantic ? fuse(items, semantic.similarity, ranked) : ranked(items);
  const { hits, note: reranked } = query === '' ? { hits: fused } : await rerank(config, context, query, fused);
  const note = [reach !== null && 'note' in reach ? reach.note : undefined, semantic !== null && 'note' in semantic ? semantic.note : undefined, reranked]
    .filter((n) => n !== undefined).map((n) => `${n}\n`).join('');
  const rows: string[] = [];
  const render = (list: string[]): string => (list.length === 0 ? 'No precedent or hazard matches this change.\n' : fence(ITEMS_LABEL, list.join(''))) + note;
  for (const h of hits) {
    const row = `${leanRow(h.item, h.why, LEAN_ROW_TOKENS)}\n`;
    if (estimate(render([...rows, row])) > DIFF_BUDGET) break;
    rows.push(row);
  }
  return { text: render(rows) };
}
