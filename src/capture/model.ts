import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { CaptureConfig } from '../config.ts';
import { modelTimeoutMs } from '../provider/run.ts';

/** One lesson or decision a filter kept, with the line or file:line that shows it. */
export interface Candidate {
  kind: 'lesson' | 'decision';
  statement: string;
  evidence: string;
}

/** `usage` is set by `extract` when the model reports tokens, for the cost log. */
export interface FilterModel {
  extract(transcriptText: string): Promise<Candidate[]>;
  usage?: { input: number; output: number };
}

const PROMPT = `You read a redacted coding-session transcript. Each line is "L<number> <role>: <text>".
Keep only lessons (something learned that will matter again) and decisions (a choice made, with its reason).
Skip chatter, progress reports, plans, questions and anything one-off.
Answer with a JSON array only, no prose. Each element: {"kind":"lesson"|"decision","statement":"one sentence","evidence":"the transcript line, as L<number>, or file:line"}.
Answer [] when nothing qualifies.`;

/** Parses the model's text into candidates; anything that is not a well-formed element is dropped. */
export function parseCandidates(text: string): Candidate[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e: Record<string, unknown>) =>
    (e?.['kind'] === 'lesson' || e?.['kind'] === 'decision') && typeof e['statement'] === 'string' && typeof e['evidence'] === 'string'
      ? [{ kind: e['kind'], statement: e['statement'], evidence: e['evidence'] }]
      : [],
  );
}

/** Claude Haiku over the Messages API (plain fetch, no SDK) with ANTHROPIC_API_KEY, else through the claude CLI's own login. */
export function haiku(apiModel: string, env: NodeJS.ProcessEnv = process.env): FilterModel {
  const model: FilterModel = {
    async extract(text) {
      const key = env['ANTHROPIC_API_KEY'];
      if (key === undefined || key === '') return viaCli(model, apiModel, text, env);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: apiModel, max_tokens: 1024, system: PROMPT, messages: [{ role: 'user', content: text }] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`the Anthropic API answered ${res.status}`);
      const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      model.usage = { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 };
      return parseCandidates((body.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join(''));
    },
  };
  return model;
}

/**
 * No key: the person's own Claude Code login, through `claude -p` with no tools, MCP, hooks, settings or saved session,
 * so the call cannot recurse into capture or leave a transcript. Only what the login needs reaches it (USER: the macOS keychain).
 */
function viaCli(model: FilterModel, apiModel: string, text: string, env: NodeJS.ProcessEnv): Candidate[] {
  const pass: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'TMPDIR', 'CLAUDE_CONFIG_DIR']) if (env[k] !== undefined) pass[k] = env[k]!;
  const args = ['-p', '--model', apiModel, '--system-prompt', PROMPT, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}'];
  const r = spawnSync('claude', args, { cwd: tmpdir(), env: pass, input: text, encoding: 'utf8', timeout: modelTimeoutMs(env), killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
  if (r.error !== undefined) throw new Error((r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no ANTHROPIC_API_KEY and no claude on PATH; capture needs one of them' : `claude -p failed: ${r.error.message}`);
  let body: { is_error?: boolean; result?: unknown; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
  try {
    body = JSON.parse(r.stdout);
  } catch {
    throw new Error(`claude -p exited ${r.status ?? 'by signal'} without a JSON answer`);
  }
  if (body.is_error === true || typeof body.result !== 'string') throw new Error(`claude -p answered an error: ${String(body.result ?? 'no result').slice(0, 200)}`);
  const u = body.usage ?? {};
  // The CLI caches the system prompt, so most input is reported in the cache fields.
  model.usage = { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0 };
  return parseCandidates(body.result);
}

/** Deterministic, for tests: keeps each line whose text starts with "LESSON:" or "DECISION:". */
export function fake(): FilterModel {
  const model: FilterModel = {
    async extract(text) {
      model.usage = { input: Math.ceil(text.length / 4), output: 0 };
      return [...text.matchAll(/^L(\d+) \w+: (LESSON|DECISION): (.+)$/gm)].map((m) => ({
        kind: m[2] === 'LESSON' ? 'lesson' : 'decision',
        statement: m[3]!,
        evidence: `L${m[1]}`,
      }));
    },
  };
  return model;
}

export function filterModel(settings: Required<CaptureConfig>, env: NodeJS.ProcessEnv = process.env): FilterModel {
  if (settings.model === 'haiku') return haiku(settings.apiModel, env);
  if (settings.model === 'fake') return fake();
  throw new Error(`capture.model "${settings.model}" is not a filter; use haiku or fake`);
}
