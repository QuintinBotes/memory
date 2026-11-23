// Preloaded into every bundle a test runs (NODE_OPTIONS=--import): a call to fetch never leaves the machine. It is
// recorded to NO_NET_LOG and answered with an error that run() in helpers.mjs turns into a failing test.
import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url, init) => {
  if (process.env.NO_NET_LOG) appendFileSync(process.env.NO_NET_LOG, `${JSON.stringify({ url: String(url), body: init?.body ?? null })}\n`);
  throw new Error('NETWORK: a test reached the network');
};
