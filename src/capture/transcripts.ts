import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { automationRefusal } from '../automation.ts';
import { consented, currentConfigDir, loadConfig, organisationTerms, type Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { addItem } from '../consolidate.ts';
import { resolveContext } from '../context.ts';
import { refusal } from '../gate.ts';
import { recordAudit } from '../store/audit.ts';
import { HOOK_BUSY_MS, openStore } from '../store/db.ts';
import { personFile, tenantFile } from '../store/paths.ts';
import { scrub } from './capture.ts';

/** Transcript records and compaction episodes are deleted after this many days (FR-005 of #12). */
export const TRANSCRIPT_DAYS = 30;
const MAX_SUMMARY = 4000;
const cutoff = (): string => new Date(Date.now() - TRANSCRIPT_DAYS * 864e5).toISOString();

/** The separate opt-in is on and the owner's consent covers the transcripts category (FR-001). */
export const transcriptsOn = (config: Config | null): config is Config => config !== null && consented(config) && config.optIns.transcripts && covers(config, 'transcripts');

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The SessionEnd and PostCompact hooks' work (FR-002): with the opt-in on, record where the transcript is, never its
 * content; for a compaction, the redacted summary as an episode. Nothing is read from the transcript, and with the
 * opt-in off nothing is recorded or opened. A session outside every tenant records its path in the person file (#80).
 */
export function recordTranscript(data: string, input: Record<string, unknown>): void {
  const config = loadConfig(data);
  if (!transcriptsOn(config)) return;
  const path = str(input['transcript_path']);
  // The environment only: the transcript is never opened here. Its own entrypoint is read at processing.
  if (automationRefusal(config, process.env) !== null) return;
  const context = resolveContext(str(input['cwd']) ?? process.cwd(), config, currentConfigDir());
  // Outside every tenant the path goes to the person file (#80); a compaction summary there is not kept.
  const person = context.tenant === null;
  if (person ? !covers(config, 'personTranscripts') : context.repository === null) return;
  const compaction = input['hook_event_name'] === 'PostCompact';
  const summary = compaction ? str(input['compact_summary']) : undefined;
  if (compaction ? person || summary === undefined : path === undefined) return;
  const session = str(input['session_id']) ?? 'unknown';
  const repository = context.repository ?? '';
  const db = openStore(person ? personFile(data) : tenantFile(data, context.tenant!), true, HOOK_BUSY_MS)!;
  try {
    const id = `t-${randomBytes(5).toString('hex')}`;
    const at = new Date().toISOString();
    if (summary !== undefined) {
      db.prepare("INSERT INTO transcripts (id, session, kind, repository, summary, at, processed_at, outcome) VALUES (?, ?, 'summary', ?, ?, ?, ?, 'episode')").run(id, session, repository, scrub(summary).slice(0, MAX_SUMMARY), at, at);
    } else if (db.prepare("SELECT 1 FROM transcripts WHERE session = ? AND kind = 'path' AND path = ? AND processed_at IS NULL").get(session, path!) === undefined) {
      db.prepare("INSERT INTO transcripts (id, session, kind, repository, path, at) VALUES (?, ?, 'path', ?, ?, ?)").run(id, session, repository, path!, at);
    }
  } finally {
    db.close();
  }
}

export interface Turn {
  /** The 1-based line of the transcript file. */
  line: number;
  /** The owner's words, redacted, whitespace flattened. */
  text: string;
}

export interface Candidate {
  line: number;
  quote: string;
}

/** Text Claude Code writes into a user record that the owner did not type: command wrappers, reminders, hook output. */
const NOT_TYPED = /^</;

/** Stands in for text inside a private span; a sentence holding it is never a correction. */
const HIDDEN = '\uE000';

/** Where the private-span scan stands: the nesting depth, and a possible start of a tag cut off at the end of the last piece. */
interface Spans {
  depth: number;
  held: string;
}
const TAGS = ['<private>', '</private>'];

/**
 * Reads one piece of the transcript's single text stream, in order, and returns it with every private span replaced by
 * HIDDEN. Spans nest (text is private while the depth is above zero), an unmatched close tag is ignored, tags match in any
 * case, and the end of a piece that could be the start of a tag is held back so a tag split across blocks or records is
 * still seen. shortcut: a held start that turns out not to be a tag is emitted with the next piece, which may be another turn.
 */
function hidePrivate(text: string, state: Spans): string {
  const s = state.held + text;
  let out = '';
  let last = 0;
  for (const m of s.matchAll(/<(\/?)private>/gi)) {
    if (state.depth === 0) out += s.slice(last, m.index);
    if (m[1] === '') {
      if (state.depth === 0) out += HIDDEN;
      state.depth++;
    } else if (state.depth > 0 && --state.depth === 0) out += HIDDEN;
    last = m.index! + m[0].length;
  }
  const rest = s.slice(last);
  let keep = 0;
  for (let n = Math.min(rest.length, TAGS[1]!.length - 1); n > 0 && keep === 0; n--) {
    if (TAGS.some((t) => t.startsWith(rest.slice(rest.length - n).toLowerCase()))) keep = n;
  }
  state.held = rest.slice(rest.length - keep);
  const shown = rest.slice(0, rest.length - keep);
  return out + (state.depth > 0 ? HIDDEN : shown);
}

/** The closed list of fields that can never hold user text; every other string of a record is part of the stream. */
const NEVER_TEXT = new Set(['type', 'id', 'tool_use_id', 'role', 'uuid', 'parentUuid', 'messageId', 'sessionId', 'timestamp', 'cwd', 'version', 'gitBranch', 'userType', 'entrypoint', 'requestId']);

interface Frame {
  array: boolean;
  index: number;
  key: string;
  expectKey: boolean;
  skip: boolean;
}

/**
 * Yields the strings of one JSON line in the order they are written (JSON.parse and Object.entries reorder integer-like
 * keys, which would let a key written late close a span early): each value with its path of keys and indices, and any key
 * that holds a tag character. Ordinary keys are structure, not text, and fields on the never-text list are skipped with
 * their whole value. Only valid JSON is given to it; it reads the line once, without recursion.
 */
function* writtenStrings(row: string): Generator<{ path: (string | number)[]; text: string; key: boolean }> {
  const stack: Frame[] = [];
  const pathOf = (): (string | number)[] => stack.map((f) => (f.array ? f.index : f.key));
  let i = 0;
  while (i < row.length) {
    const c = row[i]!;
    const top = stack[stack.length - 1];
    if (c === '{' || c === '[') {
      stack.push({ array: c === '[', index: 0, key: '', expectKey: c === '{', skip: false });
      i++;
    } else if (c === '}' || c === ']') {
      stack.pop();
      i++;
    } else if (c === ',') {
      if (top?.array) top.index++;
      else if (top) {
        top.expectKey = true;
        top.skip = false;
      }
      i++;
    } else if (c === ':') {
      if (top) top.expectKey = false;
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < row.length && row[j] !== '"') j += row[j] === '\\' ? 2 : 1;
      const text = JSON.parse(row.slice(i, j + 1)) as string;
      i = j + 1;
      if (top !== undefined && !top.array && top.expectKey) {
        top.key = text;
        top.skip = NEVER_TEXT.has(text);
        if (!stack.some((f) => f.skip) && /[<>]/.test(text)) yield { path: pathOf().slice(0, -1), text, key: true };
      } else if (!stack.some((f) => f.skip)) yield { path: pathOf(), text, key: false };
    } else i++;
  }
}

/**
 * The owner's own turns of a Claude Code JSONL transcript, redacted (FR-005). Agent output, subagent (sidechain)
 * records, meta records and tool results are never returned, and text inside `<private>...</private>` is hidden
 * before redaction (the span state runs across the whole transcript, and a sentence touching a span is never quoted). A transcript holding the DO NOT INDEX THIS CHAT marker yields no turns at all.
 */
export function ownerTurns(file: string): Turn[] {
  const raw = readFileSync(file, 'utf8');
  if (/DO NOT INDEX THIS CHAT/.test(raw)) return [];
  const turns: Turn[] = [];
  const state: Spans = { depth: 0, held: '' };
  raw.split('\n').forEach((row, i) => {
    let o: { type?: string; isSidechain?: boolean; isMeta?: boolean };
    try {
      o = JSON.parse(row);
    } catch {
      hidePrivate(row, state);
      return;
    }
    // Every string of every record moves the span state, in written order; only an owner's text block (or string content) is mined.
    const eligible = o?.type === 'user' && o.isSidechain !== true && o.isMeta !== true;
    const content = (o as { message?: { content?: unknown } } | null)?.message?.content;
    const mine = (path: (string | number)[]): boolean =>
      eligible && path[0] === 'message' && path[1] === 'content' && (path.length === 2 || (path.length === 4 && path[3] === 'text' && (content as { type?: unknown }[] | undefined)?.[path[2] as number]?.type === 'text'));
    const pieces: string[] = [];
    for (const t of writtenStrings(row)) {
      const visible = hidePrivate(t.text, state);
      if (!t.key && mine(t.path)) pieces.push(visible);
    }
    const flat = scrub(pieces.join(' ')).replace(/\s+/g, ' ').trim();
    if (flat !== '' && flat !== HIDDEN && !NOT_TYPED.test(flat)) turns.push({ line: i + 1, text: flat });
  });
  return turns;
}

/** A sentence that starts by correcting what the agent did or chose. shortcut: English, sentence-initial cues only; a model batch can widen it. */
const CORRECTION = /^(?:no(?=[,.!:;])|no\s+(?:use|not|do|don'?t|that|it|the|wait|stop)\b|nope\b|wrong\b|stop\b|don'?t\b|do not\b|never\b|not that\b|that'?s (?:not|wrong)\b|actually\b|instead\b|please (?:don'?t|do not|stop|use)\b)/i;

/** The deterministic pass: owner sentences that open with a correction cue and have at least three words. The first turn is the task, not a correction. */
export function findCorrections(turns: Turn[]): Candidate[] {
  const out: Candidate[] = [];
  for (const t of turns.slice(1)) {
    for (const quote of t.text.split(/(?<=[.!?])\s+/)) {
      if (!quote.includes(HIDDEN) && CORRECTION.test(quote) && quote.split(/\s+/).length >= 3) out.push({ line: t.line, quote });
    }
  }
  return out;
}

export type Extract = (turns: Turn[]) => Candidate[];

/** FR-003: a candidate survives only if its quote is verbatim in the turn it names. */
export const verbatim = (turns: Turn[], candidates: Candidate[]): Candidate[] =>
  candidates.filter((c) => c.quote.trim() !== '' && !c.quote.includes(HIDDEN) && turns.some((t) => t.line === c.line && t.text.includes(c.quote)));

export interface Processed {
  read: number;
  proposed: number;
  missing: number;
}

/** Deletes records and episodes past their 30 days; runs on every sweep, whatever the opt-in says. */
export function expireTranscripts(db: DatabaseSync): number {
  const expired = Number(db.prepare('DELETE FROM transcripts WHERE at < ?').run(cutoff()).changes);
  if (expired > 0) recordAudit(db, 'transcripts_expired', null, { expired });
  return expired;
}

type Row = { id: string; session: string; repository: string; path: string };

/**
 * Stores each verbatim candidate as an owner proposal with the session and line as evidence. In the person file (tenant
 * '') it is a person item, refused when it names a path, code, a tenant or a repository (#80).
 */
function propose(db: DatabaseSync, tenant: string, config: Config, r: Row, turns: Turn[], candidates: Candidate[]): number {
  const person = tenant === '';
  const terms = person ? organisationTerms(config, r.repository || null) : undefined;
  let proposed = 0;
  for (const c of verbatim(turns, candidates)) {
    const statement = `Owner correction: "${c.quote}"`;
    const source = `transcript:${r.session}:L${c.line}:${basename(r.path)}`;
    if (refusal(statement, terms) !== null || refusal(source) !== null) continue;
    const stored = addItem(db, { tenant, scope: person ? 'person' : 'repository', scopeKey: person ? '' : r.repository, originRepository: r.repository || null, type: 'preference', statement, rationale: null, anchors: [], source, trust: 'owner', status: 'proposed' });
    if (stored.kind === 'inserted') proposed++;
  }
  return proposed;
}

/**
 * Finds the owner's corrections in every recorded transcript of this store, once each (FR-004): one proposal per
 * correction, owner trust, the session and line as evidence, nothing but the quote and that reference kept. A
 * transcript that is gone is skipped and counted; records past 30 days are deleted unread by `expireTranscripts`, which the sweep runs first. The store belongs to one
 * tenant, or is the person file (tenant ''), so what is read here can only reach that store.
 */
export function processTranscripts(db: DatabaseSync, tenant: string, config: Config, extract: Extract = findCorrections): Processed {
  const done: Processed = { read: 0, proposed: 0, missing: 0 };
  const rows = db.prepare("SELECT id, session, repository, path FROM transcripts WHERE kind = 'path' AND processed_at IS NULL ORDER BY at, id").all() as Row[];
  for (const r of rows) {
    let outcome = 'read';
    if (!existsSync(r.path)) {
      outcome = 'missing';
      done.missing++;
    } else if (automationRefusal(config, {}, r.path) !== null) {
      outcome = 'automation';
    } else {
      done.read++;
      const turns = ownerTurns(r.path);
      done.proposed += propose(db, tenant, config, r, turns, extract(turns));
    }
    db.prepare('UPDATE transcripts SET processed_at = ?, outcome = ? WHERE id = ?').run(new Date().toISOString(), outcome, r.id);
  }
  if (rows.length > 0) recordAudit(db, 'transcripts_processed', null, { ...done });
  return done;
}

/** The model pass's defaults (#80): a local Ollama and Inkling 2 Mini, which the owner installs; memory never downloads a model. */
export const MODEL_DEFAULTS = { url: 'http://127.0.0.1:11434', model: 'inkling-2-mini' };
/** Whether the model runs on the owner's machine, judged by its address. */
export const modelIsLocal = (url: string): boolean => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);

/** Asks the model for the corrections in these turns: the candidates, or why it failed. */
export type Ask = (turns: Turn[]) => Candidate[] | { failed: string };

/**
 * The model pass (#80), offline and never in a hook: each transcript the rule pass has read (outcome 'read') is given to
 * the model once, and what it returns goes through the same verbatim check. The first failure ends the pass with nothing
 * written for that transcript and nothing asked after it; those wait for the next run.
 */
export function modelTranscripts(db: DatabaseSync, tenant: string, config: Config, ask: Ask): { read: number; proposed: number; failed?: string } {
  const done: { read: number; proposed: number; failed?: string } = { read: 0, proposed: 0 };
  const rows = db.prepare("SELECT id, session, repository, path FROM transcripts WHERE kind = 'path' AND outcome = 'read' ORDER BY at, id").all() as Row[];
  for (const r of rows) {
    // The first turn is the task, as in the rule pass. A transcript gone or automated since then has nothing to ask.
    const turns = existsSync(r.path) && automationRefusal(config, {}, r.path) === null ? ownerTurns(r.path).slice(1) : [];
    const found = turns.length === 0 ? [] : ask(turns);
    if ('failed' in found) {
      done.failed = found.failed;
      break;
    }
    done.read++;
    done.proposed += propose(db, tenant, config, r, turns, found);
    db.prepare("UPDATE transcripts SET outcome = 'model' WHERE id = ?").run(r.id);
  }
  if (done.read > 0) recordAudit(db, 'transcripts_modelled', null, { read: done.read, proposed: done.proposed });
  return done;
}

/** A provider's answer, `{"status":"ok","corrections":[{"line", "quote"}]}` on its first line; anything else is a failure. */
export function parseCorrections(stdout: string): Candidate[] | { failed: string } {
  let o: { status?: unknown; corrections?: unknown };
  try {
    o = JSON.parse(stdout.split('\n')[0]!);
  } catch {
    return { failed: 'it answered text that is not JSON' };
  }
  if (o?.status !== 'ok' || !Array.isArray(o.corrections)) return { failed: 'it did not answer status ok with corrections' };
  return o.corrections.flatMap((c: { line?: unknown; quote?: unknown }) => (Number.isInteger(c?.line) && typeof c?.quote === 'string' ? [{ line: c.line as number, quote: c.quote }] : []));
}

const PROMPT = `You read the owner's own messages from a coding session, one per line as "L<number>: <text>".
Find each sentence in which the owner corrects what the agent did or chose, or says how the agent must work from now on.
Answer JSON only: {"corrections":[{"line":<number>,"quote":"<the sentence, copied character for character>"}]}.
Never paraphrase, shorten or fix a quote. Answer {"corrections":[]} when there is none.`;

/**
 * Memory's own Ollama client, which the provider runner runs as `memory model-client` so the runner's limits hold: the
 * request on stdin, one call to Ollama at its `url`, the answer as the provider protocol's one line.
 */
export async function ollamaClient(input: string): Promise<string> {
  const req = JSON.parse(input) as { url: string; model: string; turns: Turn[] };
  const res = await fetch(new URL('/api/generate', req.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: req.model, system: PROMPT, prompt: req.turns.map((t) => `L${t.line}: ${t.text}`).join('\n'), format: 'json', stream: false, options: { temperature: 0, num_predict: 2048 } }),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  const answer = JSON.parse(((await res.json()) as { response?: string }).response ?? '') as { corrections?: unknown };
  return `${JSON.stringify({ status: 'ok', corrections: Array.isArray(answer?.corrections) ? answer.corrections : [] })}\n`;
}
