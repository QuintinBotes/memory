import type { Visible } from '../items.ts';
import { RANKING, type Hit } from './rank.ts';

/** The reciprocal rank fusion constant (#28, FR-004). */
export const RRF_K = 60;

/** A ranking of `items` as rank.ts sums it, with a cosine per item and the graph list's ids when the semantic leg is in play. */
export type Ranker = (items: Visible[], similarity?: Map<string, number>, near?: ReadonlySet<string>) => Hit[];

const fourth = (n: number): number => Math.round(n * 10_000) / 10_000;
const byId = (a: Visible, b: Visible): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Reciprocal rank fusion (k = 60) of three lists: the keyword ranking; the semantic leg's, the items whose cosine
 * clears RANKING.minSimilarity, closest first; and the graph list, the items sharing an anchored path with one of the
 * RANKING.graphTop best hits of either, by support then id. Each item scores the sum of 1 / (k + its rank) over the
 * lists it is in. Every row keeps the points rank.ts gives it, semantic and graph among them, and ends with `rrf`.
 */
export function fuse(items: Visible[], similarity: Map<string, number>, ranked: Ranker): Hit[] {
  const cos = (i: Visible): number => similarity.get(i.id) ?? 0;
  const keyword = ranked(items).map((h) => h.item);
  const semantic = items
    .filter((i) => cos(i) >= RANKING.minSimilarity)
    .sort((a, b) => cos(b) - cos(a) || byId(a, b))
    .slice(0, RANKING.limit);
  const top = [...new Set([...keyword.slice(0, RANKING.graphTop), ...semantic.slice(0, RANKING.graphTop)])];
  const graph = items
    .filter((i) => top.some((t) => t.id !== i.id && t.anchors.some((a) => i.anchors.some((b) => b.path === a.path))))
    .sort((a, b) => b.support - a.support || byId(a, b))
    .slice(0, RANKING.limit);
  const near = new Set(graph.map((i) => i.id));
  const fused = new Map<string, { item: Visible; rrf: number }>();
  const add = (item: Visible, at: number): void => {
    const f = fused.get(item.id) ?? { item, rrf: 0 };
    f.rrf += 1 / (RRF_K + at + 1);
    fused.set(item.id, f);
  };
  for (const list of [keyword, semantic, graph]) list.forEach(add);
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf || b.item.support - a.item.support || byId(a.item, b.item))
    .slice(0, RANKING.limit)
    .map(({ item, rrf }) => {
      const points = ranked([item], new Map([[item.id, cos(item)]]), near.has(item.id) ? near : undefined)[0]!;
      return { item, score: fourth(rrf), why: `${points.why}, rrf ${fourth(rrf)}` };
    });
}
