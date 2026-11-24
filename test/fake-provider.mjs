// A fake code anchor provider for tests (docs/provider.md): `node fake-provider.mjs <fixture.json> <log>`. It reads the one
// request line on stdin, appends it to <log> (so a test counts calls), and answers from the fixture, read on every call so a
// test can change it between runs. `crash` exits 1. The `impact` op (#16) answers the fixture as it stands:
//   { "status": "ok" | "no_snapshot", "dependents": [...] }
// The ops of #10 answer from snapshots:
//   { repository, current, snapshots: { <id>: { symbols: [{ key, kind, signature, start, end, hash }] } }, mode?, gate?,
//     answerRepository?, dependents?, tests? }
// mode: 'garbage' answers text that is not JSON, 'hang' never answers, 'gate' answers once the file named by `gate` exists.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [fixture, log] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
appendFileSync(log, `${input.trim()}\n`);
const s = JSON.parse(readFileSync(fixture, 'utf8'));
if (s.crash === true || s.mode === 'crash') process.exit(1);
const req = JSON.parse(input);
if (req.op === 'impact') {
  process.stdout.write(JSON.stringify(s));
  process.exit(0);
}
if (s.mode === 'garbage') {
  process.stdout.write('this is not json\n');
  process.exit(0);
}
if (s.mode === 'hang') setInterval(() => undefined, 1000);
else {
  const byKey = (symbols) => new Map(symbols.map((x) => [x.key, x]));
  const file = (key) => key.split('#')[0];
  const now = s.snapshots[s.current].symbols;
  const base = { status: 'ok', repository: s.answerRepository ?? s.repository, snapshot: s.current };
  const answer = (() => {
    switch (req.op) {
      case 'key':
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
        return { ...base, tests: s.tests?.[req.key] ?? [] };
      default:
        return { status: 'error', error: `unknown op ${req.op}` };
    }
  })();
  const reply = () => {
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    process.exit(0);
  };
  if (s.mode === 'gate') {
    const wait = setInterval(() => existsSync(s.gate) && (clearInterval(wait), reply()), 20);
  } else reply();
}
