// A fake code anchor provider for tests: `node fake-provider.mjs <fixture.json> <log>`. It reads the request on stdin,
// appends it to <log> (so a test counts calls), and answers from the fixture:
// { "status": "ok" | "no_snapshot", "dependents": [...] }. A fixture "mode" makes it misbehave:
//   crash  exit 1
//   env    write the names of its environment variables to <log>.env, then answer normally
//   hang   ignore SIGTERM and sleep 30 s, writing <log>.survived if it is still alive then
//   flood  like hang, after writing 5 MB to stdout
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [fixture, log] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
appendFileSync(log, `${input.trim()}\n`);
const answer = JSON.parse(readFileSync(fixture, 'utf8'));
if (answer.mode === 'crash') process.exit(1);
if (answer.mode === 'hang' || answer.mode === 'flood') {
  process.on('SIGTERM', () => {});
  if (answer.mode === 'flood') process.stdout.write('x'.repeat(5 * 1024 * 1024));
  await new Promise((done) => setTimeout(done, 30_000));
  writeFileSync(`${log}.survived`, 'yes');
  process.exit(0);
}
if (answer.mode === 'env') writeFileSync(`${log}.env`, JSON.stringify(Object.keys(process.env)));
process.stdout.write(JSON.stringify(answer.body ?? answer));
