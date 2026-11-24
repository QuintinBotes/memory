// A fake code anchor provider for tests: `node fake-provider.mjs <fixture.json> <log>`. It reads the request on stdin,
// appends it to <log> (so a test counts calls), and answers from the fixture:
// { "status": "ok" | "no_snapshot", "dependents": [...] }, or exits 1 when the fixture says "crash".
import { appendFileSync, readFileSync } from 'node:fs';

const [fixture, log] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
appendFileSync(log, `${input.trim()}\n`);
const answer = JSON.parse(readFileSync(fixture, 'utf8'));
if (answer.crash === true) process.exit(1);
process.stdout.write(JSON.stringify(answer));
