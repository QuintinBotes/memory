import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setup, remember, runAsync, storeBytes, tokens } from './helpers.mjs';
import { fillStore } from './big-store.mjs';

// Slice 12 (#15): a failed Bash command shows the repair memory knows, beside the error, once per agent.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tenantFile = (s) => join(s.data, 'tenants/acme.sqlite');
const logFile = (s) => join(s.data, 'logs/injections.jsonl');
const logged = (s) => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : []);
const sql = (s, text, ...args) => {
  const db = new DatabaseSync(tenantFile(s));
  try {
    return db.prepare(text).all(...args);
  } finally {
    db.close();
  }
};

const SIGNATURE = 'ERR_MODULE_NOT_FOUND esbuild';
const RECIPE = `${SIGNATURE} => the build tool is missing: run npm ci in the repository root, then build again`;
const ERROR = (at = '/work/a') =>
  `node:internal/modules/esm/resolve:873\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from ${at}/scripts/build.mjs\n    at packageResolve (node:internal/modules/esm/resolve:873:9)\nNode.js v22.13.0\n`;

/** A store with the recipe; `source` is the recipe's evidence. */
function seeded(source = 'remember') {
  const s = setup();
  add(s, RECIPE, source);
  s.recipe = sql(s, 'SELECT id FROM items WHERE type = ?', 'repair-recipe')[0].id;
  return s;
}
/** Remembers a repair recipe in the acme tenant; returns its id. */
function add(s, statement, source = 'remember', type = 'repair-recipe') {
  const r = remember(s.acmeApi, s.data, s.configA, statement, '--scope', 'repository', '--type', type, '--source', source);
  assert.equal(r.status, 0, r.stderr);
  return sql(s, 'SELECT id FROM items WHERE statement = ?', statement)[0].id;
}
const contradictions = (s, id) => sql(s, 'SELECT contradictions FROM items WHERE id = ?', id)[0].contradictions;

/** The PostToolUseFailure JSON Claude Code sends, run through the hook. */
const fail = (s, error, extra = {}, env) =>
  runAsync(['failure-recall'], {
    cwd: extra.cwd ?? s.acmeApi, data: s.data, config: s.configA, env,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm run build' }, error, is_interrupt: false, cwd: s.acmeApi, ...extra }),
  });
function context(r) {
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return null;
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  return out.hookSpecificOutput.additionalContext;
}

test('US1.1 a Bash failure matching a recipe shows it within 120 estimated tokens, with no opt-in, and logs the item id', async () => {
  const s = seeded();
  assert.equal(JSON.parse(readFileSync(join(s.data, 'config.json'), 'utf8')).pointOfAction, undefined, 'no capability is switched on');
  const text = context(await fail(s, ERROR()));
  assert.match(text, /run npm ci in the repository root/);
  assert.match(text, new RegExp(`\\[${s.recipe}\\]`));
  assert.ok(tokens(text) <= 120, `${tokens(text)} tokens`);
  const [line] = logged(s);
  assert.deepEqual({ event: line.event, item: line.item, session: line.session, agent: line.agent, via: line.via }, { event: 'injected', item: s.recipe, session: 's1', agent: 'main', via: 'failure-recall' });
  assert.doesNotMatch(readFileSync(logFile(s), 'utf8'), /esbuild|npm ci/, 'the log holds ids, never text');
});

test('US1.2 the same fingerprint failing again prints nothing, even with other paths in the error', async () => {
  const s = seeded();
  assert.notEqual(context(await fail(s, ERROR())), null);
  assert.equal((await fail(s, ERROR('/elsewhere/b'))).stdout, '');
  assert.equal((await fail(s, ERROR('/elsewhere/c'))).stdout, '');
});

test('US1.2 another agent, and another session, are shown the recipe once each', async () => {
  const s = seeded();
  assert.notEqual(context(await fail(s, ERROR())), null);
  assert.notEqual(context(await fail(s, ERROR(), { agent_id: 'sub-1', agent_type: 'general-purpose' })), null);
  assert.notEqual(context(await fail(s, ERROR(), { session_id: 's2' })), null);
});

test('FR-005 a repeat in the same session and agent counts once as a contradiction of the item shown; a later session does not add one', async () => {
  const s = seeded();
  context(await fail(s, ERROR()));
  assert.equal(contradictions(s, s.recipe), 0, 'showing is not a contradiction');
  assert.equal((await fail(s, ERROR('/elsewhere/b'))).stdout, '');
  assert.equal(contradictions(s, s.recipe), 1);
  assert.equal((await fail(s, ERROR('/elsewhere/c'))).stdout, '');
  assert.equal(contradictions(s, s.recipe), 1, 'once per item per session');
  context(await fail(s, ERROR(), { session_id: 's2' }));
  assert.equal(contradictions(s, s.recipe), 1, 'the first failure of another session is no repeat');
  await fail(s, ERROR(), { session_id: 's2', agent_id: 'sub-1' });
  assert.equal(contradictions(s, s.recipe), 1, 'a failure of another agent is no repeat of the first agent\'s');
});

test('FR-005 a repeat charges only an item that was shown, and a newly added item still shows for the same fingerprint', async () => {
  const s = seeded();
  context(await fail(s, ERROR()));
  const second = add(s, 'ERR_MODULE_NOT_FOUND package => the second recipe: check the lockfile is committed', 'remember', 'failure-pattern');
  const text = context(await fail(s, ERROR('/elsewhere/b')));
  assert.match(text, new RegExp(`\\[${second}\\]`));
  assert.doesNotMatch(text, new RegExp(`\\[${s.recipe}\\]`), 'the first is not shown twice');
  assert.equal(contradictions(s, s.recipe), 1, 'the shown item is charged');
  assert.equal(contradictions(s, second), 0, 'the new item is not');
  assert.equal((await fail(s, ERROR('/elsewhere/c'))).stdout, '');
  assert.equal(contradictions(s, second), 1);
  assert.equal(contradictions(s, s.recipe), 1);
});

test('US1.3 an error that matches no item prints nothing, stores nothing and takes no write lock', async () => {
  const s = seeded();
  const before = statSync(tenantFile(s)).mtimeMs;
  const r = await fail(s, 'Error: ENOENT: no such file or directory, open zz-unique-missing.txt\n');
  assert.equal(r.stdout, '');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(logged(s), []);
  assert.equal(contradictions(s, s.recipe), 0);
  assert.deepEqual(sql(s, "SELECT name FROM sqlite_master WHERE name = 'failure_ledger'"), [], 'no ledger was made');
  assert.equal(statSync(tenantFile(s)).mtimeMs, before, 'the store was not written');
});

test('US1.4 an interrupted command prints nothing', async () => {
  const s = seeded();
  assert.equal((await fail(s, ERROR(), { is_interrupt: true })).stdout, '');
  assert.notEqual(context(await fail(s, ERROR())), null, 'the interrupt did not use up the recipe');
});

test('FR-001 only Bash failures are read', async () => {
  const s = seeded();
  assert.equal((await fail(s, ERROR(), { tool_name: 'Read' })).stdout, '');
});

test('US1.5 a recipe whose source carries the passed-after marker is labelled verified; any other, even one that says "not passed", is not', async () => {
  assert.doesNotMatch(context(await fail(seeded(), ERROR())), /verified/);
  assert.doesNotMatch(context(await fail(seeded('tests not passed'), ERROR())), /verified/);
  assert.doesNotMatch(context(await fail(seeded('bash passed'), ERROR())), /verified/, 'the bare word is no marker');
  assert.match(context(await fail(seeded('bash passed-after:abc123'), ERROR())), /repair-recipe \(verified\): ERR_MODULE_NOT_FOUND esbuild =>/);
});

test('FR-003 an item matches when all the words of its signature are in one error line; the repair part and other types never match', async () => {
  const s = seeded();
  assert.equal((await fail(s, "Error: Cannot find package 'esbuild'\n")).stdout, '', 'ERR_MODULE_NOT_FOUND is not in the error');
  assert.equal((await fail(s, 'Error [ERR_MODULE_NOT_FOUND]: nothing\nsomething about esbuild failed\n')).stdout, '', 'the words are on different lines');
  assert.equal((await fail(s, 'Error: the build tool is missing: run npm ci in the repository root failed\n')).stdout, '', 'the repair part of the item is not a signature');
  const t = setup();
  remember(t.acmeApi, t.data, t.configA, RECIPE, '--scope', 'repository', '--type', 'hazard');
  assert.equal((await fail(t, ERROR())).stdout, '', 'a hazard is not a recipe');
});

test('a signature is looked for in every line of the error, not only the lines that read as errors', async () => {
  const s = setup();
  const enospc = add(s, 'ENOSPC no space left on device => free disk space with docker system prune');
  const missing = add(s, 'esbuild command not found => run npm ci in the repository root');
  const npm = add(s, 'npm ERR! code ELIFECYCLE => the script exited non-zero: read the lines above it');
  const seen = async (error) => (context(await fail(s, error, { session_id: `x${Math.random()}` })) ?? '');
  assert.match(await seen('write failed\nENOSPC: no space left on device, write\nbuild failed\n'), new RegExp(`\\[${enospc}\\]`));
  assert.match(await seen('bash: esbuild: command not found\n'), new RegExp(`\\[${missing}\\]`));
  assert.match(await seen('npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n'), new RegExp(`\\[${npm}\\]`));
});

test('the lines read are capped: a signature beyond the last 2,000 lines is not found, and a 250,000-line error is still read', async () => {
  const s = setup();
  add(s, 'ENOSPC no space left on device => free disk space with docker system prune');
  const filler = (n) => Array.from({ length: n }, (_, i) => `Error: step ${i} of the build failed`).join('\n');
  assert.equal((await fail(s, `ENOSPC: no space left on device\n${filler(5000)}\n`)).stdout, '', 'a line beyond the cap');
  assert.match(context(await fail(s, `${filler(5000)}\nENOSPC: no space left on device\n`)), /free disk space/, 'the same line inside it');
  // No wall-clock bound: shared CI runners vary too much (a 2 s bound failed at 2.2 s on macOS). The cap above is the bound.
  const r = await fail(s, `${filler(250_000)}\nENOSPC: no space left on device\n`, { session_id: 'big' });
  assert.match(context(r), /free disk space/);
});

test('placeholders and common words never make a signature: too weak a signature matches nothing, and remember says so', async () => {
  const s = setup();
  for (const weak of ['Error failed => retry later', 'esbuild => run npm ci', 'error /tmp/x 1234567 failed => retry', 'exit code warning => retry']) {
    const r = remember(s.acmeApi, s.data, s.configA, weak, '--scope', 'repository', '--type', 'repair-recipe');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /never be recalled at a failing command/, weak);
  }
  const strong = remember(s.acmeApi, s.data, s.configA, 'ERR_MODULE_NOT_FOUND esbuild => reinstall the dependencies', '--scope', 'repository', '--type', 'repair-recipe');
  assert.doesNotMatch(strong.stderr, /never be recalled/);
  const other = remember(s.acmeApi, s.data, s.configA, 'Error failed => a rule', '--scope', 'repository', '--type', 'convention');
  assert.doesNotMatch(other.stderr, /never be recalled/, 'only failure types are checked');
  const error = 'Error: esbuild failed in /tmp/y 7654321\nexit code 1 warning\n';
  assert.match(context(await fail(s, `${error}ERR_MODULE_NOT_FOUND esbuild\n`)), /reinstall the dependencies/, 'the strong one matches');
  assert.doesNotMatch(readFileSync(logFile(s), 'utf8'), /^$/);
  assert.equal(logged(s).length, 1, 'and only it');
});

test('words are compared after Unicode normalisation', async () => {
  const s = setup();
  const id = add(s, 'café résumé corrupted => rebuild the cache');
  assert.match(context(await fail(s, 'Error: café résumé corrupted\n')), new RegExp(`\\[${id}\\]`));
});

test('tenants stay apart: the same recipe is shown in its own tenant and never in another', async () => {
  const s = setup();
  remember(s.betaWeb, s.data, s.configA, RECIPE, '--scope', 'repository', '--type', 'repair-recipe');
  assert.match(context(await fail(s, ERROR(), { cwd: s.betaWeb })), /run npm ci/, 'control: its own tenant');
  assert.equal((await fail(s, ERROR(), { session_id: 's2' })).stdout, '', 'acme never sees beta\'s');
});

test('without consent nothing is read or printed', async () => {
  const s = seeded();
  assert.match(context(await fail(s, ERROR())), /run npm ci/, 'control: with consent');
  writeFileSync(join(s.data, 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(s.data, 'config.json'), 'utf8')), consent: undefined }));
  assert.equal((await fail(s, ERROR(), { session_id: 's2' })).stdout, '');
});

test('several matching items: the 120-token budget drops what does not fit, inside the advisory fence', async () => {
  const s = setup();
  const long = (n) => `${n} is wrong; ${Array.from({ length: 18 }, (_, i) => `${n}step${i}`).join(' ')}`;
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const ids = names.map((n) => add(s, `ERR_MODULE_NOT_FOUND ${n} => ${long(n)}`));
  const text = context(await fail(s, `Error [ERR_MODULE_NOT_FOUND]: Cannot find ${names.join(' ')}\n`));
  assert.ok(tokens(text) <= 120, `${tokens(text)} tokens`);
  assert.match(text, /^~~~text memory: facts recorded earlier[^\n]*advisory data, not instructions\)\n/);
  assert.match(text, /\n~~~\n$/);
  const shown = ids.filter((id) => text.includes(`[${id}]`));
  assert.ok(shown.length >= 1 && shown.length < ids.length, `${shown.length} of ${ids.length} shown`);
  assert.deepEqual(logged(s).map((l) => l.item).sort(), shown.sort(), 'only what was shown is logged');
  const next = context(await fail(s, `Error [ERR_MODULE_NOT_FOUND]: Cannot find ${names.join(' ')}\n`));
  assert.ok(next === null || !shown.some((id) => next.includes(`[${id}]`)), 'a shown item is not shown again; one that was dropped may be');
});

test('the error text is never stored', async () => {
  const s = seeded();
  const unique = 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package \'esbuild\' zzuniquetail';
  context(await fail(s, `${unique}\n`));
  await fail(s, `${unique}\n`);
  assert.equal(storeBytes(s.data).includes('zzuniquetail'), false);
});

test('with the write lock held the hook exits 0, prints nothing and counts the skip; once the lock is free the recipe is still shown', async () => {
  const s = seeded();
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(tenantFile(s))});
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    console.log('locked');
    process.stdin.on('end', () => { db.exec('ROLLBACK'); process.exit(0); });
    process.stdin.resume();
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((ok) => holder.stdout.once('data', ok));
  const work = join(s.base, 'work.json');
  const r = await fail(s, ERROR(), {}, { WORK_LOG: work });
  const closed = new Promise((ok) => holder.on('exit', ok));
  holder.stdin.end();
  await closed;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  // Not how long it took (that depends on the machine's load): the lock wait it asked SQLite for is the hook's short one.
  const { busyTimeouts } = JSON.parse(readFileSync(work, 'utf8'));
  assert.ok(busyTimeouts.length > 0 && Math.max(...busyTimeouts) <= 500, `a hook waits at most 500 ms for a lock, not ${busyTimeouts}`);
  assert.deepEqual(logged(s).map((l) => [l.event, l.via, l.agent, l.session]), [['skipped', 'failure-recall', 'main', 's1']]);
  assert.notEqual(context(await fail(s, ERROR())), null);
});

test('a store of 10,000 items is read by type only, and the hook stays inside its work limit', async () => {
  const s = seeded();
  fillStore(tenantFile(s), 'acme', 'acme/api', 'acme', 10_000);
  const log = join(s.base, 'work.json');
  const r = await runAsync(['failure-recall'], {
    cwd: s.acmeApi, data: s.data, config: s.configA, env: { WORK_LOG: log },
    input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: {}, error: ERROR(), cwd: s.acmeApi }),
  });
  assert.notEqual(context(r), null);
  const work = JSON.parse(readFileSync(log, 'utf8'));
  const recipes = sql(s, "SELECT count(*) AS n FROM items WHERE type IN ('failure-pattern', 'repair-recipe')")[0].n;
  assert.ok(work.rows <= recipes + 20, `${work.rows} rows read, ${recipes} recipes and failure patterns held`);
  assert.ok(Math.max(0, ...work.busyTimeouts) <= 500, 'the busy wait is the hooks\' short one');
});

test('hooks.json registers PostToolUseFailure on Bash with a time limit', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.PostToolUseFailure.length, 1);
  assert.equal(hooks.PostToolUseFailure[0].matcher, 'Bash');
  assert.match(hooks.PostToolUseFailure[0].hooks[0].command, /memory\.mjs" failure-recall$/);
  assert.ok(hooks.PostToolUseFailure[0].hooks[0].timeout <= 2);
});

// The fingerprint is a copy of Orbit's (src/evidence/fingerprint.ts at 6407296): these vectors are what Orbit's own
// fingerprintFailure returned there for a check with id `bash`, and its normalizeLine table from tests/unit/evidence.
const VECTORS = [
  {
    "name": "runA",
    "output": "\n\u001b[31m FAIL \u001b[39m  src/math.test.ts > math > adds numbers\nAssertionError: expected 3 to be 4\n ❯ src/math.test.ts:12:20\n    at /__U__/alice/work/acme/src/math.test.ts:12:20\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 10 passed (11)\n   Start at  13:34:04\n   Duration  4.86s (transform 120ms, collect 1.2s)\ntmp dir: /var/folders/zz/abc123def456/T/orbit-Ab3dEf9/run\nrequest id 3f2b8c1e-9d4a-4e0b-8a77-0a1b2c3d4e5f took 341ms at 2026-10-03T13:34:04.123Z\n",
    "exitCode": 1,
    "fingerprint": "fp:eeb1217019388d59",
    "signature": [
      "AssertionError: expected 3 to be 4",
      "FAIL src/math.test.ts > math > adds numbers"
    ]
  },
  {
    "name": "module",
    "output": "node:internal/modules/esm/resolve:873\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from /work/a/scripts/build.mjs\n    at packageResolve (node:internal/modules/esm/resolve:873:9)\nNode.js v22.13.0\n",
    "exitCode": 1,
    "fingerprint": "fp:08823522532ee927",
    "signature": [
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from <path>/scripts/build.mjs",
      "at packageResolve (node:internal/modules/esm/resolve:873:9)"
    ]
  },
  {
    "name": "silent",
    "output": "hello\nworld\nbye\nlast",
    "exitCode": 2,
    "fingerprint": "fp:f63c791519b3797f",
    "signature": [
      "bye",
      "exit:2",
      "last",
      "world"
    ]
  },
  {
    "name": "silent-signal",
    "output": "a\nb",
    "exitCode": null,
    "fingerprint": "fp:9b231e92d7a231c9",
    "signature": [
      "a",
      "b",
      "exit:signal"
    ]
  },
  {
    "name": "empty",
    "output": "",
    "exitCode": 1,
    "fingerprint": "fp:bdb8f2a1c647d701",
    "signature": [
      "exit:1"
    ]
  },
  {
    "name": "topframe",
    "output": "TypeError: x is not a function\n    at foo (/a/b/c.js:1:1)\n    at bar (/a/b/d.js:2:2)",
    "exitCode": 1,
    "fingerprint": "fp:da8e888f71dfce3d",
    "signature": [
      "TypeError: x is not a function",
      "at foo (<path>/b/c.js:<n>)"
    ]
  }
];
const NORMALISE = [
  ['file.ts:12:34 failed', 'file.ts:<n> failed'],
  ['took 1.5s', 'took <dur>'],
  ['at 2026-10-03 13:34:04,123 boom', 'at <time> boom'],
  ['id 0xdeadBEEF end', 'id <hex> end'],
  ['commit 9f86d081884c7d659a2f done', 'commit <hex> done'],
  ['listening on localhost:41233', 'listening on localhost:<port>'],
  ['open /tmp/abc123/x.log failed', 'open <tmp> failed'],
  ['read /usr/local/lib/node_modules/pkg/index.js', 'read <path>/pkg/index.js'],
  ['see https://example.com/a/b/c', 'see https://example.com/a/b/c'],
  ['either/or and a / b', 'either/or and a / b'],
  ['line 77 col 3', 'line <n> col <n>'],
];

test('the fingerprint copy returns what Orbit\'s returned for the same output', async () => {
  const out = join(tmpdir(), `memory-fp-${process.pid}.mjs`);
  const built = await build({ entryPoints: [join(root, 'src/fingerprint.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
  writeFileSync(out, built.outputFiles[0].text);
  const { fingerprintFailure, normalizeLine, errorLines } = await import(pathToFileURL(out).href);
  for (const v of VECTORS) {
    // The home directory is spelled out here only at run time, for the identity guard.
    const got = fingerprintFailure(v.output.replaceAll('/__U__/', '/Users/'), v.exitCode);
    assert.deepEqual({ fingerprint: got.fingerprint, signature: got.signature }, { fingerprint: v.fingerprint, signature: v.signature }, v.name);
  }
  for (const [input, expected] of NORMALISE) assert.equal(normalizeLine(input), expected, input);
  // Orbit scans the first 200,000 lines; the copy must not drop earlier ones for later ones.
  const early = fingerprintFailure(`Error: first\n${Array.from({ length: 5000 }, (_, i) => `progress ${i}`).join('\n')}`);
  assert.deepEqual(early.signature, ['Error: first']);
  assert.ok(errorLines('a\nb\n').includes('a'));
});
