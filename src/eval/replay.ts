import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertItem, tenantItems, textMatches } from '../items.ts';
import { rank, searchTerms } from '../recall/rank.ts';
import { withTextRatio } from '../recall/visible.ts';
import { openStore } from '../store/db.ts';
import { row, type Measure, type Row } from './scorecard.ts';

/**
 * The review replay's input: pull requests with the findings their review raised, in a JSON file
 * `{"pulls": [...]}`. Each finding may say what the owner did with it, and `restates` labels a finding
 * that says again what an earlier one said, so repeats are counted without a model.
 *
 *   {"number": 12, "reviewed_at": "2026-03-04", "findings": [
 *     {"id": "12-1", "path": "src/ledger.ts", "statement": "...", "owner": "declined" | "accepted", "restates": "<id>"}]}
 */
export interface Finding {
  id: string;
  path?: string;
  statement: string;
  owner?: 'declined' | 'accepted';
  restates?: string;
}
export interface Pull {
  number: number;
  reviewed_at: string;
  findings: Finding[];
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The pull requests in `text`, or an error naming what is wrong. */
export function parsePulls(text: string): Pull[] {
  const doc = JSON.parse(text) as { pulls?: unknown };
  if (!Array.isArray(doc?.pulls)) throw new Error('expected {"pulls": [...]}');
  const ids = new Set<string>();
  const restates: Finding[] = [];
  for (const p of doc.pulls as Pull[]) {
    if (!Number.isInteger(p?.number) || !isText(p.reviewed_at) || Number.isNaN(Date.parse(p.reviewed_at)) || !Array.isArray(p.findings)) {
      throw new Error(`pull ${JSON.stringify(p?.number)} needs a number, a reviewed_at date and a findings list`);
    }
    for (const f of p.findings) {
      const bad =
        !isText(f?.id) || ids.has(f.id) ? 'a unique id'
        : !isText(f.statement) ? 'a statement'
        : f.path !== undefined && !isText(f.path) ? 'a path that is text'
        : f.owner !== undefined && f.owner !== 'declined' && f.owner !== 'accepted' ? 'an owner of declined or accepted'
        : f.restates !== undefined && !isText(f.restates) ? 'a restates id that is text'
        : null;
      if (bad !== null) throw new Error(`a finding in pull ${p.number} needs ${bad}`);
      ids.add(f.id);
      if (f.restates !== undefined) restates.push(f);
    }
  }
  const unknown = restates.find((f) => !ids.has(f.restates!));
  if (unknown !== undefined) throw new Error(`finding ${unknown.id} restates ${unknown.restates}, which no pull holds`);
  return doc.pulls as Pull[];
}

export const REPLAY: Measure = { measure: 'review-replay', on: ['memory_search'], bar: 'repeats halved: on at most half of off' };

const TENANT = 'replay';
const REPOSITORY = 'replay/replay';

/**
 * How many of `repeats` memory holds: built from `learned` alone, a search for the repeat's statement and path,
 * ranked as `memory_search` ranks, returns the item made from the finding it restates.
 * shortcut: items are dated now, not at their pull request, so decay and the 90-day expiry do not apply; date them
 * when a replay spans more than 90 days.
 */
function held(learned: Finding[], repeats: Finding[]): number {
  if (learned.length === 0 || repeats.length === 0) return 0;
  const dir = mkdtempSync(join(tmpdir(), 'memory-replay-'));
  try {
    const db = openStore(join(dir, 'replay.sqlite'), true)!;
    try {
      const finding = new Map<string, string>();
      for (const f of learned) {
        const id = insertItem(db, {
          tenant: TENANT, scope: 'repository', scopeKey: REPOSITORY, type: 'precedent', statement: f.statement, rationale: null,
          anchors: f.path === undefined ? [] : [{ path: f.path }], source: `replay ${f.id}`,
        });
        finding.set(id, f.id);
      }
      // Fixture ids, not random store ids, so a tie at the result limit breaks the same way every run.
      const items = tenantItems(db, TENANT, REPOSITORY, 'replay');
      return repeats.filter((f) => {
        const ranked = withTextRatio(items, textMatches(db, searchTerms(f.statement))).map((i) => ({ ...i, id: finding.get(i.id)! }));
        return rank(ranked, f.path === undefined ? [] : [f.path]).some((h) => h.item.id === f.restates);
      }).length;
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** FR-001 of #8: memory built only from pull requests reviewed before `since`; restated owner-declined findings counted after it. */
export function replay(version: string, pulls: Pull[], since: string): Row[] {
  const cut = Date.parse(since);
  const before = pulls.filter((p) => Date.parse(p.reviewed_at) < cut);
  const after = pulls.filter((p) => Date.parse(p.reviewed_at) >= cut);
  const declined = new Set(pulls.flatMap((p) => p.findings).filter((f) => f.owner === 'declined').map((f) => f.id));
  const findingsAfter = after.flatMap((p) => p.findings);
  const repeats = findingsAfter.filter((f) => f.restates !== undefined && declined.has(f.restates));
  const learned = before.flatMap((p) => p.findings).filter((f) => f.owner === 'declined');
  const kept = held(learned, repeats);
  const samples = (memory: number) => ({ pulls_before: before.length, pulls_after: after.length, findings_after: findingsAfter.length, restatements: repeats.length, memory_items: memory });
  return [
    row(version, REPLAY, 'off', 'measured', { since, samples: samples(0), repeats: repeats.length, held: 0 }),
    row(version, REPLAY, 'on', 'measured', {
      since, samples: samples(learned.length), repeats: repeats.length - kept, held: kept,
      meets_bar: repeats.length === 0 ? null : 2 * (repeats.length - kept) <= repeats.length,
      ...(repeats.length === 0 ? { note: 'no owner-declined finding was restated after the cut-off, so there is no repeat to halve' } : {}),
    }),
  ];
}
