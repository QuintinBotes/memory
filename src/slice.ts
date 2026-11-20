import type { Visible } from './items.ts';

const SCOPE_POINTS: Record<string, number> = { repository: 2, organisation: 1, person: 1, global: 0.5 };
const HEADER = 'Memory (advisory; facts recorded earlier, with their source):\n';

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

const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');

export function row(item: Visible): string {
  const anchors = item.anchors
    .map((a) => (a.start === undefined ? a.path : `${a.path}:${a.start}-${a.end ?? a.start}`))
    .join(', ');
  const source = item.source !== '' && item.source !== 'remember' ? ` ${item.source}` : '';
  return oneLine(`- [${item.id}] ${item.type}: ${item.statement}${anchors ? ` (${anchors})` : ''}${source}`) + '\n';
}

function compose(rows: string[], more: number): string {
  return HEADER + rows.join('') + (more > 0 ? `+${more} more: memory list\n` : '');
}

/**
 * The rows that fit `budget`, whole, in rank order. A row that does not fit is
 * skipped and a later, shorter one may still fit. Each fit is checked as if
 * every row not yet taken were dropped, and the "more" count only falls as
 * rows are added, so the final text never exceeds the budget. Nothing fits,
 * nothing is printed.
 */
export function renderSlice(items: Visible[], budget: number): string {
  if (budget <= 0 || items.length === 0) return '';
  const rows = rank(items).map(row);
  const chosen: string[] = [];
  for (const r of rows) {
    const candidate = [...chosen, r];
    if (estimate(compose(candidate, rows.length - candidate.length)) <= budget) chosen.push(r);
  }
  return chosen.length === 0 ? '' : compose(chosen, rows.length - chosen.length);
}

/** Every visible item, no budget, for `memory list`. */
export function renderAll(items: Visible[]): string {
  return items.length === 0 ? '' : compose(rank(items).map(row), 0);
}
