import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
import { filterModel } from './model.ts';

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

const stateFile = (data: string): string => join(data, 'logs', 'capture-state.json');
const readState = (data: string): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(stateFile(data), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
};

/**
 * Runs one capture for a Stop or SessionEnd hook's input and says what it did. Throws when the filter fails, so
 * the caller can report it; nothing is stored then and the same text is read again next time.
 * shortcut: two captures of one session at once can both read the same lines; the same-source check keeps that to one item.
 */
export async function capture(data: string, input: Record<string, unknown>): Promise<string> {
  const config = loadConfig(data);
  if (!captureWanted(config)) return 'capture is off';
  const cwd = typeof input['cwd'] === 'string' && input['cwd'] !== '' ? input['cwd'] : process.cwd();
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null) return `nothing captured: ${context.reason}`;
  const path = input['transcript_path'];
  const session = typeof input['session_id'] === 'string' && input['session_id'] !== '' ? input['session_id'] : 'unknown';
  if (typeof path !== 'string' || !existsSync(path)) return 'nothing captured: no transcript';

  const lines = transcriptLines(path);
  const seen = readState(data)[session] ?? 0;
  let text = lines.slice(seen).filter((l) => l !== '').join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(text.length - MAX_TRANSCRIPT_CHARS).replace(/^[^\n]*\n/, '');
  if (text === '' || (input['hook_event_name'] === 'Stop' && text.length < STOP_MIN_CHARS)) return 'nothing new to read';

  const settings = captureSettings(config);
  const model = filterModel(settings);
  const candidates = (await model.extract(scrub(text))).slice(0, settings.maxCandidates);

  const db = openStore(tenantFile(data, context.tenant), true)!;
  let saved = 0;
  let merged = 0;
  let queued = 0;
  try {
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
        source: `capture:claude-code:${session}:${basename(path)}`,
        trust: 'agent' as const,
      };
      // Text that reads as an instruction waits for the owner, as any non-owner proposal does.
      const status = quarantineOf({ ...item, status: 'proposed' }) === null ? ('active' as const) : ('proposed' as const);
      const stored = addItem(db, { ...item, status });
      if (stored.kind === 'merged') merged++;
      else if (stored.kind === 'inserted') {
        saved++;
        if (status === 'proposed') queued++;
        recordAudit(db, 'item_captured', { type: 'item', id: stored.id }, { session, agent: 'claude-code', status });
      }
    }
  } finally {
    db.close();
  }
  const usage = model.usage ?? { input: 0, output: 0 };
  mkdirSync(join(data, 'logs'), { recursive: true, mode: 0o700 });
  appendFileSync(
    join(data, 'logs', 'capture.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), session, model: settings.model === 'haiku' ? settings.apiModel : settings.model, inputTokens: usage.input, outputTokens: usage.output, candidates: candidates.length, saved, merged })}\n`,
    { mode: 0o600 },
  );
  const state = readState(data);
  state[session] = lines.length;
  mkdirSync(dirname(stateFile(data)), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(data), JSON.stringify(state), { mode: 0o600 });
  return `captured ${saved} (${queued} quarantined), merged ${merged} as evidence`;
}
