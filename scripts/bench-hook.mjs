/**
 * On-demand benchmark for the hook latency bar (#24): p95 at most 150 ms and p99 at most 300 ms per hook run, process
 * start included, at 10,000 items with eight writers. Not part of `npm run verify`: a wall-time bar flakes on a
 * loaded machine, so the tests assert the work done instead (test/scale.test.mjs). prompt-recall is timed on a prompt
 * that shares no item's words, whose bar (#136) is p95 under 100 ms.
 *
 *   node scripts/bench-hook.mjs [runs=200] [items=10000] [writers=8]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remember, run, runAsync, setup } from '../test/helpers.mjs';
import { fillStore } from '../test/big-store.mjs';

const runs = Number(process.argv[2] ?? 200);
const items = Number(process.argv[3] ?? 10_000);
const writerCount = Number(process.argv[4] ?? 8);
const s = setup();
if (remember(s.acmeApi, s.data, s.configA, 'Seed lesson one', '--scope', 'repository', '--type', 'hazard').status !== 0) throw new Error('seed failed');
fillStore(join(s.data, 'tenants/acme.sqlite'), 'acme', 'acme/api', 'acme', items);
const configFile = join(s.data, 'config.json');
writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), promptRecall: true }));

// The writers, each proposing and giving feedback until the measurement ends.
let stop = false;
const writer = async (w) => {
  for (let n = 0; !stop; n++) {
    const call = (id, name, args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const head = [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }].map((m) => JSON.stringify(m));
    const input = [...head, call(1, 'memory_propose', { statement: `Bench writer ${w} proposes mk${w}x${n}`, scope: 'repository', type: 'precedent', evidence: { source: `bench:${w}:${n}` } })].join('\n') + '\n';
    await runAsync(['mcp'], { cwd: s.acmeApi, data: s.data, config: s.configA, input });
  }
};
const writers = Array.from({ length: writerCount }, (_, w) => writer(w));

const hooks = {
  'session-start': JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: s.acmeApi }),
  'subagent-start': JSON.stringify({ session_id: 's1', hook_event_name: 'SubagentStart', agent_id: 'bench', agent_type: 'general-purpose', cwd: s.acmeApi }),
  'prompt-recall': JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'Please rename the logger module to log', cwd: s.acmeApi }),
};
for (const [name, input] of Object.entries(hooks)) {
  const times = [];
  let failures = 0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const r = run([name], { cwd: s.acmeApi, data: s.data, config: s.configA, input });
    times.push(performance.now() - t);
    if (r.status !== 0) failures++;
  }
  times.sort((a, b) => a - b);
  const at = (p) => times[Math.min(times.length - 1, Math.ceil(p * times.length) - 1)].toFixed(0);
  console.log(`${name}: ${runs} runs, ${items} items, ${writerCount} writers: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, p99 ${at(0.99)} ms, non-zero exits ${failures}`);
}
stop = true;
await Promise.all(writers);
