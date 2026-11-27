import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { symlinkSync } from 'node:fs';
import { setup as sandboxed, remember, run, runAsync, commit, storeBytes, assemble, tools } from './helpers.mjs';

// Slice 13 (#18): a failure that was fixed becomes a repair proposal, and a revert weakens what informed the change.
/** The sandbox with acme's store already made, so a test can ask it questions before anything writes to it. */
function setup() {
  const s = sandboxed();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Builds run from the repository root', '--scope', 'repository', '--type', 'convention').status, 0);
  return s;
}
const tenantFile = (s) => join(s.data, 'tenants/acme.sqlite');
const sql = (s, text, ...args) => {
  const db = new DatabaseSync(tenantFile(s));
  try {
    return db.prepare(text).all(...args).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const exec = (s, text) => {
  const db = new DatabaseSync(tenantFile(s));
  try {
    db.exec(text);
  } finally {
    db.close();
  }
};
const git = (cwd, env, ...args) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env }, encoding: 'utf8', stdio: 'pipe' });
const head = (dir) => git(dir, {}, 'rev-parse', 'HEAD').trim();

const ERROR = (at = '/work/a') =>
  `node:internal/modules/esm/resolve:873\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from ${at}/scripts/build.mjs\n    at packageResolve (node:internal/modules/esm/resolve:873:9)\nNode.js v22.13.0\n`;
const RECIPE = 'ERR_MODULE_NOT_FOUND esbuild => the build tool is missing: run npm ci in the repository root, then build again';
const repairs = (s) => sql(s, "SELECT id, status, statement FROM items WHERE type = 'repair-recipe' ORDER BY statement");
const evidence = (s, id) => sql(s, 'SELECT source_ref FROM evidence WHERE item_id = ?', id).map((r) => r.source_ref);

const base = (s, session, command, extra = {}) => ({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: s.acmeApi, ...extra });
const failed = (s, command, error = ERROR(), session = 's1', cwd = s.acmeApi) =>
  runAsync(['failure-recall'], { cwd, data: s.data, config: s.configA, input: JSON.stringify({ ...base(s, session, command), cwd, hook_event_name: 'PostToolUseFailure', error, is_interrupt: false }) });
const passed = (s, command, session = 's1', env, cwd = s.acmeApi) =>
  runAsync(['command-passed'], { cwd, data: s.data, config: s.configA, env, input: JSON.stringify({ ...base(s, session, command), cwd, hook_event_name: 'PostToolUse', tool_response: { stdout: 'ok' } }) });
const enable = (s) => {
  const r = run(['init', '--failing-commands', 'on', '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
};

// The repository's own command passing after failing: one session, a change committed in between.
async function repairedInSession(s, error = ERROR()) {
  assert.equal((await failed(s, 'npm run build', error)).status, 0);
  commit(s.acmeApi, { 'fix.txt': 'fixed\n' }, 'the fix');
  const r = await passed(s, 'npm run build');
  assert.equal(r.status, 0, r.stderr);
}

/** A fake gh on PATH: `gh run list` prints runs.json and `gh run view <id> --log-failed` prints log-<id>. */
function fakeGh(s, runs, logs) {
  const dir = join(s.base, 'gh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\ncase "$2" in\n  list) cat "$GH_DIR/runs.json" ;;\n  view) cat "$GH_DIR/log-$3" ;;\n  *) exit 1 ;;\nesac\n');
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs));
  for (const [id, text] of Object.entries(logs)) writeFileSync(join(dir, `log-${id}`), text);
  return { path: `${dir}:${process.env.PATH}`, env: { GH_DIR: dir } };
}
const ci = (s, gh) => run(['ci'], { cwd: s.acmeApi, data: s.data, config: s.configA, path: gh.path, env: gh.env });
const LOG = (who = 'Cannot find package') => `unit\tRun tests\t2026-11-24T10:00:00.0000000Z Error [ERR_MODULE_NOT_FOUND]: ${who} 'esbuild' imported from /home/runner/work/api/api/scripts/build.mjs\nunit\tRun tests\t2026-11-24T10:00:01.0000000Z ##[error]Process completed with exit code 1.\n`;
const run1 = (id, conclusion, sha, at, extra = {}) => ({ databaseId: id, conclusion, headSha: sha, headBranch: 'main', workflowName: 'build', createdAt: at, ...extra });

test('US1.1 a failed CI run followed by a passing run on a fix commit gives one repair proposal with the fingerprint, the fix commit and both runs', () => {
  const s = setup();
  const fix = 'b'.repeat(40);
  const gh = fakeGh(s, [run1(10, 'failure', 'a'.repeat(40), '2026-11-24T10:00:00Z'), run1(11, 'success', fix, '2026-11-24T11:00:00Z')], { 10: LOG() });
  const r = ci(s, gh);
  assert.equal(r.status, 0, r.stderr);
  const [item, ...more] = repairs(s);
  assert.equal(more.length, 0, 'one proposal');
  assert.equal(item.status, 'proposed');
  assert.match(item.statement, / => the build run passed after the fix at bbbbbbb$/);
  const [source] = evidence(s, item.id);
  assert.match(source, /failed-run:10/);
  assert.match(source, /passed-run:11/);
  assert.match(source, /fingerprint:fp:[0-9a-f]{16}/);
  assert.match(source, /passed-after:bbbbbbb/);
  assert.equal(sql(s, "SELECT count(*) AS n FROM item_keys WHERE item_id = ? AND kind = 'fingerprint'", item.id)[0].n, 1);
  // Reading the same runs again adds nothing.
  assert.equal(ci(s, gh).status, 0);
  assert.equal(repairs(s).length, 1);
  assert.equal(evidence(s, item.id).length, 1);
});

test('US1.1 a failed run with no later pass, or a pass on the same commit, gives no proposal', () => {
  const s = setup();
  const sha = 'a'.repeat(40);
  const only = fakeGh(s, [run1(10, 'failure', sha, '2026-11-24T10:00:00Z')], { 10: LOG() });
  assert.equal(ci(s, only).status, 0);
  assert.equal(repairs(s).length, 0);
  const rerun = fakeGh(s, [run1(10, 'failure', sha, '2026-11-24T10:00:00Z'), run1(11, 'success', sha, '2026-11-24T11:00:00Z')], { 10: LOG() });
  assert.equal(ci(s, rerun).status, 0);
  assert.equal(repairs(s).length, 0, 'a re-run of the same commit is not a fix');
  const fixed = fakeGh(s, [run1(10, 'failure', sha, '2026-11-24T10:00:00Z'), run1(11, 'success', 'c'.repeat(40), '2026-11-24T11:00:00Z')], { 10: LOG() });
  assert.equal(ci(s, fixed).status, 0);
  assert.equal(repairs(s).length, 1, 'control: a pass on another commit is');
});

test('US1.1 the proposal can be recalled: once approved it shows at the same failure, labelled verified, and a weak log line makes no proposal', async () => {
  const s = setup();
  const gh = fakeGh(s, [run1(10, 'failure', 'a'.repeat(40), '2026-11-24T10:00:00Z'), run1(11, 'success', 'b'.repeat(40), '2026-11-24T11:00:00Z')], { 10: LOG() });
  assert.equal(ci(s, gh).status, 0);
  const [{ id }] = repairs(s);
  assert.equal((await failed(s, 'npm run build', ERROR('/elsewhere/z'), 'c1')).stdout, '', 'a proposal is not recalled');
  const ok = run(['approve', id], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(ok.status, 0, ok.stderr);
  const shown = JSON.parse((await failed(s, 'npm run build', ERROR('/elsewhere/z'), 'c2')).stdout).hookSpecificOutput.additionalContext;
  assert.match(shown, /verified/);
  assert.match(shown, new RegExp(id));

  const weak = setup();
  const weakGh = fakeGh(weak, [run1(10, 'failure', 'a'.repeat(40), '2026-11-24T10:00:00Z'), run1(11, 'success', 'b'.repeat(40), '2026-11-24T11:00:00Z')], { 10: 'unit\tRun\t2026-11-24T10:00:00Z Error: failed\n' });
  const r = ci(weak, weakGh);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no line of its log names the failure/);
  assert.equal(repairs(weak).length, 0);
});

test('edge: the committers\' names, emails and handles in a CI log are not stored', () => {
  const s = setup();
  commit(s.acmeApi, { 'x.txt': 'x\n' }, 'by ada');
  git(s.acmeApi, { GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_COMMITTER_NAME: 'Ada Lovelace' }, 'commit', '--allow-empty', '-q', '-m', 'ada');
  const mail = assemble('ada', '@analytical.example');
  const log = `unit\tRun\t2026-11-24T10:00:00Z Error: Ada Lovelace pushed ${mail} and @ada-l broke the generated client schema\n`;
  const gh = fakeGh(s, [run1(10, 'failure', 'a'.repeat(40), '2026-11-24T10:00:00Z'), run1(11, 'success', 'b'.repeat(40), '2026-11-24T11:00:00Z')], { 10: log });
  const r = ci(s, gh);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(repairs(s).length, 1, 'control: the failure still becomes a proposal');
  const bytes = storeBytes(s.data).toString('latin1');
  for (const secret of ['Ada Lovelace', mail, '@ada-l']) assert.equal(bytes.includes(secret), false, secret);
  assert.doesNotMatch(repairs(s)[0].statement, /REDACTED/, 'the words around a redaction stay, the token does not');
});

test('US1.2 with the failing-command opt-in off, a command that fails and then passes captures nothing', async () => {
  const off = setup();
  await repairedInSession(off);
  assert.equal(sql(off, 'SELECT count(*) AS n FROM episodes')[0].n, 0);
  assert.equal(repairs(off).length, 0);
  assert.equal(storeBytes(off.data).toString('latin1').includes('esbuild'), false, 'no byte of the error is stored');

  const on = setup();
  enable(on);
  await repairedInSession(on);
  assert.equal(repairs(on).length, 1, 'control: with the opt-in on the same flow is captured');
});

test('US1.3 with the opt-in on, a failed command is a redacted episode and the same command passing becomes a repair proposal', async () => {
  const s = setup();
  enable(s);
  const mail = assemble('dev', '@corp.example');
  const error = `${ERROR()}Error: could not notify ${mail} (@dev-handle) after the esbuild package failed\n`;
  const before = head(s.acmeApi);
  assert.equal((await failed(s, 'npm run build', error)).status, 0);
  const [episode] = sql(s, 'SELECT * FROM episodes');
  assert.equal(episode.session, 's1');
  assert.equal(episode.head, before);
  assert.equal(episode.repaired_at, null);
  assert.equal(repairs(s).length, 0, 'a failure with no later pass gives no proposal');
  commit(s.acmeApi, { 'fix.txt': 'fixed\n' }, 'the fix');
  assert.equal((await passed(s, 'npm run build')).status, 0);
  const [item, ...more] = repairs(s);
  assert.equal(more.length, 0);
  assert.equal(item.status, 'proposed');
  assert.match(item.statement, /^[^=]*esbuild[^=]* => `npm run build` passed after the fix at [0-9a-f]{7}$/);
  assert.match(evidence(s, item.id)[0], new RegExp(`^session:s1 fingerprint:fp:[0-9a-f]{16} passed-after:${head(s.acmeApi).slice(0, 7)}$`));
  assert.notEqual(sql(s, 'SELECT repaired_at FROM episodes')[0].repaired_at, null);
  const bytes = storeBytes(s.data).toString('latin1');
  assert.equal(bytes.includes(mail), false);
  assert.equal(bytes.includes('@dev-handle'), false);
  assert.equal(bytes.includes('/work/a'), false, 'a path is normalised');
  // The proposal is recalled by slice 12 once approved.
  assert.equal(run(['approve', item.id], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.match(JSON.parse((await failed(s, 'npm run build', error, 'again')).stdout).hookSpecificOutput.additionalContext, /passed after the fix/);
});

test('edge: another command passing, or the tools\' own commits and posts, are not captured', async () => {
  const s = setup();
  enable(s);
  assert.equal((await failed(s, 'npm run build')).status, 0);
  assert.equal((await passed(s, 'npm run lint')).status, 0);
  assert.equal(repairs(s).length, 0, 'a different command passing repairs nothing');
  for (const own of ['gh pr comment 5 --body hi', 'git commit -m work', 'git push origin work', 'node dist/memory.mjs import']) {
    assert.equal((await failed(s, own, ERROR(), 's2')).status, 0);
    assert.equal((await passed(s, own, 's2')).status, 0);
  }
  assert.equal(sql(s, "SELECT count(*) AS n FROM episodes WHERE session = 's2'")[0].n, 0, 'none recorded');
  assert.equal(repairs(s).length, 0);
  commit(s.acmeApi, { 'fix.txt': '1\n' }, 'the fix');
  assert.equal((await passed(s, 'npm run build')).status, 0);
  assert.equal(repairs(s).length, 1, 'control: the same command passing is');
});

test('edge: a failure whose lines are too weak to recall is an episode but never a proposal', async () => {
  const s = setup();
  enable(s);
  await repairedInSession(s, 'Error: failed\n');
  assert.equal(sql(s, 'SELECT signature FROM episodes')[0].signature, '');
  assert.equal(repairs(s).length, 0);
});

test('US1.4 a revert of a commit made while items were shown raises their contradictions once; an unlinked revert does nothing', async () => {
  const s = setup();
  remember(s.acmeApi, s.data, s.configA, RECIPE, '--scope', 'repository', '--type', 'repair-recipe');
  const [{ id }] = sql(s, "SELECT id FROM items WHERE type = 'repair-recipe'");
  assert.notEqual((await failed(s, 'npm run build')).stdout, '', 'the recipe is shown in session s1');
  commit(s.acmeApi, { 'linked.txt': '1\n' }, 'linked change');
  const linked = head(s.acmeApi);
  assert.equal((await passed(s, 'git commit -m "linked change"')).status, 0);
  assert.deepEqual(sql(s, 'SELECT commit_sha, item_id FROM commit_items'), [{ commit_sha: linked, item_id: id }]);
  commit(s.acmeApi, { 'other.txt': '1\n' }, 'unlinked change');
  const unlinked = head(s.acmeApi);
  assert.equal((await passed(s, 'git commit -m x', 's-none')).status, 0);

  git(s.acmeApi, {}, 'revert', '--no-edit', unlinked);
  assert.equal((await passed(s, 'git revert HEAD')).stdout, '');
  assert.equal(sql(s, 'SELECT contradictions FROM items WHERE id = ?', id)[0].contradictions, 0, 'a revert of an unlinked commit counts nothing');

  git(s.acmeApi, {}, 'revert', '--no-edit', linked);
  const said = await passed(s, 'git revert HEAD');
  assert.match(JSON.parse(said.stdout).systemMessage, /1 revert counted/);
  assert.equal(sql(s, 'SELECT contradictions FROM items WHERE id = ?', id)[0].contradictions, 1);
  assert.equal((await passed(s, 'git revert HEAD')).stdout, '', 'scanned again, nothing new');
  assert.equal(sql(s, 'SELECT contradictions FROM items WHERE id = ?', id)[0].contradictions, 1, 'counted once');
  const cli = run(['reverts'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.match(cli.stdout, /no new memory-linked reverts/);
});

/** Two commits made in two sessions with the recipe shown in each; returns their ids. */
async function twoLinked() {
  const s = setup();
  remember(s.acmeApi, s.data, s.configA, RECIPE, '--scope', 'repository', '--type', 'repair-recipe');
  const shas = [];
  for (const session of ['s1', 's2']) {
    assert.notEqual((await failed(s, 'npm run build', ERROR(), session)).stdout, '');
    commit(s.acmeApi, { [`${session}.txt`]: '1\n' }, `change ${session}`);
    shas.push(head(s.acmeApi));
    await passed(s, 'git commit', session);
  }
  s.shas = shas;
  return s;
}
const config = (s) => JSON.parse(readFileSync(join(s.data, 'config.json'), 'utf8'));
const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();

test('US1.5 two memory-linked reverts within seven days turn recall off and say why; init --recall on turns it back on', async () => {
  const s = await twoLinked();
  git(s.acmeApi, {}, 'revert', '--no-edit', s.shas[0]);
  assert.match(JSON.parse((await passed(s, 'git revert')).stdout).systemMessage, /1 revert counted/);
  exec(s, `UPDATE reverts SET seen_at = '${ago(3)}'`);
  assert.equal(config(s).recallOff, undefined, 'one revert does not');
  assert.notEqual((await failed(s, 'npm run build', ERROR(), 'before')).stdout, '', 'recall is on');
  git(s.acmeApi, {}, 'revert', '--no-edit', s.shas[1]);
  const said = JSON.parse((await passed(s, 'git revert')).stdout).systemMessage;
  assert.match(said, /turned recall off: two memory-linked reverts within seven days/);
  assert.match(said, /memory init --recall on/);
  assert.match(config(s).recallOff.reason, /two memory-linked reverts within seven days/);
  assert.equal((await failed(s, 'npm run build', ERROR(), 'after')).stdout, '', 'recall is off');
  const start = run(['session-start'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 'x', source: 'startup', cwd: s.acmeApi }) });
  assert.equal(start.stdout, '');
  const init = run(['init'], { cwd: s.base, data: s.data, config: s.configA });
  assert.match(init.stderr, /Recall is off: two memory-linked reverts within seven days/);
  const on = run(['init', '--recall', 'on', '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(on.status, 0, on.stderr);
  assert.equal(config(s).recallOff, undefined);
  assert.notEqual((await failed(s, 'npm run build', ERROR(), 'back')).stdout, '');
});

test('US1.5 two memory-linked reverts more than seven days apart leave recall on', async () => {
  const s = await twoLinked();
  git(s.acmeApi, {}, 'revert', '--no-edit', s.shas[0]);
  await passed(s, 'git revert');
  exec(s, `UPDATE reverts SET seen_at = '${ago(9)}'`);
  git(s.acmeApi, {}, 'revert', '--no-edit', s.shas[1]);
  const said = JSON.parse((await passed(s, 'git revert')).stdout).systemMessage;
  assert.match(said, /1 revert counted/);
  assert.equal(config(s).recallOff, undefined);
  assert.equal(sql(s, "SELECT contradictions FROM items WHERE type = 'repair-recipe'")[0].contradictions, 2, 'both still counted as contradictions');
});

test('FR-006 episodes older than 30 days are deleted: by the next failure and by the sweep', async () => {
  const s = setup();
  enable(s);
  await failed(s, 'npm run build');
  exec(s, `UPDATE episodes SET at = '${ago(31)}'`);
  await failed(s, 'npm run lint', ERROR('/x'), 's2');
  assert.deepEqual(sql(s, 'SELECT command FROM episodes').map((r) => r.command), ['npm run lint'], 'the old one went when a new one was written');
  exec(s, `UPDATE episodes SET at = '${ago(29)}'`);
  assert.equal(run(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.equal(sql(s, 'SELECT count(*) AS n FROM episodes')[0].n, 1, 'control: 29 days old stays');
  exec(s, `UPDATE episodes SET at = '${ago(31)}'`);
  assert.equal(run(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.equal(sql(s, 'SELECT count(*) AS n FROM episodes')[0].n, 0);
  // An episode past its 30 days does not become a proposal either.
  await failed(s, 'npm run build', ERROR(), 's3');
  exec(s, `UPDATE episodes SET at = '${ago(31)}'`);
  await passed(s, 'npm run build', 's3');
  assert.equal(repairs(s).length, 0);
});

test('purge removes episodes: --all and --older-than', async () => {
  const s = setup();
  enable(s);
  await failed(s, 'npm run build');
  const gone = () => sql(s, 'SELECT count(*) AS n FROM episodes')[0].n;
  assert.equal(gone(), 1);
  const keep = run(['purge', '--older-than', '5', '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(keep.status, 0, keep.stderr);
  assert.equal(gone(), 1, 'control: a young episode survives --older-than');
  exec(s, `UPDATE episodes SET at = '${ago(10)}'`);
  assert.equal(run(['purge', '--older-than', '5', '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.equal(gone(), 0);
  await failed(s, 'npm run build');
  assert.equal(run(['purge', '--all', '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.equal(gone(), 0);
});

test('the opt-in is its own consent category: under plan version 6 nothing is captured until the owner agrees again', async () => {
  const s = setup();
  enable(s);
  const plan = JSON.parse(run(['init'], { cwd: s.base, data: s.data, config: s.configA }).stdout);
  assert.equal(plan.version, 14);
  assert.equal(plan.optIns.failingCommands, true);
  assert.ok(plan.dataCategories.some((t) => /failing command/.test(t) && /30 days/.test(t)));
  const file = join(s.data, 'config.json');
  const c = config(s);
  c.consent.version = 6;
  writeFileSync(file, JSON.stringify(c));
  await failed(s, 'npm run build');
  assert.equal(sql(s, 'SELECT count(*) AS n FROM episodes')[0].n, 0, 'not covered');
  assert.equal(run(['init', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
  await failed(s, 'npm run build');
  assert.equal(sql(s, 'SELECT count(*) AS n FROM episodes')[0].n, 1, 'control: covered after agreeing');
});

test('the Bash hook on every command stays cheap: it opens no store for a command it ignores, and waits for no write lock to read', async () => {
  const s = setup();
  const log = join(s.base, 'work.json');
  const hook = (command, env) => runAsync(['command-passed'], { cwd: s.acmeApi, data: s.data, config: s.configA, env, input: JSON.stringify({ ...base(s, 's1', command), hook_event_name: 'PostToolUse' }) });
  assert.equal((await hook('ls -la', { WORK_LOG: log })).status, 0);
  assert.equal(JSON.parse(readFileSync(log, 'utf8')).statements, 0, 'opt-in off: no SQLite work at all');
  assert.equal((await hook('git commit -m x', { WORK_LOG: log })).status, 0);
  assert.ok(JSON.parse(readFileSync(log, 'utf8')).statements > 0, 'control: a commit is looked at');

  enable(s);
  await failed(s, 'npm run build');
  commit(s.acmeApi, { 'fix.txt': '1\n' }, 'the fix');
  const holder = new DatabaseSync(tenantFile(s));
  holder.exec('BEGIN IMMEDIATE');
  try {
    const r = await hook('ls -la', { WORK_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    // Not how long it took (that depends on the machine's load): the lock wait it asked SQLite for is the hook's short one.
    assert.ok(Math.max(0, ...JSON.parse(readFileSync(log, 'utf8')).busyTimeouts) <= 500, 'a read-only pass does not wait for the lock');
    const blocked = await passed(s, 'npm run build');
    assert.equal(blocked.status, 0, 'a hook that cannot write still exits 0');
    assert.equal(repairs(s).length, 0);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  assert.equal((await passed(s, 'npm run build')).status, 0);
  assert.equal(repairs(s).length, 1, 'once the lock is free the repair is proposed');
});

test('hooks.json registers PostToolUse on Bash with a time limit', () => {
  const hooks = JSON.parse(readFileSync(join(dirname(dirname(new URL(import.meta.url).pathname)), 'hooks', 'hooks.json'), 'utf8')).hooks;
  const [entry] = hooks.PostToolUse;
  assert.equal(entry.matcher, 'Bash');
  assert.match(entry.hooks[0].command, /memory\.mjs" command-passed$/);
  assert.ok(entry.hooks[0].timeout <= 2);
});

/** Orbit's store with run-end observations only. */
function orbitObservations(path, observations) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, norm_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, status TEXT NOT NULL, scope TEXT NOT NULL,
      confidence TEXT NOT NULL, code_free INTEGER NOT NULL, source TEXT NOT NULL, statement TEXT NOT NULL, lesson_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, verified_at INTEGER, stale_reason TEXT) STRICT;
    CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL, run_id TEXT,
      data_json TEXT, created_at INTEGER NOT NULL, UNIQUE (src, dst, type)) STRICT;
    CREATE TABLE observations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, failure_class TEXT, data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL) STRICT;
  `);
  observations.forEach(([run, state, checks], i) =>
    db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?)').run(`o${i}`, run, state, state === 'FAILED' ? 'check_failed' : null, JSON.stringify({ checks }), Date.now() - (10 - i) * 3_600_000));
  db.close();
}
function orbitFixture(observations) {
  const s = setup();
  orbitObservations(join(s.acmeApi, '.orbit', 'knowledge.sqlite'), observations);
  const file = join(s.data, 'config.json');
  const c = config(s);
  c.imports = { [s.acmeApi]: {} };
  writeFileSync(file, JSON.stringify(c, null, 2));
  const r = run(['import', '--orbit'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  return s;
}

test('FR-003 an Orbit run that failed a check and a later run that passed it give a repair proposal; with no later pass, none', () => {
  const FP = 'fp:tsc:TS2322';
  const s = orbitFixture([['run-3', 'FAILED', [{ check_id: 'unit', signature: FP }]], ['run-5', 'PASSED', [{ check_id: 'unit' }]]]);
  const [item, ...more] = repairs(s);
  assert.equal(more.length, 0);
  assert.equal(item.status, 'proposed');
  assert.match(item.statement, new RegExp(`^check unit failing with ${FP} => `));
  assert.match(evidence(s, item.id)[0], /failed-run:run-3 passed-run:run-5 passed-after:run-5/);
  assert.equal(sql(s, "SELECT key FROM item_keys WHERE item_id = ? AND kind = 'fingerprint'", item.id)[0].key, FP);
  assert.equal(sql(s, "SELECT count(*) AS n FROM items WHERE type = 'failure-pattern'")[0].n, 1, 'the failure itself is still a failure pattern');

  const none = orbitFixture([['run-3', 'FAILED', [{ check_id: 'unit', signature: FP }]]]);
  assert.equal(repairs(none).length, 0);
  assert.equal(sql(none, "SELECT count(*) AS n FROM items WHERE type = 'failure-pattern'")[0].n, 1);
  assert.ok(existsSync(tenantFile(none)));
});

test('migrating a store from schema 11 adds the failure tables', () => {
  const s = setup();
  remember(s.acmeApi, s.data, s.configA, 'A convention', '--scope', 'repository', '--type', 'convention');
  const before = sql(s, 'SELECT i.id, i.statement, e.source_ref, e.quote_hash FROM items i JOIN evidence e ON e.item_id = i.id');
  assert.equal(before.length, 2);
  exec(s, 'DROP TABLE revert_counts; DROP TABLE episodes; DROP TABLE commit_items; DROP TABLE reverts; PRAGMA user_version = 11;');
  assert.equal(run(['list'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.equal(sql(s, 'PRAGMA user_version')[0].user_version, 18);
  assert.deepEqual(sql(s, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('episodes', 'commit_items', 'reverts', 'revert_counts') ORDER BY name").map((r) => r.name), ['commit_items', 'episodes', 'revert_counts', 'reverts']);
  assert.deepEqual(sql(s, 'SELECT i.id, i.statement, e.source_ref, e.quote_hash FROM items i JOIN evidence e ON e.item_id = i.id'), before, 'the item and its evidence survive');
});

// ---- review of PR 67 ---------------------------------------------------------------------------------------------

const HOME_DIR = assemble('/Us', 'ers/jdoe');
const TOKEN = assemble('abcd', 'efgh1234ijkl5678');

test('a command with secrets, paths or user names is stored as its program and subcommand only', async () => {
  const s = setup();
  enable(s);
  const dirty = [
    ['DB_PASSWORD=hunter2 npm run build --token=' + TOKEN + ` ${HOME_DIR}/secret/file.txt`, 'npm run build'],
    [`cat ${HOME_DIR}/secret/file.txt`, 'cat'],
    [`npm publish --//registry.npmjs.org/:_authToken=${TOKEN}`, 'npm publish'],
    ['echo hunter2', 'echo'],
  ];
  for (const [i, [command, kept]] of dirty.entries()) {
    assert.equal((await failed(s, command, ERROR(`/w${i}`), `d${i}`)).status, 0);
    commit(s.acmeApi, { [`d${i}.txt`]: '1\n' }, 'fix');
    assert.equal((await passed(s, command, `d${i}`)).status, 0);
    assert.equal(sql(s, 'SELECT command FROM episodes WHERE session = ?', `d${i}`)[0].command, kept);
  }
  const bytes = storeBytes(s.data).toString('latin1');
  for (const secret of ['hunter2', TOKEN, 'jdoe', 'secret/file', 'DB_PASSWORD']) assert.equal(bytes.includes(secret), false, secret);
  assert.ok(repairs(s).some((r) => /`npm run build` passed/.test(r.statement)), 'control: the program and subcommand are kept and the feature works');
});

test('user names and home directories are normalised anywhere in a signature line', async () => {
  const me = userInfo().username;
  const s = setup();
  enable(s);
  const error = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from ${assemble('/ho', 'me/jdoe')}/app/scripts/build.mjs for user ${me} and C:\\Users\\jdoe\\app and ${HOME_DIR}/x\n`;
  await repairedInSession(s, error);
  const [item] = repairs(s);
  assert.ok(item, 'control: a proposal is made');
  const bytes = storeBytes(s.data).toString('latin1');
  assert.equal(bytes.includes('jdoe'), false);
  if (me.length >= 3) assert.equal(bytes.includes(me), false, 'the machine user name');
  assert.match(item.statement, /esbuild/);
});

test('an episode is for one command in one directory, and a pass at the failing commit is a retry, not a repair', async () => {
  const s = setup();
  enable(s);
  commit(s.acmeApi, { 'packages/a/x.txt': '1\n', 'packages/b/x.txt': '1\n' }, 'packages');
  const a = join(s.acmeApi, 'packages/a');
  const b = join(s.acmeApi, 'packages/b');
  await failed(s, 'npm test', ERROR(), 's1', a);
  commit(s.acmeApi, { 'fix.txt': '1\n' }, 'fix');
  await passed(s, 'npm test', 's1', undefined, b);
  assert.equal(repairs(s).length, 0, 'passing in packages/b does not repair packages/a');
  await passed(s, 'npm test', 's1', undefined, a);
  assert.equal(repairs(s).length, 1, 'control: passing in packages/a does');

  await failed(s, 'npm run lint', ERROR('/other'), 's2');
  await passed(s, 'npm run lint', 's2');
  assert.equal(repairs(s).length, 1, 'a pass with HEAD unchanged writes no proposal and no passed-after marker');
  assert.equal(sql(s, "SELECT repaired_at FROM episodes WHERE session = 's2'")[0].repaired_at, null, 'the episode stays open');
  commit(s.acmeApi, { 'fix2.txt': '1\n' }, 'fix 2');
  await passed(s, 'npm run lint', 's2');
  assert.equal(repairs(s).length, 2, 'control: a pass after a new commit is a repair');
});

/** A linked commit and a hook-seen revert fixture: items shown, commit made, returns the repository and the commit. */
async function linkedCommit(session = 's1', file = 'linked.txt') {
  const s = setup();
  remember(s.acmeApi, s.data, s.configA, RECIPE, '--scope', 'repository', '--type', 'repair-recipe');
  assert.notEqual((await failed(s, 'npm run build', ERROR(), session)).stdout, '');
  commit(s.acmeApi, { [file]: '1\n' }, 'linked change');
  await passed(s, 'git commit', session);
  s.linked = head(s.acmeApi);
  s.recipe = sql(s, "SELECT id FROM items WHERE type = 'repair-recipe'")[0].id;
  return s;
}
const contradictions = (s) => sql(s, 'SELECT contradictions FROM items WHERE id = ?', s.recipe)[0].contradictions;

test('a forged revert counts for nothing: another author, a quoting body, a command that only mentions git revert', async () => {
  const s = await linkedCommit();
  git(s.acmeApi, { GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_EMAIL: 'someone@example.com' }, 'commit', '--allow-empty', '-q', '-m', `Revert "linked change"`, '-m', `This reverts commit ${s.linked}.`);
  git(s.acmeApi, {}, 'commit', '--allow-empty', '-q', '-m', 'notes', '-m', `This reverts commit ${s.linked}.`);
  assert.equal((await passed(s, 'git revert HEAD')).stdout, '');
  assert.equal(contradictions(s), 0, 'neither forged commit counts');
  git(s.acmeApi, {}, 'revert', '--no-edit', s.linked);
  assert.equal((await passed(s, 'echo "git revert later" && true')).stdout, '', 'a command that mentions git revert is not one');
  assert.equal(contradictions(s), 0);
  assert.match(JSON.parse((await passed(s, 'git revert HEAD')).stdout).systemMessage, /1 revert counted/);
  assert.equal(contradictions(s), 1, 'control: the real revert by the local user counts');
});

test('a revert of a revert cancels it, and many reverts in one session add one contradiction per item', async () => {
  const s = await linkedCommit();
  git(s.acmeApi, {}, 'revert', '--no-edit', s.linked);
  await passed(s, 'git revert HEAD');
  assert.equal(contradictions(s), 1);
  const first = head(s.acmeApi);
  git(s.acmeApi, {}, 'revert', '--no-edit', first);
  await passed(s, 'git revert HEAD');
  assert.equal(contradictions(s), 0, 'reverting the revert takes the contradiction back');

  const m = await linkedCommit('s1', 'one.txt');
  commit(m.acmeApi, { 'two.txt': '1\n' }, 'second');
  const second = head(m.acmeApi);
  await passed(m, 'git commit', 's1');
  git(m.acmeApi, {}, 'revert', '--no-edit', second);
  git(m.acmeApi, {}, 'revert', '--no-edit', m.linked);
  await passed(m, 'git revert HEAD');
  assert.equal(contradictions(m), 1, 'two reverted commits of one session: one contradiction for the item');
});

test('recall off stops MCP search, get and related, memory recall and memory related, and not propose', async () => {
  const s = await twoLinked();
  const QUERY = 'ERR_MODULE_NOT_FOUND esbuild build tool';
  const id = sql(s, "SELECT id FROM items WHERE type = 'repair-recipe'")[0].id;
  const ask = () => tools(s.acmeApi, s.data, s.configA, [['memory_search', { query: QUERY }], ['memory_get', { id }], ['memory_related', { path: 'src/ledger.ts' }]]);
  assert.match(ask()[0].text, /esbuild/, 'control: search finds the item before');
  const orbitRecall = () => run(['recall', '--orbit', '--check', 'unit'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  for (const sha of s.shas) {
    git(s.acmeApi, {}, 'revert', '--no-edit', sha);
    await passed(s, 'git revert HEAD');
  }
  assert.notEqual(config(s).recallOff, undefined);
  for (const r of ask()) assert.match(r.text, /Recall is off: two memory-linked reverts/);
  assert.match(orbitRecall().stderr, /Recall is off/);
  assert.equal(orbitRecall().stdout, '');
  assert.match(run(['related', 'src/ledger.ts'], { cwd: s.acmeApi, data: s.data, config: s.configA }).stderr, /Recall is off/);
  assert.match(run(['recall', '--diff', 'HEAD~1..HEAD'], { cwd: s.acmeApi, data: s.data, config: s.configA }).stderr, /Recall is off/);
  const [p] = tools(s.acmeApi, s.data, s.configA, [['memory_propose', { statement: 'Builds use npm ci', scope: 'repository', type: 'convention', evidence: { source: 'https://github.com/acme/api/pull/7#issuecomment-1' } }]]);
  assert.equal(p.isError, false, 'proposing still works');
});

test('memory ci with no gh, gh not signed in, or a failing gh run view says so and stores nothing; it uses only run list and run view', () => {
  const s = setup();
  const empty = join(s.base, 'nogh');
  mkdirSync(empty);
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(empty, 'git'));
  const none = run(['ci'], { cwd: s.acmeApi, data: s.data, config: s.configA, path: empty });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /gh run list failed \(ENOENT\)/);

  const dir = join(s.base, 'gh2');
  mkdirSync(dir);
  const calls = join(dir, 'calls');
  const write = (body) => {
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$@" >> "${calls}"\n${body}\n`);
    chmodSync(join(dir, 'gh'), 0o755);
  };
  const ghRun = () => run(['ci'], { cwd: s.acmeApi, data: s.data, config: s.configA, path: `${dir}:${process.env.PATH}` });
  write('echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2; exit 4');
  const out = ghRun();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /gh run list failed/);

  const runs = JSON.stringify([run1(10, 'failure', 'a'.repeat(40), '2026-11-24T10:00:00Z'), run1(11, 'success', 'b'.repeat(40), '2026-11-24T11:00:00Z')]);
  write(`case "$2" in list) echo '${runs}' ;; *) exit 1 ;; esac`);
  const noLog = ghRun();
  assert.equal(noLog.status, 0, noLog.stderr);
  assert.match(noLog.stdout, /run 10: its log could not be read/);
  assert.equal(repairs(s).length, 0);

  const verbs = new Set(readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2).join(' ')));
  assert.deepEqual([...verbs].sort(), ['run list', 'run view']);
});

test('a workflow name is scrubbed, and dropped when scrubbing changes it', () => {
  const s = setup();
  const mail = assemble('ops', '@corp.example');
  const gh = fakeGh(s, [run1(10, 'failure', 'a'.repeat(40), '2026-11-24T10:00:00Z', { workflowName: `build ${mail}` }), run1(11, 'success', 'b'.repeat(40), '2026-11-24T11:00:00Z', { workflowName: `build ${mail}` })], { 10: LOG() });
  assert.equal(ci(s, gh).status, 0);
  const [item] = repairs(s);
  assert.match(item.statement, / => a CI run passed after the fix at bbbbbbb$/);
  assert.equal(storeBytes(s.data).toString('latin1').includes(mail), false);
});

test('an Orbit repair is recalled by recall --orbit once approved, by fingerprint or check, not by a Bash error', async () => {
  const FP = 'fp:tsc:TS2322';
  const s = orbitFixture([['run-3', 'FAILED', [{ check_id: 'unit', signature: FP }]], ['run-5', 'PASSED', [{ check_id: 'unit' }]]]);
  writeFileSync(join(s.acmeApi, '.orbit', 'config.yaml'), 'version: 1\nknowledge:\n  enabled: true\n  max_advisory_tokens: 800\n  lessons_in_prompts: true\n  max_prompt_lessons: 3\n');
  const [{ id }] = repairs(s);
  const recall = () => run(['recall', '--orbit', '--fingerprint', FP], { cwd: s.acmeApi, data: s.data, config: s.configA }).stdout;
  assert.equal(recall(), '', 'a proposal is not recalled');
  assert.equal(run(['approve', id], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.match(recall(), /a later Orbit run passed the check/);
  assert.equal((await failed(s, 'npm test', `Error: TS2322 type mismatch in tsc\n`, 'o1')).stdout, '', 'a Bash error does not match its hash signature');
});
