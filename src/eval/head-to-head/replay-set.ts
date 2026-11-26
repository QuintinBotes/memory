import { TENANT_NAME } from '../../config.ts';

/**
 * The head-to-head replay's input (#25): a tenant's history as one JSON file, documented in the README under Head to head.
 *
 *   {"tenant": "acme", "repository": "acme/api", "client": true,
 *    "evidence": [{"id", "at", "kind", "statement", "key", "path"?, "supersedes"?}],
 *    "events":   [{"id", "at", "kind", "question", "answers": [<evidence id>], "path"?, "asOf"?}]}
 *
 * Evidence is what memory could have learned; `key` is the phrase that shows an answer holds it. A `code-change` names
 * a path whose code was rewritten. Events are the later corrections, decisions and failures that become questions.
 */
export const EVIDENCE_KINDS = ['decision', 'correction', 'lesson', 'hazard', 'failure', 'code-change'] as const;
export const EVENT_KINDS = ['correction', 'decision', 'failure'] as const;
export const CATEGORIES = ['single-fact', 'multi-source', 'knowledge-update', 'temporal', 'abstention', 'code-anchored-hazard', 'stale-citation'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Evidence {
  id: string;
  at: string;
  kind: (typeof EVIDENCE_KINDS)[number];
  statement: string;
  key?: string;
  path?: string;
  supersedes?: string;
}
interface Event {
  id: string;
  at: string;
  kind: (typeof EVENT_KINDS)[number];
  question: string;
  answers: string[];
  path?: string;
  asOf?: string;
}
export interface History {
  tenant: string;
  repository: string;
  /** A client tenant's evidence never leaves the machine; absent reads as client. */
  client: boolean;
  evidence: Evidence[];
  events: Event[];
}

/** One question: the keys a right answer holds, and the keys of items it must not recall (stale or superseded). */
export interface Question {
  id: string;
  category: Category;
  question: string;
  path?: string;
  asOf?: string;
  keys: string[];
  /** The statements of the evidence holding `keys`. */
  statements: string[];
  mustNot: string[];
}
export interface ReplaySet {
  tenant: string;
  repository: string;
  client: boolean;
  since: string;
  /** Evidence before the cut-off, oldest first: all any arm ingests. */
  ingest: Evidence[];
  questions: Question[];
  /** Events after the cut-off whose answer lies only in evidence at or after it. */
  dropped: number;
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => isText(v) && !Number.isNaN(Date.parse(v));

/** The history in `text`, or an error naming what is wrong. */
export function parseHistory(text: string): History {
  const h = JSON.parse(text) as Partial<History>;
  if (typeof h?.tenant !== 'string' || !TENANT_NAME.test(h.tenant)) throw new Error('tenant must be a tenant name: lower-case letters, digits and dashes');
  if (!isText(h.repository) || !Array.isArray(h.evidence) || !Array.isArray(h.events)) {
    throw new Error('expected {"tenant", "repository", "evidence": [...], "events": [...]}');
  }
  const ids = new Set<string>();
  for (const e of h.evidence) {
    const bad =
      !isText(e?.id) || ids.has(e.id) ? 'a unique id'
      : !isDate(e.at) ? 'an at date'
      : !(EVIDENCE_KINDS as readonly string[]).includes(e.kind) ? `a kind of ${EVIDENCE_KINDS.join(', ')}`
      : !isText(e.statement) ? 'a statement'
      : e.kind === 'code-change' ? (isText(e.path) ? null : 'a path')
      : !isText(e.key) ? 'a key'
      : e.path !== undefined && !isText(e.path) ? 'a path that is text'
      : null;
    if (bad !== null) throw new Error(`evidence ${JSON.stringify(e?.id)} needs ${bad}`);
    ids.add(e.id);
  }
  const unknown = h.evidence.find((e) => e.supersedes !== undefined && !ids.has(e.supersedes));
  if (unknown !== undefined) throw new Error(`evidence ${unknown.id} supersedes ${String(unknown.supersedes)}, which the history does not hold`);
  const events = new Set<string>();
  for (const e of h.events) {
    const bad =
      !isText(e?.id) || events.has(e.id) ? 'a unique id'
      : !isDate(e.at) ? 'an at date'
      : !(EVENT_KINDS as readonly string[]).includes(e.kind) ? `a kind of ${EVENT_KINDS.join(', ')}`
      : !isText(e.question) ? 'a question'
      : !Array.isArray(e.answers) || !e.answers.every((a) => ids.has(a)) ? 'answers naming evidence the history holds'
      : e.asOf !== undefined && !isDate(e.asOf) ? 'an asOf date'
      : e.path !== undefined && !isText(e.path) ? 'a path that is text'
      : null;
    if (bad !== null) throw new Error(`event ${JSON.stringify(e?.id)} needs ${bad}`);
    events.add(e.id);
  }
  return { ...(h as History), client: h.client !== false };
}

/**
 * FR-001 of #25: events after `since` become questions, built only from evidence before it. The category follows from
 * the evidence, first match wins: no answer is abstention; an asOf date is temporal; an answer whose path a code change
 * rewrote before the cut-off is a stale citation (it must not be recalled); an answer superseding another is a knowledge
 * update (the older must not be recalled); two or more answers are multi-source; an anchored hazard is code-anchored.
 */
export function buildReplaySet(h: History, since: string): ReplaySet {
  const cut = Date.parse(since);
  const before = (at: string): boolean => Date.parse(at) < cut;
  const ingest = h.evidence.filter((e) => before(e.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : 1));
  const held = new Map(ingest.map((e) => [e.id, e]));
  const rewritten = (e: Evidence): boolean =>
    e.path !== undefined && ingest.some((c) => c.kind === 'code-change' && c.path === e.path && Date.parse(c.at) > Date.parse(e.at));
  let dropped = 0;
  const questions: Question[] = [];
  for (const ev of h.events.filter((e) => !before(e.at))) {
    const answers = ev.answers.map((id) => held.get(id));
    if (answers.some((a) => a === undefined)) {
      dropped++;
      continue;
    }
    const found = answers as Evidence[];
    const older = found.flatMap((a) => (a.supersedes === undefined ? [] : [held.get(a.supersedes)!]));
    const q = (category: Category, keys: Evidence[], mustNot: Evidence[] = []): Question => ({
      id: ev.id, category, question: ev.question, ...(ev.path !== undefined ? { path: ev.path } : {}), ...(ev.asOf !== undefined ? { asOf: ev.asOf } : {}),
      keys: keys.map((e) => e.key!), statements: keys.map((e) => e.statement), mustNot: mustNot.map((e) => e.key!),
    });
    questions.push(
      found.length === 0 ? q('abstention', [])
      : ev.asOf !== undefined ? q('temporal', found)
      : found.some(rewritten) ? q('stale-citation', found.filter((a) => !rewritten(a)), found.filter(rewritten))
      : older.length > 0 ? q('knowledge-update', found, older)
      : found.length > 1 ? q('multi-source', found)
      : found[0]!.kind === 'hazard' && found[0]!.path !== undefined ? q('code-anchored-hazard', found)
      : q('single-fact', found),
    );
  }
  return { tenant: h.tenant, repository: h.repository, client: h.client, since, ingest, questions, dropped };
}
