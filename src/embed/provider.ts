import type { Config } from '../config.ts';
import { searchTerms } from '../recall/rank.ts';

/** `kind` lets a provider that distinguishes queries from stored text (Voyage does) embed each as it should. */
export interface EmbeddingProvider {
  name: string;
  model: string;
  dims: number;
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

/** Reads wait this long, so a session never blocks on a slow network; writes may wait longer. */
export const READ_TIMEOUT_MS = 1500;
export const WRITE_TIMEOUT_MS = 20_000;

const VOYAGE_BATCH = 64;

function voyage(model: string, timeoutMs: number, env: NodeJS.ProcessEnv): EmbeddingProvider {
  return {
    name: 'voyage',
    model,
    dims: 1024,
    async embed(texts, kind = 'document') {
      const key = env['VOYAGE_API_KEY'];
      if (key === undefined || key === '') throw new EmbedError('VOYAGE_API_KEY is not set', true);
      const url = `${env['VOYAGE_BASE_URL'] ?? 'https://api.voyageai.com'}/v1/embeddings`;
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
    embed: async (texts) =>
      texts.map((text) => {
        const v = new Float32Array(dims);
        for (const word of searchTerms(text, 1000)) v[fnv1a(word.slice(0, 3)) % dims]! += 1;
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      }),
  };
}

/** The configured provider; voyage-4 unless `embeddings` in config.json says otherwise. */
export function providerFor(config: Config, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const { provider = 'voyage', model } = config.embeddings ?? {};
  return provider === 'fake' ? fake(model ?? 'fake-prefix-1') : voyage(model ?? 'voyage-4', timeoutMs, env);
}
