import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
function symbolItem(s, { tested = null, looked = true, statement = HAZARD, support = 3 } = {}) {
  const id = idOf(remember(s.acmeApi, s.data, s.configA, statement, '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/ledger.ts'));
  const anchor = { path: 'src/ledger.ts', symbol: SYMBOL, signature: 'consume()', start: 1, end: 3, contentHash: 'H1', fileHash: 'F1', snapshot: 's1', ...(looked ? { testsAt: 's1' } : {}), ...(tested === null ? {} : { test: tested }) };
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare('UPDATE items SET anchors_json = ?, support = ? WHERE id = ?').run(JSON.stringify([anchor]), support, id);
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

const configure = (s, standards) => {
  const cfg = join(s.data, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), imports: { [s.acmeApi]: { standards } } }));
};
const written = (s) => existsSync(join(s.acmeApi, DEFAULT_FILE));
const itemStatus = (s, id = s.id) => sql(s, 'SELECT status FROM items WHERE id = ?', id)[0].status;

test('review 1 apply re-checks the bar: a contradiction added after the proposal refuses it', () => {
  const s = world();
  const id = proposalId(propose(s).stdout, 'review-standards');
  sql(s, 'UPDATE items SET contradictions = 1 WHERE id = ?', s.id);
  const r = apply(s, id, YES);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no longer/);
  assert.equal(written(s), false);
  assert.equal(itemStatus(s), 'active');
  // Control: nothing changed, so it applies.
  const t = world();
  assert.equal(apply(t, proposalId(propose(t).stdout, 'review-standards'), YES).status, 0);
});

test('review 1b apply re-checks support, type and scope too', () => {
  for (const change of ['support = 2', "type = 'hazard'", "scope = 'organisation'"]) {
    const s = world();
    const id = proposalId(propose(s).stdout, 'review-standards');
    sql(s, `UPDATE items SET ${change} WHERE id = ?`, s.id);
    const r = apply(s, id, YES);
    assert.equal(r.status, 1, change);
    assert.equal(written(s), false, change);
  }
});

test('review 2 a tainted item, or one not from the owner, is not proposed and not applied', () => {
  for (const change of ["UPDATE evidence SET taint = 'web' WHERE item_id = ?", "UPDATE items SET origin_trust = 'agent' WHERE id = ?"]) {
    const before = world();
    sql(before, change, before.id);
    assert.doesNotMatch(propose(before).stdout, /review-standards/, change);
    const s = world();
    const id = proposalId(propose(s).stdout, 'review-standards');
    sql(s, change, s.id);
    const r = apply(s, id, YES);
    assert.equal(r.status, 1, change);
    assert.equal(written(s), false, change);
  }
});

test('review 3 a test proposal passes the same bar: support 3, owner, untainted, repository scope, no contradiction', () => {
  const s = world();
  const low = symbolItem(s, { support: 1, statement: 'The ledger rounds half up' });
  assert.doesNotMatch(propose(s).stdout, /write a test for/, 'support 1 is below the bar');
  sql(s, 'UPDATE items SET support = 3 WHERE id = ?', low);
  assert.match(propose(s).stdout, /write a test for/, 'control: at support 3 it is proposed');
  for (const change of ['contradictions = 1', "origin_trust = 'agent'", "scope = 'organisation'"]) {
    const t = world();
    const id = symbolItem(t);
    sql(t, `UPDATE items SET ${change} WHERE id = ?`, id);
    assert.doesNotMatch(propose(t).stdout, /write a test for/, change);
  }
  const u = world();
  const tainted = symbolItem(u);
  sql(u, "UPDATE evidence SET taint = 'web' WHERE item_id = ?", tainted);
  assert.doesNotMatch(propose(u).stdout, /write a test for/);
});

test('review 5 a dangling symbolic link as the target is refused', () => {
  const s = world();
  const id = proposalId(propose(s).stdout, 'review-standards');
  mkdirSync(join(s.acmeApi, 'docs'), { recursive: true });
  symlinkSync(join(s.base, 'nowhere.md'), join(s.acmeApi, DEFAULT_FILE));
  const r = apply(s, id, YES);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /symbolic link/);
  assert.equal(existsSync(join(s.base, 'nowhere.md')), false);
  assert.equal(itemStatus(s), 'active');
});

test('review 6 targets under .git, and instruction files, are never proposed or applied', () => {
  for (const target of ['.git/hooks/pre-commit', '.git/config', 'CLAUDE.md', 'AGENTS.md', 'sub/GEMINI.md', '.claude/settings.md', '.github/workflows/ci.yml', '.github/copilot-instructions.md']) {
    const s = world();
    configure(s, target);
    assert.doesNotMatch(propose(s).stdout, /review-standards/, target);
  }
  // Control: an ordinary configured path is proposed.
  const ok = world();
  configure(ok, 'docs/standards.md');
  assert.match(propose(ok).stdout, /review-standards/);
  // A stored proposal for a forbidden file is refused at apply too.
  const s = world();
  const id = proposalId(propose(s).stdout, 'review-standards');
  sql(s, "UPDATE promotions SET file = '.git/hooks/pre-commit' WHERE id = ?", id);
  const r = apply(s, id, YES);
  assert.equal(r.status, 1);
  assert.equal(existsSync(join(s.acmeApi, '.git/hooks/pre-commit')), false);
});

test('review 7 an item promoted into the standards file cannot also be applied as an instruction-file edit, and the reverse', () => {
  const s = world();
  sessionStart(s.acmeApi, s.data, s.configA);
  const edit = /\[(c-[0-9a-f]+)\] promotion/.exec(exec(s, ['conflicts']).stdout)?.[1];
  assert.ok(edit, 'the screen proposed an instruction-file promotion');
  const id = proposalId(propose(s).stdout, 'review-standards');
  assert.equal(apply(s, id, YES).status, 0);
  const r = exec(s, ['conflicts', 'apply', edit, '--confirm', YES]);
  assert.equal(r.status, 1);
  assert.equal(existsSync(join(s.acmeApi, 'CLAUDE.md')), false);
  // The reverse: the instruction file first.
  const t = world();
  sessionStart(t.acmeApi, t.data, t.configA);
  const edit2 = /\[(c-[0-9a-f]+)\] promotion/.exec(exec(t, ['conflicts']).stdout)?.[1];
  const id2 = proposalId(propose(t).stdout, 'review-standards');
  assert.equal(exec(t, ['conflicts', 'apply', edit2, '--confirm', YES]).status, 0);
  assert.equal(apply(t, id2, YES).status, 1);
  assert.equal(written(t), false);
});

test('review 7b an instruction-file edit for an item that is no longer active is refused', () => {
  const s = world();
  sessionStart(s.acmeApi, s.data, s.configA);
  const edit = /\[(c-[0-9a-f]+)\] promotion/.exec(exec(s, ['conflicts']).stdout)?.[1];
  sql(s, "UPDATE items SET status = 'stale' WHERE id = ?", s.id);
  const r = exec(s, ['conflicts', 'apply', edit, '--confirm', YES]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no longer active/);
  assert.equal(existsSync(join(s.acmeApi, 'CLAUDE.md')), false);
});

test('review 8a a convention below the type list, a tenant-wide item and a hazard with support 3 are not proposed', () => {
  const s = world();
  sql(s, "UPDATE items SET type = 'hazard' WHERE id = ?", s.id);
  assert.doesNotMatch(propose(s).stdout, /review-standards/, 'excluded type');
  const t = world();
  sql(t, "UPDATE items SET scope = 'organisation', scope_key = 'acme' WHERE id = ?", t.id);
  assert.doesNotMatch(propose(t).stdout, /review-standards/, 'tenant-wide item');
});

test('review 8b a person item is never proposed into a repository file', () => {
  const s = world();
  const r = remember(s.acmeApi, s.data, s.configA, 'Prefer early returns over nested branches', '--scope', 'person', '--type', 'preference');
  assert.equal(r.status, 0, r.stderr);
  const db = new DatabaseSync(join(s.data, 'person.sqlite'));
  db.prepare('UPDATE items SET support = 5').run();
  db.close();
  const out = propose(s).stdout;
  assert.doesNotMatch(out, /early returns/);
  assert.match(out, /review-standards/, 'control: the repository item is proposed');
});

test('review 8c an existing file keeps its mode', () => {
  const s = world();
  commit(s.acmeApi, { [DEFAULT_FILE]: '- Keep handlers small\n' });
  chmodSync(join(s.acmeApi, DEFAULT_FILE), 0o640);
  assert.equal(apply(s, proposalId(propose(s).stdout, 'review-standards'), YES).status, 0);
  assert.equal(statSync(join(s.acmeApi, DEFAULT_FILE)).mode & 0o777, 0o640);
});

test('review 8d an absolute configured path is not proposed, and writes nothing', () => {
  const s = world();
  const abs = join(s.base, 'abs-standards.md');
  configure(s, abs);
  assert.doesNotMatch(propose(s).stdout, /review-standards/);
  assert.equal(existsSync(abs), false);
});

test('review 8e a line the file already holds appends nothing, says so, and leaves the item active', () => {
  const s = world();
  const id = proposalId(propose(s).stdout, 'review-standards');
  commit(s.acmeApi, { [DEFAULT_FILE]: `${standardsLine}\n` });
  const before = readFileSync(join(s.acmeApi, DEFAULT_FILE), 'utf8');
  const r = apply(s, id, YES);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already holds that line/);
  assert.equal(readFileSync(join(s.acmeApi, DEFAULT_FILE), 'utf8'), before);
  assert.equal(itemStatus(s), 'active');
});
