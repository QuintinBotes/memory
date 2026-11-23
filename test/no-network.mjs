// Preloaded into every bundle a test runs (NODE_OPTIONS=--import): a call to any host but this machine never leaves it.
// It is recorded to NO_NET_LOG and answered with an error that run() in helpers.mjs turns into a failing test.
// A stub server on this machine (the embeddings tests) is reached for real.
import { appendFileSync } from 'node:fs';

const real = globalThis.fetch;
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
  if (LOCAL.has(url.hostname)) return real(input, init);
  if (process.env.NO_NET_LOG) appendFileSync(process.env.NO_NET_LOG, `${JSON.stringify({ url: url.href, body: init?.body ?? null })}\n`);
  // A test about overlapping runs: hold the call for NO_NET_DELAY_MS, then answer NO_NET_REPLY as the model's text.
  if (process.env.NO_NET_DELAY_MS) await new Promise((ok) => setTimeout(ok, Number(process.env.NO_NET_DELAY_MS)));
  if (process.env.NO_NET_REPLY) {
    return Response.json({ content: [{ type: 'text', text: process.env.NO_NET_REPLY }], usage: { input_tokens: 1, output_tokens: 1 } });
  }
  throw new Error('NETWORK: a test reached the network');
};
