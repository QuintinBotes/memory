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

/** User and assistant text only, one line each as "L<n> <role>: <text>"; tool output is left out. */
function transcriptLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => {
      try {
        const o = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (o.type !== 'user' && o.type !== 'assistant') return '';
        const c = o.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => (b?.type === 'text' ? b.text ?? '' : '')).join(' ') : '';
        const flat = text.replace(/\s+/g, ' ').trim();
        return flat === '' ? '' : `L${i + 1} ${o.type}: ${flat}`;
      } catch {
        return '';
      }
    });
}

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
      const o = JSON.parse(line) as { message?: { content?: unknown } };
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
 * and anything from a session that read external content (`taint` names it), waits for the owner as a proposal; the rest is active.
 */
export function keepCandidates(
  db: DatabaseSync,
  context: { tenant: string; repository: string },
  candidates: Candidate[],
  from: { session: string; source: string; taint: string[] },
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
      type: c.kind === 'decision' ? 'decision' : 'precedent',
      statement,
      rationale: refusal(evidence) === null ? evidence : null,
      anchors: [],
      source: from.source,
      trust: 'agent' as const,
      ...(from.taint.length === 0 ? {} : { taint: from.taint.join(';') }),
    };
    const status = quarantineOf({ ...item, status: 'proposed' }) === null && from.taint.length === 0 ? ('active' as const) : ('proposed' as const);
    const stored = addItem(db, { ...item, status });
    if (stored.kind === 'merged') merged++;
    else if (stored.kind === 'inserted') {
      saved++;
      if (status === 'proposed') queued++;
      recordAudit(db, 'item_captured', { type: 'item', id: stored.id }, { session: from.session, agent: 'claude-code', status });
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
  const lines = transcriptLines(path);
  const seen = readState(data)[session] ?? 0;
  let text = lines.slice(seen).filter((l) => l !== '').join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(text.length - MAX_TRANSCRIPT_CHARS).replace(/^[^\n]*\n/, '');
  if (text === '' || (input['hook_event_name'] === 'Stop' && text.length < STOP_MIN_CHARS)) return 'nothing new to read';

  const settings = captureSettings(config);
  const model = filterModel(settings);
  const candidates = (await model.extract(scrub(text))).slice(0, settings.maxCandidates);

  const taint = externalSources(path);
  const db = openStore(tenantFile(data, context.tenant), true)!;
  let kept;
  try {
    kept = keepCandidates(db, context, candidates, { session, source: `capture:claude-code:${session}:${basename(path)}`, taint });
  } finally {
    db.close();
  }
  const { saved, merged, queued } = kept;
  const usage = model.usage ?? { input: 0, output: 0 };
  mkdirSync(join(data, 'logs'), { recursive: true, mode: 0o700 });
  appendFileSync(
    join(data, 'logs', 'capture.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), session, model: settings.model === 'haiku' ? settings.apiModel : settings.model, inputTokens: usage.input, outputTokens: usage.output, candidates: candidates.length, saved, merged })}\n`,
    { mode: 0o600 },
  );
  commitWatermark(data, session, lines.length);
  return `captured ${saved} (${queued} quarantined), merged ${merged} as evidence`;
}
