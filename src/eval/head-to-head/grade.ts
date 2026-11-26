import { sha256 } from '../../items.ts';
import { searchTerms } from '../../recall/rank.ts';
import type { Question } from './replay-set.ts';

/** Lower case, one space between runs of letters and digits: what the matcher compares. */
const norm = (s: string): string => ` ${s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** FR-004 of #25: a hit holds an answer key when the key's words appear in it, in order, as whole words. No model judges. */
export const holds = (hit: string, key: string): boolean => norm(hit).includes(norm(key));

/** The first of the top `k` hits that holds `key`, or -1. */
const at = (hits: string[], key: string, k: number): number => hits.slice(0, k).findIndex((h) => holds(h, key));

export interface Grade {
  arm: string;
  question: string;
  category: Question['category'];
  /** Share of the question's keys in the first hit, and in the top five. A key counts only when no item it must not recall is ranked above it. */
  at1: number;
  at5: number;
  abstained: boolean;
  /** An item that must not be recalled (stale or superseded) is in the top five. */
  staleRecalled: boolean;
  /** Keys found in the top five: the question's correct items. */
  correct: number;
  tokens: number;
  ms: number;
}

/** Grades one answer against its question's keys. */
export function grade(arm: string, q: Question, hits: string[], tokens: number, ms: number): Grade {
  const worst = Math.min(...q.mustNot.map((k) => at(hits, k, 5)).filter((i) => i >= 0), Infinity);
  const found = (k: number): number => q.keys.filter((key) => {
    const i = at(hits, key, k);
    return i >= 0 && i <= worst;
  }).length;
  const share = (n: number): number => (q.keys.length === 0 ? 0 : n / q.keys.length);
  const top5 = found(5);
  return {
    arm, question: q.id, category: q.category, at1: share(found(1)), at5: share(top5), abstained: hits.length === 0,
    staleRecalled: worst !== Infinity, correct: top5, tokens, ms,
  };
}

/** A grade's matched key, with the part of the hit around it, for the owner to check by hand. */
export interface Sampled {
  arm: string;
  question: string;
  key: string;
  excerpt: string;
  correct: boolean | null;
}

const SAMPLE = 30;

/**
 * FR-004 of #25: 30 of the run's positive matches, chosen by hash so the same run samples the same ones, each with the
 * line of the hit it matched in. The owner marks each `correct` true or false; the matcher's precision is the share
 * marked true.
 */
export function sample(answers: { arm: string; q: Question; hits: string[] }[]): Sampled[] {
  const matches: Sampled[] = [];
  for (const { arm, q, hits } of answers) {
    for (const key of [...q.keys, ...q.mustNot]) {
      const line = hits.slice(0, 5).flatMap((h) => h.split('\n')).find((l) => holds(l, key));
      if (line !== undefined) matches.push({ arm, question: q.id, key, excerpt: line.slice(0, 400), correct: null });
    }
  }
  const order = (s: Sampled): string => sha256(`${s.arm}\n${s.question}\n${s.key}`);
  return matches.sort((a, b) => (order(a) < order(b) ? -1 : 1)).slice(0, SAMPLE);
}

/** The matcher's precision over the sampled grades the owner has checked (`checked` holds their marks). */
export function precision(sampled: Sampled[], checked: Sampled[], where: string): Record<string, unknown> {
  const mark = new Map(checked.filter((c) => typeof c.correct === 'boolean').map((c) => [`${c.arm}\n${c.question}\n${c.key}`, c.correct]));
  const marks = sampled.map((s) => mark.get(`${s.arm}\n${s.question}\n${s.key}`)).filter((m) => m !== undefined);
  return {
    sample: sampled.length,
    checked: marks.length,
    precision: marks.length === 0 ? null : marks.filter((m) => m).length / marks.length,
    ...(marks.length < sampled.length ? { note: `mark each grade in ${where} correct true or false and pass it as --checked` } : {}),
  };
}

/** True when the question and the text share no search word: no lexical search could have joined them. */
export const sharesNoWord = (question: string, text: string): boolean => {
  const words = new Set(searchTerms(text, Infinity));
  return !searchTerms(question, Infinity).some((w) => words.has(w));
};
