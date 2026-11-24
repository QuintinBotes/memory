import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, remember, sessionStart, run, tools } from './helpers.mjs';

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const REPEATED = 'Always use the shared logger for diagnostics';
const KEPT = 'Releases are cut from the main branch only';
const CONFLICTING = 'Tests are optional before a commit';
// Assembled, so the identity guard does not read an import line as an email address.
const IMPORT = ['@', 'AGENTS.md'].join('');
const LINE = 'Run the test suite before every commit';

/** A repository whose CLAUDE.md imports AGENTS.md, as Claude Code loads it, with the items of every scenario remembered. */
function fixture() {
  const s = setup();
  const repo = s.acmeApi;
  writeFileSync(join(repo, 'CLAUDE.md'), `# Claude\n\n${IMPORT}\n`);
  writeFileSync(join(repo, 'AGENTS.md'), `# Agents\n\n- ${LINE}.\n- ${REPEATED}.\n`);
  for (const text of [REPEATED, KEPT, CONFLICTING]) {
    const r = remember(repo, s.data, s.configA, text, '--type', 'convention');
    assert.equal(r.status, 0, r.stderr);
  }
  return { ...s, repo, agents: join(repo, 'AGENTS.md'), claude: join(repo, 'CLAUDE.md') };
}

const slice = (s) => sessionStart(s.repo, s.data, s.configA).stdout;
const logLines = (s) => {
  const file = join(s.data, 'logs', 'injections.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const review = (s) => run(['review'], { cwd: s.repo, data: s.data, config: s.configA });
const conflicts = (s, ...args) => run(['conflicts', ...args], { cwd: s.repo, data: s.data, config: s.configA });
const idIn = (text, kind) => new RegExp(`\\[(c-[0-9a-f]+)\\] ${kind}`).exec(text)?.[1];

test('26.1 an item that repeats an instruction line is not in the slice, and an item with no match is', () => {
  const s = fixture();
  const out = slice(s);
  assert.doesNotMatch(out, /shared logger/);
  assert.match(out, /Releases are cut from the main branch only/);
});

test('26.2 a repeated item is not in a search either, and each drop is counted in the injection log', () => {
  const s = fixture();
  const [found] = tools(s.repo, s.data, s.configA, [['memory_search', { query: 'shared logger diagnostics' }]]);
  assert.doesNotMatch(found.text, /shared logger/);
  slice(s);
  const dropped = logLines(s).filter((l) => l.event === 'withheld' && l.reason === 'repeats');
  assert.ok(dropped.length >= 1, JSON.stringify(logLines(s)));
  assert.ok(dropped.every((l) => typeof l.item === 'string' && l.tokens > 0 && l.text === undefined));
});

test('26.3 a proposal that repeats an instruction line is closed as a duplicate naming the file and line, and never queues', () => {
  const s = fixture();
  const [res] = tools(s.repo, s.data, s.configA, [
    ['memory_propose', { statement: 'Run the test suite before every commit', scope: 'repository', type: 'convention', evidence: { source: 'https://example.com/pr/1' } }],
  ]);
  assert.match(res.text, /not proposed: .*AGENTS\.md:3/);
  assert.doesNotMatch(review(s).stdout, /test suite before every commit/);
});

test('26.4 an item whose matching line was deleted is recalled again', () => {
  const s = fixture();
  assert.doesNotMatch(slice(s), /shared logger/);
  writeFileSync(s.agents, `# Agents\n\n- ${LINE}.\n`);
  assert.match(slice(s), /shared logger/);
});

test('26.5 a partial overlap does not drop an item', () => {
  const s = fixture();
  remember(s.repo, s.data, s.configA, 'Always use the shared logger for diagnostics in the billing worker when retrying jobs', '--type', 'convention');
  assert.match(slice(s), /billing worker/);
});

test('26.6 a symbolic link out of the repository, and an import out of it, are not read', () => {
  const s = fixture();
  const outside = join(s.base, 'outside.md');
  writeFileSync(outside, `- ${KEPT}.\n`);
  writeFileSync(s.claude, '@AGENTS.md\n@../../outside.md\n');
  symlinkSync(outside, join(s.repo, 'GEMINI.md'));
  assert.match(slice(s), /Releases are cut from the main branch only/);
});

test('40.1 a contradicting item is withheld, and memory review lists the conflict with a proposed edit as a diff', () => {
  const s = fixture();
  assert.doesNotMatch(slice(s), /Tests are optional/);
  const out = review(s).stdout;
  assert.match(out, /\[c-[0-9a-f]+\] conflict/);
  assert.match(out, /AGENTS\.md:3/);
  assert.match(out, new RegExp(`^-- ${LINE}\\.$`, 'm'));
  assert.match(out, new RegExp(`^\\+- ${CONFLICTING}\\.$`, 'm'));
});

test('40.2 the instruction file is byte-identical until the owner approves, whatever runs', () => {
  const s = fixture();
  const before = [sha(s.agents), sha(s.claude)];
  slice(s);
  review(s);
  conflicts(s);
  conflicts(s, 'apply', idIn(review(s).stdout, 'conflict'));
  tools(s.repo, s.data, s.configA, [['memory_search', { query: 'tests optional commit' }]]);
  assert.deepEqual([sha(s.agents), sha(s.claude)], before);
});

test('40.3 approve with --confirm writes the exact proposed edit and the item is superseded by the file', () => {
  const s = fixture();
  slice(s);
  const id = idIn(review(s).stdout, 'conflict');
  const r = conflicts(s, 'apply', id, '--confirm');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.agents, 'utf8'), `# Agents\n\n- ${CONFLICTING}.\n- ${REPEATED}.\n`);
  const listed = conflicts(s).stdout;
  assert.match(listed, new RegExp(`${id}.*applied`));
  const all = run(['list'], { cwd: s.repo, data: s.data, config: s.configA }).stdout;
  assert.doesNotMatch(all, /Tests are optional/);
});

test('40.4 reject resolves the conflict, leaves the file alone and keeps the item withheld', () => {
  const s = fixture();
  slice(s);
  const before = sha(s.agents);
  const id = idIn(review(s).stdout, 'conflict');
  const r = conflicts(s, 'reject', id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sha(s.agents), before);
  assert.match(conflicts(s).stdout, new RegExp(`${id}.*resolved`));
  assert.doesNotMatch(review(s).stdout, /conflict/);
  assert.doesNotMatch(slice(s), /Tests are optional/);
});

test('40.5 an edit is refused when the line changed since it was proposed', () => {
  const s = fixture();
  slice(s);
  const id = idIn(review(s).stdout, 'conflict');
  writeFileSync(s.agents, `# Agents\n\n- ${LINE} and lint.\n- ${REPEATED}.\n`);
  const r = conflicts(s, 'apply', id, '--confirm');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /changed/);
});

test('40.6 an item on a subject no instruction line shares raises no conflict', () => {
  const s = fixture();
  slice(s);
  const out = review(s).stdout;
  assert.doesNotMatch(out, /Releases are cut/);
  assert.equal((out.match(/\] conflict/g) ?? []).length, 1);
});

test('26.7 an approved item with enough owner support is proposed for promotion; the file waits for the owner', () => {
  const s = fixture();
  const text = 'Database migrations ship in their own pull request';
  for (const source of ['review-1', 'review-2', 'review-3']) remember(s.repo, s.data, s.configA, text, '--type', 'convention', '--source', source);
  const before = sha(s.claude);
  slice(s);
  const out = review(s).stdout;
  const id = idIn(out, 'promotion');
  assert.ok(id, out);
  assert.match(out, /CLAUDE\.md/);
  assert.match(out, new RegExp(`^\\+- ${text}$`, 'm'));
  assert.equal(sha(s.claude), before);
});

test('26.8 applying a promotion appends the exact line, and the item is promoted and leaves recall', () => {
  const s = fixture();
  const text = 'Database migrations ship in their own pull request';
  for (const source of ['review-1', 'review-2', 'review-3']) remember(s.repo, s.data, s.configA, text, '--type', 'convention', '--source', source);
  slice(s);
  const id = idIn(review(s).stdout, 'promotion');
  const r = conflicts(s, 'apply', id, '--confirm');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.claude, 'utf8'), `# Claude\n\n${IMPORT}\n- ${text}\n`);
  assert.doesNotMatch(slice(s), /Database migrations/);
  assert.doesNotMatch(run(['list'], { cwd: s.repo, data: s.data, config: s.configA }).stdout, /Database migrations/);
});

test('26.9 rejecting a promotion writes nothing and is not proposed again', () => {
  const s = fixture();
  const text = 'Database migrations ship in their own pull request';
  for (const source of ['review-1', 'review-2', 'review-3']) remember(s.repo, s.data, s.configA, text, '--type', 'convention', '--source', source);
  slice(s);
  const before = sha(s.claude);
  const id = idIn(review(s).stdout, 'promotion');
  assert.equal(conflicts(s, 'reject', id).status, 0);
  slice(s);
  assert.equal(sha(s.claude), before);
  assert.doesNotMatch(review(s).stdout, /promotion/);
  assert.match(slice(s), /Database migrations/);
});

test('26.10 conflicts apply is a terminal command: it needs a conflict id, and --confirm to write', () => {
  const s = fixture();
  assert.equal(conflicts(s, 'apply').status, 2);
  slice(s);
  const before = sha(s.agents);
  const id = idIn(review(s).stdout, 'conflict');
  const dry = conflicts(s, 'apply', id);
  assert.equal(dry.status, 0);
  assert.match(dry.stderr, /--confirm/);
  assert.equal(sha(s.agents), before);
});

test('26.11 the MCP server offers no tool that writes an instruction file', () => {
  const s = fixture();
  const before = sha(s.agents);
  const [res] = tools(s.repo, s.data, s.configA, [['memory_search', { query: 'commit' }]]);
  assert.equal(res.isError, false);
  const server = readFileSync(join(process.cwd(), 'src/mcp/server.ts'), 'utf8');
  assert.doesNotMatch(server, /writeFileSync|applyEdit/);
  assert.equal(sha(s.agents), before);
});
