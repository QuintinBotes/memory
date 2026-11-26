import type { Visible } from '../items.ts';
import { RANKING, type Hit } from './rank.ts';

/** The reciprocal rank fusion constant (#28, FR-004). */
export const RRF_K = 60;

/** A ranking of `items` as rank.ts sums it, with a cosine per item when the semantic leg is in play. */
export type Ranker = (items: Visible[], similarity?: Map<string, number>) => Hit[];

const fourth = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * Reciprocal rank fusion (k = 60) of the keyword ranking and the semantic leg's, the items whose cosine clears
 * RANKING.minSimilarity, closest first: each item scores the sum of 1 / (k + its rank) over the lists it is in. Every
 * row keeps the points rank.ts gives it, its semantic points among them, and adds its fused score as `rrf`.
 */
export function fuse(items: Visible[], similarity: Map<string, number>, ranked: Ranker): Hit[] {
  const cos = (i: Visible): number => similarity.get(i.id) ?? 0;
  const semantic = items
    .filter((i) => cos(i) >= RANKING.minSimilarity)
    .sort((a, b) => cos(b) - cos(a) || (a.id < b.id ? -1 : 1))
    .slice(0, RANKING.limit);
  const fused = new Map<string, { item: Visible; rrf: number }>();
  const add = (item: Visible, at: number): void => {
    const f = fused.get(item.id) ?? { item, rrf: 0 };
    f.rrf += 1 / (RRF_K + at + 1);
    fused.set(item.id, f);
  };
  ranked(items).forEach((h, at) => add(h.item, at));
  semantic.forEach(add);
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf || b.item.support - a.item.support || (a.item.id < b.item.id ? -1 : 1))
    .slice(0, RANKING.limit)
    .map(({ item, rrf }) => {
      const points = ranked([item], new Map([[item.id, cos(item)]]))[0]!;
      return { item, score: fourth(rrf), why: `${points.why}, rrf ${fourth(rrf)}` };
    });
}
