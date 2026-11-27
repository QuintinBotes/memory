import { scrub } from '../capture/capture.ts';
import { onThisMachine, type Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import type { Context } from '../context.ts';
import { OLLAMA_URL } from '../embed/provider.ts';
import { refusal } from '../gate.ts';
import type { Hit } from './rank.ts';

/** The reranker's defaults (#28): the loopback Ollama and Inkling 2 Mini of #80's model pass, which the owner installs; memory never downloads a model. */
export const RERANK_DEFAULTS = { url: OLLAMA_URL, model: 'inkling-2-mini' };
/** A generative model is slower than an embedder; past this the fused order stands. */
export const RERANK_TIMEOUT_MS = 3000;

const PROMPT = `You rank remembered facts by how well each answers a search query.
The facts are numbered. Answer JSON only: {"order":[<the numbers, most relevant first>]}.`;

/**
 * The optional reranker (#28), reached only by memory_search and diff recall, never by a hook: the model in `rerank`
 * reorders `hits`, and each row adds its new place as `rerank`. Without `rerank` the hits are returned as they are; on a
 * refusal, a failure or a timeout they keep their order and the note says the rerank was skipped and why.
 */
export async function rerank(config: Config, context: Context, query: string, hits: Hit[]): Promise<{ hits: Hit[]; note?: string }> {
  if (config.rerank === undefined || hits.length < 2) return { hits };
  const { url, model } = { ...RERANK_DEFAULTS, ...config.rerank };
  const skipped = (reason: string): { hits: Hit[]; note: string } => ({ hits, note: `Rerank skipped (${reason}); the fused order stands.` });
  if (!covers(config, 'embeddings')) return skipped('your consent does not cover it yet; run memory init and confirm');
  // Every tenant is a client tenant; only the person file's text may go to a model elsewhere.
  if (context.tenant !== null && !onThisMachine(new URL(url))) {
    return skipped(`${context.tenant} is a client tenant, and its text goes only to a model on this machine (a 127.0.0.1, localhost or [::1] address); ${url} is not`);
  }
  const refused = refusal(query);
  if (refused !== null) return skipped(`the query cannot be sent: ${refused}`);
  let answer: unknown;
  try {
    const res = await fetch(new URL('/api/generate', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, system: PROMPT, format: 'json', stream: false, options: { temperature: 0 },
        prompt: `Query: ${scrub(query)}\n${hits.map((h, i) => `${i + 1}. ${h.item.statement}`).join('\n')}`,
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });
    if (!res.ok) return skipped(`Ollama answered ${res.status}${res.status === 404 ? `; is ${model} installed?` : ''}`);
    answer = JSON.parse(((await res.json()) as { response?: string }).response ?? '');
  } catch (error) {
    return skipped(error instanceof SyntaxError ? `${model} did not answer JSON` : `${model} at ${url} is unreachable or too slow`);
  }
  const order = (answer as { order?: unknown } | null)?.order;
  const picked = Array.isArray(order) ? [...new Set(order.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= hits.length).map((n) => n - 1))] : [];
  if (picked.length === 0) return skipped(`${model} returned no order`);
  // A row the model left out keeps its fused place after the ones it ranked.
  const all = [...picked, ...hits.map((_, i) => i).filter((i) => !picked.includes(i))];
  return { hits: all.map((i, at) => ({ ...hits[i]!, why: `${hits[i]!.why}, rerank ${at + 1}` })) };
}
