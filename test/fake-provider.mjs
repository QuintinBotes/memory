// A fake code anchor provider for tests: `node fake-provider.mjs <fixture.json> <log>`. It reads the request on stdin,
// appends it to <log> (so a test counts calls), and answers from the fixture, read on every call:
//   op "impact" (diff recall): the fixture's `body`, or the fixture itself: { "status": "ok" | "no_snapshot", "dependents": [...] }
//   the symbol ops of docs/provider.md: from { repository, current, snapshots: { <id>: { commit?, symbols: [...] } },
//     answerRepository?, dependents?, tests?, gate?, badKeys? }
// A fixture "mode" makes it misbehave:
//   crash    exit 1
//   env      write the names of its environment variables to <log>.env, then answer normally
//   hang     ignore SIGTERM and sleep 30 s, writing <log>.survived if it is still alive then
//   flood    like hang, after writing 5 MB to stdout
//   garbage  answer text that is not JSON
//   gate     answer once the file named by `gate` exists
// A fixture "testsMode" misbehaves for the tests op only: refuse (status error), garbage, no_snapshot, hang (ignores SIGTERM, 30 s)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const [fixture, log] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
appendFileSync(log, `${input.trim()}\n`);
const s = JSON.parse(readFileSync(fixture, 'utf8'));
if (s.mode === 'crash') process.exit(1);
if (s.mode === 'hang' || s.mode === 'flood') {
  process.on('SIGTERM', () => {});
  if (s.mode === 'flood') process.stdout.write('x'.repeat(5 * 1024 * 1024));
  await new Promise((done) => setTimeout(done, 30_000));
  writeFileSync(`${log}.survived`, 'yes');
  process.exit(0);
}
if (s.mode === 'env') writeFileSync(`${log}.env`, JSON.stringify(Object.keys(process.env)));
const req = JSON.parse(input);
// Output is written whole and the process ends by itself: process.exit would cut a large answer short.
if (s.mode === 'garbage') process.stdout.write('this is not json\n');
else if (req.op === 'impact') process.stdout.write(JSON.stringify(s.body ?? s));
else await symbolOps();

async function symbolOps() {
if (s.mode === 'gate') while (!existsSync(s.gate)) await new Promise((done) => setTimeout(done, 20));
const byKey = (symbols) => new Map(symbols.map((x) => [x.key, x]));
const file = (key) => key.split('#')[0];
const snap = s.snapshots[s.current];
const now = snap.symbols;
const base = { status: 'ok', repository: s.answerRepository ?? s.repository, snapshot: s.current, ...(snap.commit === undefined ? {} : { commit: snap.commit }) };
if (req.op === 'tests' && s.testsMode === 'garbage') return void process.stdout.write('not json\n');
if (req.op === 'tests' && s.testsMode === 'hang') {
  process.on('SIGTERM', () => {});
  await new Promise((done) => setTimeout(done, 30_000));
}
const answer = (() => {
  switch (req.op) {
    case 'key':
      if ((s.badKeys ?? []).includes(req.key)) return { status: 'error', error: 'bad key' };
      return { ...base, symbol: byKey(now).get(req.key) ?? null };
    case 'symbol_at': {
      const inside = now.filter((x) => file(x.key) === req.path && x.start <= req.line && req.line <= x.end);
      inside.sort((a, b) => a.end - a.start - (b.end - b.start));
      return { ...base, symbol: inside[0] ?? null };
    }
    case 'changes': {
      const old = s.snapshots[req.since];
      if (old === undefined) return { ...base, since_found: false, files: [], added: [], removed: [], changed: [] };
      const [was, is] = [byKey(old.symbols), byKey(now)];
      const added = now.filter((x) => !was.has(x.key));
      const removed = old.symbols.filter((x) => !is.has(x.key));
      const changed = now.filter((x) => was.has(x.key) && (was.get(x.key).hash !== x.hash || was.get(x.key).signature !== x.signature || was.get(x.key).start !== x.start));
      const files = [...new Set([...added, ...removed, ...changed].map((x) => file(x.key)))].sort();
      return { ...base, since_found: true, files, added, removed, changed };
    }
    case 'symbol_impact':
      return { ...base, dependents: s.dependents ?? [] };
    case 'tests':
      if (s.testsMode === 'refuse') return { status: 'error', error: 'no tests here' };
      if (s.testsMode === 'no_snapshot') return { status: 'no_snapshot' };
      return { ...base, tests: s.tests?.[req.key] ?? [] };
    default:
      return { status: 'error', error: `unknown op ${req.op}` };
  }
})();
process.stdout.write(`${JSON.stringify(answer)}\n`);
}
