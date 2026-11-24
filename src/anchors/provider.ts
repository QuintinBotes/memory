import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** What a provider says of one symbol (docs/provider.md): `hash` is the content hash of its declaration with its own name masked. */
export interface ProviderSymbol {
  key: string;
  kind: string;
  signature: string;
  start: number;
  end: number;
  hash: string;
}

export interface Changes {
  snapshot: string;
  /** False when the provider no longer holds the snapshot asked about: every anchor is then re-resolved. */
  sinceFound: boolean;
  files: string[];
  added: ProviderSymbol[];
  removed: ProviderSymbol[];
  changed: ProviderSymbol[];
}

/** The provider failed, timed out or answered something that is not the protocol. Nothing it said is used. */
export class ProviderError extends Error {}
/** The provider answered about a repository other than the one asked about: dropped before anything is looked up. */
export class ForeignAnswer extends ProviderError {}

/** How long one request may take; the same bound as the impact provider's (#16). */
export const PROVIDER_TIMEOUT_MS = 5000;

export interface Provider {
  /** One request, one answer, checked to be about `repository`. */
  ask(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * The provider command is run without a shell, with only PATH and HOME in its environment, once per request: the request
 * is one JSON line on its standard input, the answer the first line of its standard output (the same protocol shape as the
 * impact provider, `{"status": "ok" | "no_snapshot" | "error", ...}`). The process is stopped once it has answered.
 */
export function openProvider(config: { command: string[] }, repository: string, cwd: string): Provider {
  const [program = '', ...args] = config.command;
  return {
    ask: (op, params) =>
      new Promise((ok, fail) => {
        let done = false;
        const finish = (outcome: () => void): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.kill();
          outcome();
        };
        const child = spawn(program, args, { cwd, env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' }, stdio: ['pipe', 'pipe', 'ignore'] });
        const timer = setTimeout(() => finish(() => fail(new ProviderError(`the provider did not answer ${op} within ${PROVIDER_TIMEOUT_MS} ms`))), PROVIDER_TIMEOUT_MS);
        child.on('error', (e) => finish(() => fail(new ProviderError(`could not start ${program}: ${e.message}`))));
        child.on('close', (code) => finish(() => fail(new ProviderError(`${program} exited (${code ?? 'signal'}) without answering ${op}`))));
        child.stdin.on('error', () => undefined);
        child.stdin.end(`${JSON.stringify({ op, repository, ...params })}\n`);
        createInterface({ input: child.stdout }).once('line', (line) =>
          finish(() => {
            let answer: unknown;
            try {
              answer = JSON.parse(line);
            } catch {
              return fail(new ProviderError('the provider answered with text that is not JSON'));
            }
            const a = answer as Record<string, unknown>;
            if (typeof a !== 'object' || a === null) return fail(new ProviderError('the provider answered with something that is not an object'));
            if (a['status'] === 'no_snapshot') return fail(new ProviderError('the provider has no snapshot of this repository yet'));
            if (a['status'] !== 'ok') return fail(new ProviderError(`the provider refused ${op}${typeof a['error'] === 'string' ? `: ${a['error']}` : ''}`));
            // The tenant check comes first: nothing of an answer about another repository is read.
            if (a['repository'] !== repository) return fail(new ForeignAnswer(`the provider answered about ${String(a['repository'])}, not ${repository}; the answer was dropped`));
            ok(a);
          }),
        );
      }),
    close: () => undefined,
  };
}

const bad = (what: string): never => {
  throw new ProviderError(`the provider's answer has no valid ${what}`);
};
const text = (v: unknown, what: string): string => (typeof v === 'string' && v !== '' ? v : bad(what));
const whole = (v: unknown, what: string): number => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : bad(what));

export function asSymbol(v: unknown): ProviderSymbol {
  const s = v as Record<string, unknown>;
  if (typeof s !== 'object' || s === null) return bad('symbol');
  const [start, end] = [whole(s['start'], 'start line'), whole(s['end'], 'end line')];
  if (end < start) bad('line range');
  return { key: text(s['key'], 'symbol key'), kind: text(s['kind'], 'kind'), signature: typeof s['signature'] === 'string' ? s['signature'] : bad('signature'), start, end, hash: text(s['hash'], 'content hash') };
}
const symbols = (v: unknown, what: string): ProviderSymbol[] => (Array.isArray(v) ? v.map(asSymbol) : bad(what));

/** Operation 1: the symbol a key names at the provider's current snapshot, or null when it is gone. */
export async function resolveKey(p: Provider, key: string): Promise<{ snapshot: string; symbol: ProviderSymbol | null }> {
  const a = await p.ask('key', { key });
  return { snapshot: text(a['snapshot'], 'snapshot'), symbol: a['symbol'] === null ? null : asSymbol(a['symbol']) };
}

/** Operation 2: the innermost symbol enclosing `path` at `line`, or null. */
export async function symbolAt(p: Provider, path: string, line: number): Promise<{ snapshot: string; symbol: ProviderSymbol | null }> {
  const a = await p.ask('symbol_at', { path, line });
  return { snapshot: text(a['snapshot'], 'snapshot'), symbol: a['symbol'] === null ? null : asSymbol(a['symbol']) };
}

/** Operation 3: what changed since snapshot `since`. */
export async function changesSince(p: Provider, since: string): Promise<Changes> {
  const a = await p.ask('changes', { since });
  const files = a['files'];
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) bad('file list');
  return {
    snapshot: text(a['snapshot'], 'snapshot'),
    sinceFound: a['since_found'] !== false,
    files: files as string[],
    added: symbols(a['added'], 'added symbols'),
    removed: symbols(a['removed'], 'removed symbols'),
    changed: symbols(a['changed'], 'changed symbols'),
  };
}

// Slice 14's three words, and ProofMesh's own vocabulary.
const RELATIONS = ['caller', 'implementer', 'importer', 'calls', 'implements', 'overrides', 'inherits', 'imports'];
const STATUSES = ['changed', 'tested', 'neither'];
export interface Dependent {
  path: string;
  symbol?: string;
  relation: string;
  status: string;
}

/** Operation 4: the symbols that depend on `keys`, in the shape the impact provider answers `impact` with. Dependents of another repository are dropped. */
export async function impactOf(p: Provider, repository: string, keys: string[]): Promise<{ snapshot: string; dependents: Dependent[] }> {
  const a = await p.ask('symbol_impact', { keys });
  const list = a['dependents'];
  if (!Array.isArray(list)) bad('dependents');
  const dependents = (list as Record<string, unknown>[]).flatMap((d): Dependent[] => {
    if (d?.['repository'] !== undefined && String(d['repository']).toLowerCase() !== repository) return [];
    const [relation, status] = [text(d?.['relation'], 'relation'), text(d?.['status'], 'status')];
    if (!RELATIONS.includes(relation) || !STATUSES.includes(status)) bad('relation or status');
    return [{ path: text(d?.['path'], 'dependent path'), ...(typeof d?.['symbol'] === 'string' ? { symbol: d['symbol'] } : {}), relation, status }];
  });
  return { snapshot: text(a['snapshot'], 'snapshot'), dependents };
}

/** Operation 5: the tests that prove `key`, each with the evidence the provider has. */
export async function testsFor(p: Provider, key: string): Promise<{ snapshot: string; tests: { key: string; evidence: string }[] }> {
  const a = await p.ask('tests', { key });
  const list = a['tests'];
  if (!Array.isArray(list)) bad('tests');
  return { snapshot: text(a['snapshot'], 'snapshot'), tests: (list as Record<string, unknown>[]).map((d) => ({ key: text(d?.['key'], 'test key'), evidence: text(d?.['evidence'], 'evidence') })) };
}
