import { onThisMachine, type Config } from '../config.ts';
import { searchTerms } from '../recall/rank.ts';

/** `kind` lets a provider that distinguishes queries from stored text (Voyage does) embed each as it should. */
export interface EmbeddingProvider {
  name: string;
  model: string;
  dims: number;
  /** Whether it runs on the owner's machine (#28): a client tenant's text goes to no other. */
  local: boolean;
  embed(texts: string[], kind?: 'query' | 'document'): Promise<Float32Array[]>;
}

/** A refusal or failure of the embedding provider. `noKey` is the normal state of a machine with no key: not worth a warning on a write. */
export class EmbedError extends Error {
  constructor(
    message: string,
    readonly noKey = false,
  ) {
    super(message);
  }
}

/** Why a tenant's text is not sent to `provider`. Every tenant is a client tenant; only the person file is the owner's own. */
export const notOnThisMachine = (provider: EmbeddingProvider, tenant: string): string =>
  `${tenant} is a client tenant, and its text goes only to an embedder on this machine (a 127.0.0.1, localhost or [::1] address); ${provider.name} is not`;

/** Reads wait this long, so a session never blocks on a slow network; writes may wait longer. */
export const READ_TIMEOUT_MS = 1500;
export const WRITE_TIMEOUT_MS = 20_000;

const VOYAGE_BATCH = 64;

function voyage(model: string, timeoutMs: number, env: NodeJS.ProcessEnv): EmbeddingProvider {
  const base = env['VOYAGE_BASE_URL'] ?? 'https://api.voyageai.com';
  return {
    name: 'voyage',
    model,
    dims: 1024,
    local: onThisMachine(new URL(base)),
    async embed(texts, kind = 'document') {
      const key = env['VOYAGE_API_KEY'];
      if (key === undefined || key === '') throw new EmbedError('VOYAGE_API_KEY is not set', true);
      const url = `${base}/v1/embeddings`;
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
        const input = texts.slice(i, i + VOYAGE_BATCH);
        let data: { index: number; embedding: number[] }[];
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ input, model, input_type: kind }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          // The body is never echoed: an error page may repeat the request.
          if (!res.ok) throw new EmbedError(`Voyage answered ${res.status}`);
          data = ((await res.json()) as { data: typeof data }).data;
        } catch (error) {
          if (error instanceof EmbedError) throw error;
          throw new EmbedError('Voyage is unreachable or too slow');
        }
        if (!Array.isArray(data) || data.length !== input.length) throw new EmbedError('Voyage returned an unexpected answer');
        for (const d of [...data].sort((a, b) => a.index - b.index)) out.push(Float32Array.from(d.embedding));
      }
      return out;
    },
  };
}

export const OLLAMA_URL = 'http://127.0.0.1:11434';

/** A local Ollama's embed endpoint (#28). Memory never pulls a model: one the owner has not installed is Ollama's 404. */
function ollama(model: string, base: string, timeoutMs: number): EmbeddingProvider {
  return {
    name: 'ollama',
    model,
    dims: 0, // whatever the model gives; each vector keeps its own length
    local: onThisMachine(new URL(base)),
    async embed(texts) {
      if (texts.length === 0) return [];
      let embeddings: number[][] | undefined;
      try {
        const res = await fetch(new URL('/api/embed', base), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new EmbedError(`Ollama answered ${res.status}${res.status === 404 ? `; is ${model} installed (ollama pull ${model})?` : ''}`);
        embeddings = ((await res.json().catch(() => null)) as { embeddings?: number[][] } | null)?.embeddings;
      } catch (error) {
        if (error instanceof EmbedError) throw error;
        throw new EmbedError(`Ollama at ${base} is unreachable or too slow`);
      }
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length || !embeddings.every(Array.isArray)) throw new EmbedError('Ollama returned an unexpected answer');
      return embeddings.map((e) => Float32Array.from(e));
    },
  };
}

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

/** Deterministic and offline, for tests: each word counts as its first three letters, so word forms of one stem are close. */
function fake(model: string): EmbeddingProvider {
  const dims = 256;
  return {
    name: 'fake',
    model,
    dims,
    local: true,
    embed: async (texts) =>
      texts.map((text) => {
        const v = new Float32Array(dims);
        for (const word of searchTerms(text, 1000)) v[fnv1a(word.slice(0, 3)) % dims]! += 1;
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      }),
  };
}

/** The provider `embeddings` in config.json names, or null when it names none: the semantic leg is off by default. */
export function providerFor(config: Config, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  if (config.embeddings === undefined) return null;
  const { provider, model, url } = config.embeddings;
  if (provider === 'fake') return fake(model ?? 'fake-prefix-1');
  if (provider === 'ollama') return ollama(model ?? 'bge-m3', url ?? OLLAMA_URL, timeoutMs);
  return voyage(model ?? 'voyage-4', timeoutMs, env);
}
