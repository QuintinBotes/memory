import { posix } from 'node:path';
import type { Visible } from '../items.ts';

/**
 * The provisional confidence constants, accepted by the owner until the
 * evaluation slice (#8) tunes them: c, the half-life in days, and the band
 * edges. Confidence is SCF's formula, computed on read and shown only as a band.
 */
export const CONFIDENCE = { base: 1, halfLifeDays: 90, low: 0.4, high: 0.7 } as const;

/** An item with no reinforcement for this many days reads as expired. */
export const EXPIRY_DAYS = 90;

/** True, as SQL on `items`, when an item has gone 90 days without reinforcement. */
export const READS_EXPIRED = `coalesce(reinforced_at, valid_from) < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${EXPIRY_DAYS} days')`;

/** `min(1, c × 0.5^(age/half_life) × 1.1^reinforced × 0.8^weakened)`, age in days since the last reinforcement. */
export function confidence(item: Pick<Visible, 'reinforced' | 'helped' | 'wrong'>, now = Date.now()): number {
  const age = Math.max(0, (now - Date.parse(item.reinforced)) / 86_400_000);
  return Math.min(1, CONFIDENCE.base * 0.5 ** (age / CONFIDENCE.halfLifeDays) * 1.1 ** item.helped * 0.8 ** item.wrong);
}

export const band = (c: number): 'low' | 'medium' | 'high' => (c < CONFIDENCE.low ? 'low' : c >= CONFIDENCE.high ? 'high' : 'medium');

// shortcut: no item carries a failure fingerprint or check id yet, so the spec's 2 points for one
// are not scored; add them with the slice that captures fingerprints.
export const RANKING = {
  anchor: 4,
  anchorCap: 8,
  scope: { repository: 2, organisation: 1, person: 1, global: 0.5 } as Record<string, number>,
  text: 2,
  /** A text match weaker than this share of the best match is noise, not relevance. */
  minTextRatio: 0.2,
  confidence: 2,
  contradiction: 1,
  /** Most rows one search returns. */
  limit: 10,
} as const;

export interface Hit {
  item: Visible;
  score: number;
  /** Every point, in order: anchor, scope, text, confidence, contradictions. */
  why: string;
}

const tenth = (n: number): number => Math.round(n * 10) / 10;

/**
 * A fixed, explainable sum (Orbit's retrieve.ts style): only an item that
 * overlaps a path in play or matches the query is a hit, then scope,
 * confidence and contradictions adjust it. Ties break on support, then id.
 */
export function rank(items: Visible[], paths: string[], now = Date.now()): Hit[] {
  // The repository root, '.' or './', normalises to '' and holds every anchored path.
  const want = paths.map((p) => posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\/?$|^\.\//, '').replace(/\/+$/, ''));
  const hits: Hit[] = [];
  for (const item of items) {
    const parts: string[] = [];
    let score = 0;
    const add = (label: string, points: number): void => {
      score += points;
      parts.push(`${label} ${points}`);
    };
    const overlap = item.anchors.filter((a) => want.some((p) => p === '' || a.path === p || a.path.startsWith(`${p}/`))).length;
    if (overlap > 0) add('anchor', Math.min(RANKING.anchorCap, overlap * RANKING.anchor));
    const ratio = item.textRatio ?? 0;
    const text = ratio >= RANKING.minTextRatio ? tenth(RANKING.text * ratio) : 0;
    if (overlap === 0 && text === 0) continue;
    add(item.scope, RANKING.scope[item.scope] ?? 0);
    if (text > 0) add('text', text);
    const c = confidence(item, now);
    add(`confidence ${band(c)}`, tenth(RANKING.confidence * c));
    if (item.contradictions > 0) add('contradicted', -item.contradictions * RANKING.contradiction);
    hits.push({ item, score: tenth(score), why: parts.join(', ') });
  }
  return hits
    .sort((a, b) => b.score - a.score || b.item.support - a.item.support || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
    .slice(0, RANKING.limit);
}

// searchTerms and its stopwords are copied from Orbit, src/knowledge/text.ts at 9b484a2 on branch next
// (https://github.com/QuintinBotes/orbit, MIT).
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with', 'when', 'which', 'while', 'not', 'no', 'do', 'does', 'so', 'if', 'then',
]);

/** Search terms from free text: letters and digits only, so nothing reaches FTS5 query syntax. */
export function searchTerms(text: string, max = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
