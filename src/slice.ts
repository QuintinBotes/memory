import { taintList, type Visible } from './items.ts';
import { ITEMS_LABEL, fence, safe } from './render/rows.ts';

const SCOPE_POINTS: Record<string, number> = { repository: 2, organisation: 1, person: 1, global: 0.5 };

/** Estimated tokens: characters divided by four, rounded up. */
export const estimate = (text: string): number => Math.ceil(text.length / 4);

/** Scope, then support, then id: no clock and no counter, so the same store ranks the same. */
export function rank(items: Visible[]): Visible[] {
  return [...items].sort(
    (a, b) =>
      (SCOPE_POINTS[b.scope] ?? 0) - (SCOPE_POINTS[a.scope] ?? 0) ||
      b.support - a.support ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function row(item: Visible): string {
  const anchors = item.anchors
    .map((a) => a.symbol ?? (a.start === undefined ? a.path : `${a.path}:${a.start}-${a.end ?? a.start}`))
    .join(', ');
  const source = item.source !== '' && item.source !== 'remember' ? ` ${item.source}` : '';
  const taint = item.taint === undefined ? '' : ` [tainted: ${taintList(item.taint)}]`;
  return safe(`- [${item.id}] ${item.type}: ${item.statement}${anchors ? ` (${anchors})` : ''}${source}${taint}`) + '\n';
}

function compose(rows: string[], more: number, anchored: number): string {
  const note = anchored > 0 ? `+${anchored} anchored to code: shown when you read or edit it\n` : '';
  return fence(ITEMS_LABEL, rows.join('') + (more > 0 ? `+${more} more: memory list\n` : '') + note);
}

/**
 * The rows that fit `budget`, whole, in rank order, with the items they show.
 * A row that does not fit is skipped and a later, shorter one may still fit.
 * Each fit is checked as if every row not yet taken were dropped, and the
 * "more" count only falls as rows are added, so the final text never exceeds
 * the budget. Nothing fits, nothing is printed.
 */
export function chooseSlice(items: Visible[], budget: number, anchored = 0): { text: string; shown: Visible[] } {
  if (budget <= 0 || (items.length === 0 && anchored === 0)) return { text: '', shown: [] };
  const ranked = rank(items);
  const rows = ranked.map(row);
  const chosen: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const candidate = [...chosen, i].map((j) => rows[j]!);
    if (estimate(compose(candidate, rows.length - candidate.length, anchored)) <= budget) chosen.push(i);
  }
  const text = compose(chosen.map((j) => rows[j]!), rows.length - chosen.length, anchored);
  if ((chosen.length === 0 && anchored === 0) || estimate(text) > budget) return { text: '', shown: [] };
  return { text, shown: chosen.map((j) => ranked[j]!) };
}

/** The session-start slice: with recall at the point of action on, anchored items wait for their code and are only counted. */
export function sessionSlice(items: Visible[], budget: number, pointOfAction: boolean): { text: string; shown: Visible[] } {
  if (!pointOfAction) return chooseSlice(items, budget);
  const unanchored = items.filter((i) => i.anchors.length === 0);
  return chooseSlice(unanchored, budget, items.length - unanchored.length);
}

/** Every visible item, no budget, for `memory list`. */
export function renderAll(items: Visible[]): string {
  return items.length === 0 ? '' : compose(rank(items).map(row), 0, 0);
}
