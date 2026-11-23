// Preloaded into every bundle a test runs (NODE_OPTIONS=--import): a call to fetch never leaves the machine. It is
// recorded to NO_NET_LOG and answered with an error that run() in helpers.mjs turns into a failing test.
import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url, init) => {
  if (process.env.NO_NET_LOG) appendFileSync(process.env.NO_NET_LOG, `${JSON.stringify({ url: String(url), body: init?.body ?? null })}\n`);
  // A test about overlapping runs: hold the call for NO_NET_DELAY_MS, then answer NO_NET_REPLY as the model's text.
  if (process.env.NO_NET_DELAY_MS) await new Promise((ok) => setTimeout(ok, Number(process.env.NO_NET_DELAY_MS)));
  if (process.env.NO_NET_REPLY) {
    return Response.json({ content: [{ type: 'text', text: process.env.NO_NET_REPLY }], usage: { input_tokens: 1, output_tokens: 1 } });
  }
  throw new Error('NETWORK: a test reached the network');
};
