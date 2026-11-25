import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assemble, commit, remember, run, sessionStart, setup } from './helpers.mjs';

// Slice 16 (#19): promotion into checks. A proven item is proposed as a line of the review-standards file; an item on code
// no test executes is proposed as a test. Nothing is written until the owner applies it, and nothing is committed or pushed.
const YES = '--yes-non-interactive';
const STANDARD = 'Public handlers return a typed error, never a bare string';
const HAZARD = 'The ledger consumes one unit per call';
const SYMBOL = 'src/ledger.ts#consume#function';
const DEFAULT_FILE = 'docs/review-standards.md';

const exec = (s, args) => run(args, { cwd: s.acmeApi, data: s.data, config: s.configA });
const sql = (s, text, ...args) => {
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  try {
    return db.prepare(text).all(...args);
  } finally {
    db.close();
  }
};
const idOf = (r) => /remembered (m-[0-9a-f]+)/.exec(r.stdout)[1];
const head = (s) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.acmeApi, encoding: 'utf8' }).trim();
const status = (s) => execFileSync('git', ['status', '--porcelain'], { cwd: s.acmeApi, encoding: 'utf8' });
const proposalId = (text, target) => new RegExp(`\\[(p-[0-9a-f]+)\\] ${target}`).exec(text)?.[1];

/** A checkout with one convention that has the support to pass the bar (3), and a second with only 2. */
function world() {
  const s = setup();
  s.id = idOf(remember(s.acmeApi, s.data, s.configA, STANDARD, '--scope', 'repository', '--type', 'convention'));
  s.weak = idOf(remember(s.acmeApi, s.data, s.configA, 'Prefer small functions over long ones', '--scope', 'repository', '--type', 'convention'));
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare('UPDATE items SET support = 3 WHERE id = ?').run(s.id);
  db.prepare('UPDATE items SET support = 2 WHERE id = ?').run(s.weak);
  db.close();
  return s;
}
/** An item anchored at a symbol, with the facts slice 15 records: `tested` names a test that executes it; null says none does. */
function symbolItem(s, { tested = null, looked = true, statement = HAZARD } = {}) {
  const id = idOf(remember(s.acmeApi, s.data, s.configA, statement, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/ledger.ts'));
  const anchor = { path: 'src/ledger.ts', symbol: SYMBOL, signature: 'consume()', start: 1, end: 3, contentHash: 'H1', fileHash: 'F1', snapshot: 's1', ...(looked ? { testsAt: 's1' } : {}), ...(tested === null ? {} : { test: tested }) };
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare('UPDATE items SET anchors_json = ? WHERE id = ?').run(JSON.stringify([anchor]), id);
  db.close();
  return id;
}
const propose = (s) => exec(s, ['promote', '--propose']);
const apply = (s, id, ...flags) => exec(s, ['promote', '--apply', id, ...flags]);
const standardsLine = `- ${STANDARD}`;

test('US1.1 a well-supported convention is proposed with its target and the exact line to add; an item below the bar is not', () => {
  const s = world();
  const r = propose(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[p-[0-9a-f]+\] review-standards/);
  assert.ok(r.stdout.includes(DEFAULT_FILE), r.stdout);
  assert.ok(r.stdout.includes(`+${standardsLine}`), r.stdout);
  assert.ok(!r.stdout.includes('small functions'), 'the item with support 2 is below the bar');
  assert.equal(existsSync(join(s.acmeApi, DEFAULT_FILE)), false, 'proposing writes nothing');
});

test('US1.2 apply writes the line, marks the item promoted with promoted_to, and the next slice no longer has it', () => {
  const s = world();
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /typed error/, 'control: the item is in the slice before');
  const id = proposalId(propose(s).stdout, 'review-standards');
  const r = apply(s, id, YES);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(s.acmeApi, DEFAULT_FILE), 'utf8'), `${standardsLine}\n`);
  const [row] = sql(s, 'SELECT status, promoted_to FROM items WHERE id = ?', s.id);
  assert.deepEqual({ ...row }, { status: 'promoted', promoted_to: DEFAULT_FILE });
  assert.doesNotMatch(sessionStart(s.acmeApi, s.data, s.configA).stdout, /typed error/);
});

test('US1.2b the file is the one under imports.standards when config names it, and an existing file is appended to', () => {
  const s = world();
  const cfg = join(s.data, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), imports: { [s.acmeApi]: { standards: '.stack/review-standards.md' } } }));
  commit(s.acmeApi, { '.stack/review-standards.md': '- Keep handlers small\n' });
  const p = propose(s);
  assert.ok(p.stdout.includes('.stack/review-standards.md'), p.stdout);
  assert.equal(apply(s, proposalId(p.stdout, 'review-standards'), YES).status, 0);
  assert.equal(readFileSync(join(s.acmeApi, '.stack/review-standards.md'), 'utf8'), `- Keep handlers small\n${standardsLine}\n`);
});

test('US1.3 an item on a symbol no test executes proposes "write a test for" that symbol, and not for a tested or never-looked-up one', () => {
  const s = world();
  symbolItem(s);
  const r = propose(s);
  assert.match(r.stdout, /\[p-[0-9a-f]+\] test/);
  assert.ok(r.stdout.includes(`write a test for ${SYMBOL}`), r.stdout);
  // Positive controls: the same item with a test, and with no lookup yet, proposes no test.
  const t = world();
  symbolItem(t, { tested: { name: 'consumes once', path: 'test/ledger.test.ts', line: 4 } });
  assert.doesNotMatch(propose(t).stdout, /write a test for/);
  const u = world();
  symbolItem(u, { looked: false });
  assert.doesNotMatch(propose(u).stdout, /write a test for/);
});

test('FR-003 a test proposal is not applied as a promotion: the item stays active until a test exists', () => {
  const s = world();
  const id = symbolItem(s);
  const r = apply(s, proposalId(propose(s).stdout, 'test'), YES);
  assert.equal(r.status, 1);
  assert.equal(sql(s, 'SELECT status FROM items WHERE id = ?', id)[0].status, 'active');
  assert.equal(status(s), '');
});

test('US1.4 a rejected promotion is a tombstone: proposing again does not bring it back, while another proposal still comes', () => {
  const s = world();
  const hazard = symbolItem(s);
  const first = propose(s).stdout;
  const standard = proposalId(first, 'review-standards');
  assert.ok(standard && proposalId(first, 'test'), first);
  assert.equal(exec(s, ['promote', '--reject', standard]).status, 0);
  const again = propose(s).stdout;
  assert.equal(proposalId(again, 'review-standards'), undefined, again);
  assert.ok(proposalId(again, 'test'), 'control: the other proposal is still listed');
  assert.equal(sql(s, "SELECT status FROM promotions WHERE id = ?", standard)[0].status, 'rejected');
  assert.equal(sql(s, 'SELECT status FROM items WHERE id = ?', s.id)[0].status, 'active');
  assert.equal(existsSync(join(s.acmeApi, DEFAULT_FILE)), false);
  assert.ok(hazard);
});

test('FR-002 apply runs only from a terminal: without one it refuses and writes nothing', () => {
  const s = world();
  const id = proposalId(propose(s).stdout, 'review-standards');
  const r = apply(s, id);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /terminal/);
  assert.equal(existsSync(join(s.acmeApi, DEFAULT_FILE)), false);
  assert.equal(sql(s, 'SELECT status FROM items WHERE id = ?', s.id)[0].status, 'active');
  assert.equal(apply(s, id, YES).status, 0, 'control: the same command with the flag writes');
});

// A statement that cannot be stored cannot be proposed either, but a store edited by hand or by an older version is checked again at apply.
for (const [name, text] of [
  ['a secret', `Deploys use the token ${assemble('gh', 'p_', 'a'.repeat(36))}`],
  ['an email address', `Ask ${assemble('dana', '@', 'corp.io')} before changing this`],
  ['a handle', `Ask ${assemble('@', 'dana-w')} before changing this`],
]) {
  test(`edge a line holding ${name} is refused at apply, and nothing is written`, () => {
    const s = world();
    const id = proposalId(propose(s).stdout, 'review-standards');
    sql(s, 'UPDATE items SET statement = ? WHERE id = ?', text, s.id);
    const r = apply(s, id, YES);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refused|carries/);
    assert.equal(existsSync(join(s.acmeApi, DEFAULT_FILE)), false);
    assert.equal(sql(s, 'SELECT status FROM items WHERE id = ?', s.id)[0].status, 'active');
  });
}

test('edge a line naming a committer is refused, and the same line without the name is applied', () => {
  const s = world();
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'by someone'], {
    cwd: s.acmeApi,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Mara Ostrowski', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'Mara Ostrowski', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  const id = proposalId(propose(s).stdout, 'review-standards');
  sql(s, 'UPDATE items SET statement = ? WHERE id = ?', 'Mara Ostrowski prefers typed errors from handlers', s.id);
  const r = apply(s, id, YES);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /committer/);
  assert.equal(existsSync(join(s.acmeApi, DEFAULT_FILE)), false);
  sql(s, 'UPDATE items SET statement = ? WHERE id = ?', STANDARD, s.id);
  assert.equal(apply(s, id, YES).status, 0);
});

test('edge a target that is a symbolic link, or outside the repository, is refused', () => {
  const s = world();
  const id = proposalId(propose(s).stdout, 'review-standards');
  // A link, even to a file inside the repository.
  mkdirSync(join(s.acmeApi, 'docs'), { recursive: true });
  writeFileSync(join(s.acmeApi, 'real.md'), 'real\n');
  symlinkSync(join(s.acmeApi, 'real.md'), join(s.acmeApi, DEFAULT_FILE));
  const r = apply(s, id, YES);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /symbolic link/);
  assert.equal(readFileSync(join(s.acmeApi, 'real.md'), 'utf8'), 'real\n');
  // A directory that is a link out of the repository.
  const t = world();
  const out = join(t.base, 'elsewhere');
  mkdirSync(out);
  symlinkSync(out, join(t.acmeApi, 'docs'));
  const id2 = proposalId(propose(t).stdout, 'review-standards');
  const r2 = apply(t, id2, YES);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /outside the repository/);
  assert.equal(existsSync(join(out, 'review-standards.md')), false);
  // A configured path that climbs out.
  const u = world();
  const cfg = join(u.data, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), imports: { [u.acmeApi]: { standards: '../escape.md' } } }));
  const r3 = propose(u);
  assert.doesNotMatch(r3.stdout, /review-standards/);
  assert.equal(existsSync(join(dirname(u.acmeApi), 'escape.md')), false);
  assert.ok(lstatSync(join(s.acmeApi, DEFAULT_FILE)).isSymbolicLink());
});

test('edge promotion never commits, pushes or opens a pull request: it leaves one modified file for the owner to review', () => {
  const s = world();
  const before = head(s);
  const refs = execFileSync('git', ['for-each-ref'], { cwd: s.acmeApi, encoding: 'utf8' });
  const r = apply(s, proposalId(propose(s).stdout, 'review-standards'), YES);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(head(s), before);
  assert.equal(execFileSync('git', ['for-each-ref'], { cwd: s.acmeApi, encoding: 'utf8' }), refs);
  assert.equal(status(s).trim(), `?? docs/`);
});
