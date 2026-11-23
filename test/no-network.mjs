// Preloaded into every bundle the tests start: a call to any host but this machine is refused and logged,
// and the helper that started the bundle fails the test. Tests use the fake embedding provider only.
import { appendFileSync } from 'node:fs';

const real = globalThis.fetch;
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
  if (!LOCAL.has(url.hostname)) {
    appendFileSync(process.env.MEMORY_TEST_NETLOG, `${url.href}\n`);
    return Promise.reject(new TypeError('fetch failed: the test guard blocks the network'));
  }
  return real(input, init);
};
