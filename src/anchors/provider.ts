import { runProvider } from '../provider/run.ts';

/**
 * What a provider says of one symbol (docs/provider.md): `hash` is the content hash of its declaration with its own name
 * masked. `end` defaults to `start`, and `signature` may be absent: then no signature change is ever seen.
 */
export interface ProviderSymbol {
  key: string;
  kind: string;
  signature?: string;
  start: number;
  end: number;
  hash: string;
}

export interface Changes {
  snapshot: string;
  /** The commit the snapshot indexed; absent when the provider does not say. */
  commit?: string;
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
/** The provider refused this one request (`status: "error"`): the provider is fine, the request is not. */
export class Refused extends ProviderError {}

export interface Provider {
  /** One request, one answer, checked to be about `repository`. */
  ask(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The provider command is run by the one shared runner (src/provider/run.ts): once per request, one JSON line each way. */
export function openProvider(config: { command: string[] }, repository: string, cwd: string): Provider {
  return {
    ask: async (op, params) => {
      const r = runProvider(config.command, cwd, { op, repository, ...params });
      if (!r.ok) throw new ProviderError(r.reason);
      let a: Record<string, unknown>;
      try {
        a = JSON.parse(r.stdout.split('\n')[0] ?? '') as Record<string, unknown>;
      } catch {
        throw new ProviderError('the provider answered with text that is not JSON');
      }
      if (typeof a !== 'object' || a === null) throw new ProviderError('the provider answered with something that is not an object');
      if (a['status'] === 'no_snapshot') throw new ProviderError('the provider has no snapshot of this repository yet');
      if (a['status'] === 'error') throw new Refused(`the provider refused ${op}${typeof a['error'] === 'string' ? `: ${a['error']}` : ''}`);
      if (a['status'] !== 'ok') throw new ProviderError(`the provider answered ${op} without a status`);
      // The tenant check comes first: nothing of an answer about another repository is read.
      if (a['repository'] !== repository) throw new ForeignAnswer(`the provider answered about ${String(a['repository'])}, not ${repository}; the answer was dropped`);
      return a;
    },
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
  const start = whole(s['start'], 'start line');
  const end = s['end'] === undefined ? start : whole(s['end'], 'end line');
  if (end < start) bad('line range');
  if (s['signature'] !== undefined && typeof s['signature'] !== 'string') bad('signature');
  return { key: text(s['key'], 'symbol key'), kind: text(s['kind'], 'kind'), ...(s['signature'] === undefined ? {} : { signature: s['signature'] as string }), start, end, hash: text(s['hash'], 'content hash') };
}
const symbols = (v: unknown, what: string): ProviderSymbol[] => (Array.isArray(v) ? v.map(asSymbol) : bad(what));
const commitOf = (a: Record<string, unknown>): { commit?: string } => (typeof a['commit'] === 'string' && a['commit'] !== '' ? { commit: a['commit'] } : {});

/** Operation 1: the symbol a key names at the current snapshot, or null when it is gone. */
export async function resolveKey(p: Provider, key: string): Promise<{ snapshot: string; commit?: string; symbol: ProviderSymbol | null }> {
  const a = await p.ask('key', { key });
  return { snapshot: text(a['snapshot'], 'snapshot'), ...commitOf(a), symbol: a['symbol'] === null ? null : asSymbol(a['symbol']) };
}

/** Operation 2: the innermost symbol enclosing `path` at `line`, or null. */
export async function symbolAt(p: Provider, path: string, line: number): Promise<{ snapshot: string; commit?: string; symbol: ProviderSymbol | null }> {
  const a = await p.ask('symbol_at', { path, line });
  return { snapshot: text(a['snapshot'], 'snapshot'), ...commitOf(a), symbol: a['symbol'] === null ? null : asSymbol(a['symbol']) };
}

/** Operation 3: what changed since snapshot `since`. */
export async function changesSince(p: Provider, since: string): Promise<Changes> {
  const a = await p.ask('changes', { since });
  const files = a['files'];
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) bad('file list');
  return {
    snapshot: text(a['snapshot'], 'snapshot'),
    ...commitOf(a),
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
    if (!RELATIONS.includes(relation) || !(STATUSES.includes(status) || status.startsWith('tested: '))) bad('relation or status');
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
