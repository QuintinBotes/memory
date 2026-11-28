import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { automationRefusal } from '../automation.ts';
import { captureSettings, consented, loadConfig, type Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { resolveContext } from '../context.ts';
import { EMAIL, HANDLE, WEBHOOK, refusal } from '../gate.ts';
import { addItem } from '../consolidate.ts';
import { quarantineOf } from '../items.ts';
import { currentConfigDir } from '../config.ts';
import { redact } from '../redact/redact.ts';
import { recordAudit } from '../store/audit.ts';
import { openStore } from '../store/db.ts';
import { tenantFile } from '../store/paths.ts';
import type { DatabaseSync } from 'node:sqlite';
import { filterModel, type Candidate } from './model.ts';
import { DAILY_CAP, dailyCap } from './cost.ts';
import { HIDDEN, hidePrivateRecords } from './transcripts.ts';

/** The newest this many characters of a session go to the model. */
export const MAX_TRANSCRIPT_CHARS = 48_000;
/** A Stop (after every reply) waits for this much new text; SessionEnd takes whatever is left. */
const STOP_MIN_CHARS = 4_000;

/** Whether this config lets capture run at all; the hook checks this before it spawns anything. */
export const captureWanted = (config: Config | null): config is Config =>
  consented(config) && covers(config, 'capture') && captureSettings(config).enabled;

/** Everything that must not leave the machine: credentials, emails, handles, webhook URLs, key headers. */
export function scrub(text: string): string {
  return redact(text)
    .text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]')
    .replace(new RegExp(WEBHOOK.source, 'gi'), '[REDACTED:WEBHOOK]')
    .replace(new RegExp(EMAIL.source, 'g'), '[REDACTED:EMAIL]')
    .replace(new RegExp(HANDLE.source, 'g'), '[REDACTED:HANDLE]');
}

/** A parsed log line; each adapter checks the shape it reads. */
type LogRecord = any;
/** The text of a message's content: a string, or the blocks of the given kinds joined. */
const blocks = (c: unknown, kinds: string[]): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => (kinds.includes(b?.type ?? '') ? b.text ?? '' : '')).join(' ') : '';
const said = (role: unknown, text: string): [string, string] | null => (role === 'user' || role === 'assistant' ? [role, text] : null);
/** A user-role message Codex writes itself: its environment context, user instructions, or the AGENTS.md block. */
const CODEX_INJECTED = /^\s*(?:<|#\s*AGENTS\.md instructions\b)/;

/**
 * One adapter per agent whose session log capture reads (#48): the name provenance gives it, a record only its log
 * holds, and the user or assistant text of a record. Tool calls and output, system and developer text are left out.
 */
const ADAPTERS: { agent: string; owns: (o: LogRecord) => boolean; turn: (o: LogRecord) => [string, string] | null }[] = [
  {
    agent: 'claude-code',
    // Every Claude Code record carries its session id, so a transcript with no message yet is still known.
    owns: (o) => typeof o.type === 'string' && (typeof o.sessionId === 'string' || ((o.type === 'user' || o.type === 'assistant') && typeof o.message === 'object')),
    turn: (o) => said(o.type, blocks(o.message?.content, ['text'])),
  },
  {
    // A Codex rollout log, ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl: a session_meta record, then response items and events.
    agent: 'codex',
    owns: (o) => o.type === 'session_meta' && typeof o.payload === 'object',
    turn: (o) => {
      if (o.type !== 'response_item' || o.payload?.type !== 'message') return null;
      const text = blocks(o.payload.content, ['input_text', 'output_text']);
      return o.payload.role === 'user' && CODEX_INJECTED.test(text) ? null : said(o.payload.role, text);
    },
  },
];

/** The owner's opt-out for a whole session; only in a message the owner typed, never in agent text or a tool result (#143). */
export const OPT_OUT = 'DO NOT INDEX THIS CHAT';

/**
 * The agent that wrote the log, its user and assistant text, one line each as "L<n> <role>: <text>", and whether the
 * owner wrote OPT_OUT; null for a format no adapter knows. Text inside `<private>` spans is hidden first, and a sentence
 * that touches one is dropped whole.
 */
function readLog(file: string): { agent: string; lines: string[]; optedOut: boolean; complete: number } | null {
  const raw = readFileSync(file, 'utf8');
  // shortcut: a tag split across records with no whole tag anywhere in the log is not seen; the plain parse keeps a log without spans byte-identical.
  const records: LogRecord[] = /<\/?private>/i.test(raw)
    ? hidePrivateRecords(raw)
    : raw.split('\n').map((line) => {
        try {
          const o: unknown = JSON.parse(line);
          return typeof o === 'object' && o !== null ? o : null;
        } catch {
          return null;
        }
      });
  const adapter = ADAPTERS.find((a) => records.some((o) => o !== null && a.owns(o)));
  if (adapter === undefined) return null;
  let optedOut = false;
  const lines = records.map((o, i) => {
    const turn = o === null ? null : adapter.turn(o);
    if (turn?.[0] === 'user' && o.isMeta !== true && o.isSidechain !== true && !/^\s*</.test(turn[1]) && turn[1].includes(OPT_OUT)) optedOut = true;
    let flat = turn?.[1].replace(/\s+/g, ' ').trim() ?? '';
    if (flat.includes(HIDDEN)) flat = flat.split(/(?<=[.!?])\s+/).filter((s) => !s.includes(HIDDEN)).join(' ');
    return flat === '' ? '' : `L${i + 1} ${turn![0]}: ${flat}`;
  });
  // The watermark counts finished records only: not the empty piece after the last newline, nor a record still being written (#147).
  return { agent: adapter.agent, lines, optedOut, complete: records.length - (records.at(-1) == null ? 1 : 0) };
}

const summarise = (data: string, record: Record<string, unknown>): void => {
  mkdirSync(join(data, 'logs'), { recursive: true, mode: 0o700 });
  appendFileSync(join(data, 'logs', 'capture.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
};

/**
 * FR-006 of #22: the external content a session read, from the tool calls its transcript records: web pages and
 * searches, and the tools of any MCP server but memory's own. Named by host or server, sorted, at most three.
 * shortcut: a tool result from inside the tenant (a self-hosted tracker's MCP server) and a page read through a shell
 * command (curl, gh) are not told apart or seen; revisit when Claude Code marks tool results by origin.
 */
export function externalSources(file: string): string[] {
  const found = new Set<string>();
  const label = (s: string): string => s.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 60);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const o = JSON.parse(line) as { message?: { content?: unknown }; payload?: { type?: unknown } };
      // shortcut: of a Codex log only its web search is seen, not its MCP tool calls; revisit with a fixture of those.
      if (o.payload?.type === 'web_search_call') found.add('web:search');
      const content = o.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as { type?: string; name?: string; input?: { url?: unknown } }[]) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
        if (b.name === 'WebFetch' || b.name === 'WebSearch') {
          let host = 'search';
          try {
            if (typeof b.input?.url === 'string') host = new URL(b.input.url).hostname;
          } catch {
            // A url that does not parse names no host.
          }
          found.add(`web:${label(host)}`);
        } else if (b.name.startsWith('mcp__')) {
          const server = b.name.split('__')[1] ?? '';
          if (!/^(?:plugin_memory_)?memory$/.test(server)) found.add(`mcp:${label(server)}`);
        }
      }
    } catch {
      // Not a JSON line.
    }
  }
  return [...found].sort().slice(0, 3);
}

const stateFile = (data: string): string => join(data, 'logs', 'capture-state.json');
const readState = (data: string): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(stateFile(data), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
};

/** A capture holds its session for a model call (60 s) and the store writes; past this a lock is taken to be dead. */
const LOCK_STALE_MS = 5 * 60_000;

/** Takes an exclusive-create lock file; false when a live holder has it. shortcut: two takers of one stale lock can race; the same-source check keeps that to one item. */
function tryLock(file: string): boolean {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(file).mtimeMs <= LOCK_STALE_MS) return false;
      unlinkSync(file);
    } catch {
      return false;
    }
    return tryLock(file);
  }
}

const unlock = (file: string): void => {
  try {
    unlinkSync(file);
  } catch {
    // Already gone: a stale lock another run took over.
  }
};

/** Sets one session's watermark, never lower, under a short lock and by temp file and rename, so no session's mark is lost or torn. */
function commitWatermark(data: string, session: string, lines: number): void {
  const lock = `${stateFile(data)}.lock`;
  const until = Date.now() + 10_000;
  while (!tryLock(lock)) {
    if (Date.now() > until) throw new Error('the capture state is locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try {
    const state = readState(data);
    state[session] = Math.max(state[session] ?? 0, lines);
    const tmp = `${stateFile(data)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, stateFile(data));
  } finally {
    unlock(lock);
  }
}

/**
 * Runs one capture for a Stop or SessionEnd hook's input and says what it did. Throws when the filter fails, so
 * the caller can report it; nothing is stored then and the same text is read again next time.
 */
export async function capture(data: string, input: Record<string, unknown>): Promise<string> {
  const config = loadConfig(data);
  if (!captureWanted(config)) return 'capture is off';
  const automated = automationRefusal(config, process.env, typeof input['transcript_path'] === 'string' ? input['transcript_path'] : undefined);
  if (automated !== null) return `nothing captured: ${automated}`;
  const cwd = typeof input['cwd'] === 'string' && input['cwd'] !== '' ? input['cwd'] : process.cwd();
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null) return `nothing captured: ${context.reason}`;
  const path = input['transcript_path'];
  const session = typeof input['session_id'] === 'string' && input['session_id'] !== '' ? input['session_id'] : 'unknown';
  if (typeof path !== 'string' || !existsSync(path)) return 'nothing captured: no transcript';

  // The lock reserves the session's unread range for this run; a run that finds it held leaves the text to the next Stop.
  const lock = join(data, 'logs', 'capture-locks', `${createHash('sha256').update(session).digest('hex').slice(0, 16)}.lock`);
  if (!tryLock(lock)) return 'nothing captured: another capture of this session is already running';
  try {
    return await captureLocked(data, config, { tenant: context.tenant, repository: context.repository }, path, session, input);
  } finally {
    unlock(lock);
  }
}

/**
 * Stores what the filter kept as agent-trust items, merging repeats as evidence. Text that reads as an instruction,
 * waits for the owner as a proposal; the rest is active. A session that read external content (`taint` names it) only
 * labels what it kept: the label is evidence, not a reason to queue.
 */
export function keepCandidates(
  db: DatabaseSync,
  context: { tenant: string; repository: string },
  candidates: Candidate[],
  from: { session: string; agent: string; source: string; taint: string[] },
): { saved: number; merged: number; queued: number } {
  let saved = 0;
  let merged = 0;
  let queued = 0;
  for (const c of candidates) {
    const statement = c.statement.replace(/\s+/g, ' ').trim();
    if (refusal(statement) !== null) continue;
    const evidence = `Evidence: ${c.evidence.replace(/\s+/g, ' ').trim()}`.slice(0, 200);
    const item = {
      tenant: context.tenant,
      scope: 'repository' as const,
      scopeKey: context.repository,
      originRepository: context.repository,
      type: c.kind === 'decision' ? 'decision' : 'precedent',
      statement,
      rationale: refusal(evidence) === null ? evidence : null,
      anchors: [],
      source: from.source,
      trust: 'agent' as const,
      ...(from.taint.length === 0 ? {} : { taint: from.taint.join(';') }),
    };
    const status = quarantineOf({ ...item, status: 'proposed' }) === null ? ('active' as const) : ('proposed' as const);
    const stored = addItem(db, { ...item, status });
    if (stored.kind === 'merged') merged++;
    else if (stored.kind === 'inserted') {
      saved++;
      if (status === 'proposed') queued++;
      recordAudit(db, 'item_captured', { type: 'item', id: stored.id }, { session: from.session, agent: from.agent, status });
    }
  }
  return { saved, merged, queued };
}

async function captureLocked(
  data: string,
  config: Config,
  context: { tenant: string; repository: string },
  path: string,
  session: string,
  input: Record<string, unknown>,
): Promise<string> {
  const log = readLog(path);
  if (log === null) {
    const skipped = `${basename(path)}: unknown log format`;
    summarise(data, { session, skipped, saved: 0 });
    return `nothing captured: skipped ${skipped}`;
  }
  const { agent, lines, complete } = log;
  // The owner's opt-outs (#143), checked at every run before any model call.
  const taint = externalSources(path);
  const optOut = log.optedOut ? `the owner wrote ${OPT_OUT}` : captureSettings(config).skipTainted && taint.length > 0 ? `the session read ${taint.join(', ')} and skipTainted is on` : null;
  if (optOut !== null) {
    summarise(data, { session, agent, skipped: optOut, saved: 0 });
    return `nothing captured: ${optOut}`;
  }
  const seen = readState(data)[session] ?? 0;
  let text = lines.slice(seen, complete).filter((l) => l !== '').join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(text.length - MAX_TRANSCRIPT_CHARS).replace(/^[^\n]*\n/, '');
  if (text === '') return 'nothing new to read';
  // A Stop waits for enough to be worth a model call; the session's end reads it whatever its length (#126).
  if (input['hook_event_name'] === 'Stop' && text.length < STOP_MIN_CHARS) {
    summarise(data, { session, agent, skipped: `shorter than ${STOP_MIN_CHARS} characters`, saved: 0 });
    return `waiting for more: ${text.length} of ${STOP_MIN_CHARS} characters; the session's end reads it whatever its length`;
  }

  const settings = captureSettings(config);
  // Over a daily cap (#140): no model call, and the watermark stays, so tomorrow's first run reads this text.
  const capped = dailyCap(data, settings, session);
  if (capped !== null) {
    summarise(data, { session, agent, skipped: DAILY_CAP, saved: 0 });
    return capped.told ? `nothing captured: ${DAILY_CAP}` : `skipped, daily cap reached: ${capped.reason}; capture resumes tomorrow from where it stopped`;
  }
  const model = filterModel(settings);
  const candidates = (await model.extract(scrub(text))).slice(0, settings.maxCandidates);

  const db = openStore(tenantFile(data, context.tenant), true)!;
  let kept;
  try {
    kept = keepCandidates(db, context, candidates, { session, agent, source: `capture:${agent}:${session}:${basename(path)}`, taint });
  } finally {
    db.close();
  }
  const { saved, merged, queued } = kept;
  const usage = model.usage ?? { input: 0, output: 0 };
  summarise(data, { session, agent, model: settings.model === 'haiku' ? settings.apiModel : settings.model, inputTokens: usage.input, outputTokens: usage.output, via: model.via, candidates: candidates.length, saved, merged });
  commitWatermark(data, session, complete);
  return `captured ${saved} (${queued} quarantined), merged ${merged} as evidence`;
}
