import { row, type Measure, type Row } from './scorecard.ts';

/**
 * The injection log: one JSON object per line, appended in the order things happened. Slice 10's hooks write
 * it, and `memory_feedback` adds its signals; until then a fixture stands in. The report reads three events:
 *
 *   {"event": "injected", "session": "<id>", "item": "<id>", "via": "<capability>", "anchors": ["<path>", ...]}
 *   {"event": "touched", "session": "<id>", "paths": ["<path>", ...]}
 *   {"event": "feedback", "session": "<id>", "item": "<id>", "signal": "helped" | "wrong" | "stale"}
 *
 * Paths are relative to the repository root. Other fields and other events are ignored, so a writer may add both.
 */
export type Event =
  | { event: 'injected'; session: string; item: string; via: string; anchors: string[] }
  | { event: 'touched'; session: string; paths: string[] }
  | { event: 'feedback'; session: string; item: string; signal: string };

const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isPaths = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

/** The events of `text` the report reads, or an error naming the line that is wrong. */
export function parseLog(text: string): Event[] {
  const out: Event[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
    const ok =
      e?.event === 'injected' ? isText(e.session) && isText(e.item) && isText(e.via) && isPaths(e.anchors)
      : e?.event === 'touched' ? isText(e.session) && isPaths(e.paths)
      : e?.event === 'feedback' ? isText(e.session) && isText(e.item) && ['helped', 'wrong', 'stale'].includes(e.signal as string)
      : null;
    if (ok === false) throw new Error(`line ${i + 1}: a ${String(e.event)} event lacks a field it needs`);
    if (ok === true) out.push(e as Event);
  });
  return out;
}

/** Its on arm's switches are the capabilities the log shows recalling. */
export const FALSE_RECALL: Measure = { measure: 'false-recall', on: [], bar: 'false recall under 10% of recalled items' };

/** True when `path` is `anchor` or lies under it. */
const covers = (anchor: string, path: string): boolean => path === anchor || path.startsWith(`${anchor}/`);

/**
 * FR-002 of #8: a recall is false when its item is later marked wrong or stale, or when it is anchored and nothing
 * under its anchors is touched later in that session. An unanchored item has no code to touch, so only feedback
 * judges it. An item shown twice in one session is one recall, judged from its first showing.
 */
export function falseRecall(version: string, events: Event[]): Row[] {
  // One pass from the end, so "later" is what has been read so far.
  const flagged = new Set<string>();
  const touched = new Map<string, string[]>();
  const verdict = new Map<string, { session: string; via: string; why: 'wrong or stale' | 'untouched' | null }>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === 'feedback') {
      if (e.signal === 'wrong' || e.signal === 'stale') flagged.add(e.item);
    } else if (e.event === 'touched') {
      const paths = touched.get(e.session) ?? [];
      paths.push(...e.paths);
      touched.set(e.session, paths);
    } else {
      const paths = touched.get(e.session) ?? [];
      const why = flagged.has(e.item) ? 'wrong or stale' : e.anchors.length > 0 && !e.anchors.some((a) => paths.some((p) => covers(a, p))) ? 'untouched' : null;
      verdict.set(JSON.stringify([e.session, e.item]), { session: e.session, via: e.via, why });
    }
  }
  const all = [...verdict.values()];
  const wrong = all.filter((v) => v.why === 'wrong or stale').length;
  const untouched = all.filter((v) => v.why === 'untouched').length;
  const sessions = new Set(all.map((v) => v.session)).size;
  const rate = all.length === 0 ? null : Math.round(((wrong + untouched) / all.length) * 1000) / 1000;
  return [
    row(version, FALSE_RECALL, 'off', 'measured', { samples: { sessions: 0, recalled: 0 }, false_recall: null, note: 'memory off recalls nothing' }),
    row(version, FALSE_RECALL, 'on', 'measured', {
      samples: { sessions, recalled: all.length }, false_recall: rate, why: { marked_wrong_or_stale: wrong, no_anchor_touched: untouched },
      meets_bar: all.length === 0 ? null : (wrong + untouched) * 10 < all.length,
      ...(all.length === 0 ? { note: 'the log records no recall' } : {}),
    }, [...new Set(all.map((v) => v.via))].sort()),
  ];
}
