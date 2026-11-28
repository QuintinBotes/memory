import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, run, runAsync, sessionStart, assemble } from './helpers.mjs';

// #145: proposals from a repository's commit history.
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-provider.mjs');
const CENTS = 'fix: store amounts as integer cents because floats lost a cent';

/** Commits `files` in `dir` as `author`, at `date` (a day count from 2026-01-01), and returns the hash. */
let day = 0;
function commitAs(dir, files, message, { author = 'Robin Vale', date = ++day } = {}) {
  const when = new Date(Date.UTC(2026, 0, 1) + date * 864e5).toISOString();
  const email = assemble(author.toLowerCase().replace(/\W/g, '.'), '@', 'example.com');
  const env = { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe', encoding: 'utf8' });
  for (const [path, text] of Object.entries(files)) {
    if (text === null) git('rm', '-q', path);
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      git('add', path);
    }
  }
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

const query = (s, text, ...args) => {
  const file = join(s.data, 'tenants/acme.sqlite');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(text).all(...args).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const items = (s) => query(s, "SELECT id, statement, status, status_reason, origin_trust, quarantine, anchors_json FROM items WHERE type = 'decision' ORDER BY created_at, id");
const seed = (s, ...flags) => run(['seed', '--git', '--since', '2025-06-01', ...flags], { cwd: s.acmeApi, data: s.data, config: s.configA });

/** The SC1 fixture: a revert whose body gives a reason, and the cents fix. */
function fixture() {
  const s = setup();
  const original = commitAs(s.acmeApi, { 'src/ledger.ts': 'export function consume() {\n  return cache();\n}\n' }, 'feat: cache ledger reads');
  const revert = commitAs(s.acmeApi, { 'src/ledger.ts': 'export function consume() {\n  return 1;\n}\n' }, `Revert "feat: cache ledger reads"\n\nThis reverts commit ${original}.\n\nThe cache served stale balances after a transfer.`);
  const cents = commitAs(s.acmeApi, { 'src/money.ts': 'export const cents = 1;\n' }, CENTS);
  return { s, revert, cents };
}

test('SC1 --dry-run lists the revert and the cents fix with their hashes and writes nothing', () => {
  const { s, revert, cents } = fixture();
  const r = seed(s, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => /^[0-9a-f]{7} /.test(l));
  assert.equal(lines.length, 2, r.stdout);
  assert.match(lines[0], new RegExp(`^${cents.slice(0, 7)} .*"Store amounts as integer cents because floats lost a cent\\."`));
  assert.match(lines[1], new RegExp(`^${revert.slice(0, 7)} .*"Reverted \\\\"cache ledger reads\\\\": The cache served stale balances after a transfer\\."`));
  assert.match(r.stdout, /nothing was written/);
  assert.deepEqual(items(s), []);
});

test('SC2 seed stores two agent-trusted proposals with the commit as source and its files as anchors; review shows them and recall does not', () => {
  const { s, revert, cents } = fixture();
  const r = seed(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stored 2 proposals; 0 candidates left/);
  const all = items(s);
  assert.deepEqual(all.map((i) => [i.status, i.origin_trust]), [['proposed', 'agent'], ['proposed', 'agent']]);
  const bySource = (sha) => query(s, 'SELECT i.anchors_json, e.captured_at FROM evidence e JOIN items i ON i.id = e.item_id WHERE e.source_ref = ?', `commit:${sha}`);
  assert.deepEqual(JSON.parse(bySource(cents)[0].anchors_json), [{ path: 'src/money.ts' }]);
  assert.deepEqual(JSON.parse(bySource(revert)[0].anchors_json), [{ path: 'src/ledger.ts' }]);
  assert.match(bySource(cents)[0].captured_at, /^2026-01-/, 'the evidence time is the commit date');
  const review = run(['review'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.match(review.stdout, /integer cents/);
  assert.match(review.stdout, /stale balances/);
  const start = sessionStart(s.acmeApi, s.data, s.configA);
  assert.doesNotMatch(start.stdout, /integer cents|stale balances/, 'not recalled before approval');
});

test('SC3 a commit whose files are gone at HEAD yields no proposal', () => {
  const s = setup();
  commitAs(s.acmeApi, { 'src/old.ts': 'x\n' }, 'fix: parse dates in UTC because local time shifted the reports');
  commitAs(s.acmeApi, { 'src/old.ts': null }, 'chore: drop the old parser');
  const r = seed(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stored 0 proposals/);
  assert.deepEqual(items(s), []);
});

test('SC4 a second run stores nothing new, and a rejected candidate is not proposed again', () => {
  const { s } = fixture();
  assert.equal(seed(s).status, 0);
  const again = seed(s);
  assert.match(again.stdout, /stored 0 proposals/);
  assert.equal(items(s).length, 2);
  const cents = items(s).find((i) => /cents/.test(i.statement));
  assert.equal(run(['reject', cents.id], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  // Even with its commit evidence gone, the statement's tombstone holds.
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare('DELETE FROM evidence WHERE item_id = ?').run(cents.id);
  db.close();
  const third = seed(s);
  assert.match(third.stdout, /stored 0 proposals/);
  assert.match(third.stdout, /rejected before/);
  assert.deepEqual(items(s).filter((i) => /cents/.test(i.statement)).map((i) => i.status), ['rejected']);
});

test('SC5 two commits deciding one subject differently: the older arrives superseded by the newer', () => {
  const s = setup();
  commitAs(s.acmeApi, { 'src/pay.ts': 'a\n' }, 'fix: retry payments 3 times because the gateway drops requests', { date: 10 });
  commitAs(s.acmeApi, { 'src/pay.ts': 'b\n' }, 'fix: retry payments 5 times because the gateway drops requests', { date: 40 });
  const r = seed(s);
  assert.equal(r.status, 0, r.stderr);
  const [newer, older] = [items(s).find((i) => /5 times/.test(i.statement)), items(s).find((i) => /3 times/.test(i.statement))];
  assert.equal(newer.status, 'proposed');
  assert.equal(older.status, 'superseded');
  assert.equal(older.status_reason, `superseded by ${newer.id}`);
});

test('SC6 a message naming a committer, an email or a handle gives no proposal; an instruction arrives quarantined', () => {
  const s = setup();
  commitAs(s.acmeApi, { 'src/a.ts': 'a\n' }, 'fix: keep the queue small because Dana Whitfield saw it overflow', { author: 'Dana Whitfield' });
  commitAs(s.acmeApi, { 'src/b.ts': 'b\n' }, `fix: rotate keys monthly because ${assemble('ops', '@', 'acme-corp.io')} asked`);
  commitAs(s.acmeApi, { 'src/c.ts': 'c\n' }, 'fix: pin the node version because @dana found drift');
  commitAs(s.acmeApi, { 'src/d.ts': 'd\n' }, 'chore: skip the flaky tests before a release because they block the deploy');
  const r = seed(s);
  assert.equal(r.status, 0, r.stderr);
  const all = items(s);
  assert.equal(all.length, 1, JSON.stringify(all));
  assert.match(all[0].statement, /flaky tests/);
  assert.notEqual(all[0].quarantine, null);
  const raw = readFileSync(join(s.data, 'tenants/acme.sqlite')).toString('latin1');
  for (const gone of ['Dana', 'acme-corp.io', '@dana']) assert.equal(raw.includes(gone), false, gone);
});

test('SC7 with 50 qualifying commits one run stores 20 and reports 30 left; the next run takes the next 20', () => {
  const s = setup();
  const word = (i, k) => `w${(i * 7 + k * 13).toString(36)}x${k}`;
  for (let i = 0; i < 50; i++) commitAs(s.acmeApi, { [`src/f${i}.ts`]: `${i}\n` }, `fix: ${word(i, 1)} ${word(i, 2)} ${word(i, 3)} must ${word(i, 4)} ${word(i, 5)}`);
  const r = seed(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stored 20 proposals; 30 candidates left for the next run/);
  assert.equal(items(s).filter((i) => i.status === 'proposed').length, 20);
  // Newest first: the last commit's file is anchored, the first one's is not yet.
  assert.ok(items(s).some((i) => i.anchors_json.includes('src/f49.ts')));
  assert.ok(!items(s).some((i) => i.anchors_json.includes('"src/f0.ts"')));
  assert.match(seed(s).stdout, /stored 20 proposals; 10 candidates left/);
});

/** A stand-in for a local Ollama: answers /api/generate with `reply`, and keeps each request body. */
async function ollama(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: JSON.stringify(reply(seen.length)) }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}
const configure = (s, model) => {
  const file = join(s.data, 'config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), transcriptModel: model }));
};

test('SC8 a transcriptModel at a non-loopback address is skipped for the tenant, and the run says so', () => {
  const { s } = fixture();
  const fixtureFile = join(s.base, 'fake.json');
  writeFileSync(fixtureFile, JSON.stringify({ mode: 'crash' }));
  const log = join(s.base, 'calls.log');
  configure(s, { url: 'https://models.example.com', command: [process.execPath, FAKE, fixtureFile, log] });
  const r = seed(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /did not run for tenant acme/);
  assert.equal(existsSync(log), false, 'the model was never called');
  assert.equal(items(s).length, 2, 'the rule pass still proposes');
});

test('SC8 a local model rewrites a candidate with the message\'s own words; a rewrite with other words is dropped', async () => {
  const { s } = fixture();
  const server = await ollama((n) => ({ statement: n === 1 ? 'Store amounts as integer cents.' : 'Caching was bad for users.' }));
  try {
    configure(s, { url: server.url });
    const r = await runAsync(['seed', '--git', '--since', '2025-06-01'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(server.seen.length, 2);
    assert.match(server.seen[0].prompt, /integer cents/);
    const statements = items(s).map((i) => i.statement).sort();
    assert.deepEqual(statements, ['Reverted "cache ledger reads": The cache served stale balances after a transfer.', 'Store amounts as integer cents.']);
  } finally {
    server.close();
  }
});

test('SC9 without the seed consent no git log is run, and the command says why', () => {
  const { s } = fixture();
  const path = join(s.data, 'config.json');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  c.consent.version = 15;
  writeFileSync(path, JSON.stringify(c));
  const bin = join(s.base, 'bin');
  mkdirSync(bin);
  const log = join(s.base, 'git.log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const r = run(['seed', '--git'], { cwd: s.acmeApi, data: s.data, config: s.configA, path: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /consent does not cover reading commit history/);
  assert.equal(existsSync(log) && /\blog\b/.test(readFileSync(log, 'utf8')), false, 'no git log ran');
  assert.deepEqual(items(s), []);
  // Control: the same wrapper does see git log once the plan is agreed.
  assert.equal(run(['init', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
  assert.equal(run(['seed', '--git', '--dry-run'], { cwd: s.acmeApi, data: s.data, config: s.configA, path: `${bin}:${process.env.PATH}` }).status, 0);
  assert.match(readFileSync(log, 'utf8'), /^log /m);
});

test('#158 instead of is no cue, and must or never counts only in a rule, not a bug story', () => {
  const s = setup();
  const msgs = [
    'feat: the lexer uses typed arrays instead of strings',
    'fix: the cache could never expire after a restart',
    'Fixed the doctor so it must print the proposal',
    'chore: the report was empty and the counter never reset',
    'fix: doctor printed nothing and never mentioned the proposal',
    'feat: tokens are never written to the log file',
    'fix: never retry a payment that the gateway declined',
  ];
  msgs.forEach((m, i) => commitAs(s.acmeApi, { [`src/c${i}.ts`]: `${i}\n` }, m));
  const r = seed(s, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const kept = [...r.stdout.matchAll(/^[0-9a-f]{7} \S+ "(.+?)" \(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(kept, ['Never retry a payment that the gateway declined.', 'Tokens are never written to the log file.']);
});

test('#158 docs, READMEs and changelogs are not anchored when the commit also changed source files', () => {
  const s = setup();
  const files = { 'CHANGELOG.md': 'c\n', 'README.md': 'r\n', 'docs/guide.md': 'g\n', 'notes.md': 'n\n', 'src/pay.ts': 'p\n' };
  commitAs(s.acmeApi, files, 'fix: round fees down because the bank rounds them down');
  commitAs(s.acmeApi, { 'docs/limits.md': 'l\n' }, 'docs: uploads must stay under ten megabytes');
  assert.equal(seed(s).status, 0);
  const anchors = items(s).map((i) => JSON.parse(i.anchors_json).map((a) => a.path)).sort();
  assert.deepEqual(anchors, [['docs/limits.md'], ['src/pay.ts']]);
});
