import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setup, run, remember, sessionStart, storeBytes, assemble } from './helpers.mjs';

const EMAIL = assemble('jane.doe', '@', 'acme-corp', '.io');
/** A retro rejection two days old, so it is still within its 30 days. */
const REJECTED_AT = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** One auto memory topic file, in the shape Claude Code writes it. */
const topic = (name, description) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\nDetail the model wrote, which is not imported.\n`;

/**
 * Fixture silos: auto memory in both configs, and a review-standards file, a
 * rejections record, a Review Voice policy and a notes import file in acme/api.
 */
function silos() {
  const s = setup();
  const memA = join(s.configA, 'projects', '-tmp-work', 'memory');
  const memB = join(s.configB, 'projects', '-tmp-beta', 'memory');
  write(join(memA, 'MEMORY.md'), [
    '# Memory index',
    '',
    '- [Releases](release.md) - how releases are cut',
    '- [Gone](ghost.md) - a file that exists in neither folder',
    '- [Docs](https://example.com/docs.md) - not a local file',
    '- Prefer short pull request descriptions',
    '',
  ].join('\n'));
  write(join(memA, 'release.md'), topic('release', 'Releases of acme/api are cut from the main branch only'));
  write(join(memA, 'secret.md'), topic('secret', `Send release notes to ${EMAIL}`));
  write(join(memA, 'orgish.md'), topic('orgish', 'The ledger in src/billing/ledger.ts is fragile'));
  write(join(memA, 'cross.md'), topic('cross', 'Acme and beta share one release train for acme/api and beta/web'));
  write(join(s.base, 'outside.md'), topic('outside', 'Planted outside the memory folder'));
  symlinkSync(join(s.base, 'outside.md'), join(memA, 'link.md'));
  write(join(memB, 'MEMORY.md'), '- [Deploys](deploys.md) - deploys\n- [Api](api.md) - api\n');
  write(join(memB, 'deploys.md'), topic('deploys', 'Deploys of beta/web need a second approver'));
  write(join(memB, 'api.md'), topic('api', 'The acme/api pager rotates weekly'));

  write(join(s.acmeApi, '.stack', 'review-standards.md'), [
    '# Review standards',
    '',
    'One line per judgement call a person approved.',
    '',
    '- Every public handler validates its input',
    '- Every handler logs its request id',
    '',
  ].join('\n'));
  write(
    join(s.acmeApi, '.git', 'stack', 'retro-rejected.jsonl'),
    `${JSON.stringify({ kind: 'standard', text: 'Every handler logs its request id', at: REJECTED_AT })}\n`,
  );
  write(join(s.acmeApi, '.review-voice', 'policy.yaml'), [
    'scope:',
    '  type: repository',
    '  key: acme/api',
    'priorities:',
    '  - category: release',
    '    weight: high',
    'suppressed_patterns:',
    '  - "Readable naming alternatives without a concrete failure mode."',
    'required_checks:',
    "  - 'Changes to distribution files keep the version consistent.'",
    '',
  ].join('\n'));
  write(join(s.acmeApi, 'notes.jsonl'), [
    JSON.stringify({ kind: 'gotcha', text: 'consume is called with the ledger lock held', symbol: 'src/ledger.ts#consume#function' }),
    JSON.stringify({ kind: 'domain', text: 'The ledger tracks units' }),
    JSON.stringify({ kind: 'glossary', text: 'A unit is one call' }),
    '',
  ].join('\n'));

  const path = join(s.data, 'config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.imports = {
    [s.acmeApi]: {
      standards: '.stack/review-standards.md',
      rejections: '.git/stack/retro-rejected.jsonl',
      policy: '.review-voice/policy.yaml',
      notes: 'notes.jsonl',
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return { ...s, memA, memB };
}

const importSilos = (s, ...flags) => {
  const r = run(['import', ...flags], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

function items(data, file, where = '1=1') {
  const db = new DatabaseSync(join(data, file), { readOnly: true });
  const rows = db.prepare(`SELECT * FROM items WHERE ${where} ORDER BY statement`).all();
  for (const row of rows) row.evidence = db.prepare('SELECT * FROM evidence WHERE item_id = ?').all(row.id);
  db.close();
  return rows;
}

const byStatement = (rows, text) => rows.find((r) => r.statement === text);

test('a dry run lists every file with its statement count and the dangling link, and writes nothing', () => {
  const s = silos();
  const before = storeBytes(s.data);
  const report = importSilos(s, '--dry-run');
  const counts = Object.fromEntries(report.files.map((f) => [f.path, f.statements]));
  assert.deepEqual(counts, {
    [join(s.memA, 'MEMORY.md')]: 1,
    [join(s.memA, 'cross.md')]: 1,
    [join(s.memA, 'orgish.md')]: 1,
    [join(s.memA, 'release.md')]: 1,
    [join(s.memA, 'secret.md')]: 1,
    [join(s.memB, 'MEMORY.md')]: 0,
    [join(s.memB, 'api.md')]: 1,
    [join(s.memB, 'deploys.md')]: 1,
    [join(s.acmeApi, '.stack/review-standards.md')]: 2,
    [join(s.acmeApi, '.git/stack/retro-rejected.jsonl')]: 1,
    [join(s.acmeApi, '.review-voice/policy.yaml')]: 2,
    [join(s.acmeApi, 'notes.jsonl')]: 1,
  });
  assert.deepEqual(report.danglingLinks, [{ file: join(s.memA, 'MEMORY.md'), link: 'ghost.md' }]);
  assert.equal(storeBytes(s.data).equals(before), true, 'a dry run writes nothing');
});

test('each statement becomes a proposal with its source file and line, in the tenant of the repository it names', () => {
  const s = silos();
  const report = importSilos(s);
  const acme = items(s.data, 'tenants/acme.sqlite');
  const release = byStatement(acme, 'Releases of acme/api are cut from the main branch only');
  assert.equal(release.status, 'proposed');
  assert.equal(release.scope, 'repository');
  assert.equal(release.scope_key, 'acme/api');
  assert.equal(release.origin_trust, 'agent', 'auto memory is written by a model, so it never gets owner trust');
  assert.equal(release.evidence.length, 1);
  assert.equal(release.evidence[0].source_ref, 'auto memory release.md:3', 'the folder, another checkout\'s path, is not stored');
  assert.equal(release.evidence[0].author_role, 'agent');

  const standard = byStatement(acme, 'Every public handler validates its input');
  assert.equal(standard.status, 'proposed');
  assert.equal(standard.origin_trust, 'owner');
  assert.equal(standard.evidence[0].source_ref, `${join(s.acmeApi, '.stack/review-standards.md')}:5`);
  const policy = byStatement(acme, 'Readable naming alternatives without a concrete failure mode.');
  assert.equal(policy.evidence[0].source_ref, `${join(s.acmeApi, '.review-voice/policy.yaml')}:8`);
  assert.ok(byStatement(acme, 'Changes to distribution files keep the version consistent.'));

  const beta = items(s.data, 'tenants/beta.sqlite');
  assert.equal(byStatement(beta, 'Deploys of beta/web need a second approver').status, 'proposed');

  const person = items(s.data, 'person.sqlite');
  const short = byStatement(person, 'Prefer short pull request descriptions');
  assert.equal(short.scope, 'person');
  assert.equal(short.status, 'proposed');
  assert.equal(short.evidence[0].source_ref, 'auto memory MEMORY.md:6', 'a person item carries no path that could name an organisation');

  assert.equal(report.proposed, 7);
  // Nothing imported is active, so nothing reaches a session.
  assert.equal(sessionStart(s.acmeApi, s.data, s.configA).stdout, '');
});

test('an auto memory statement goes only to a tenant its own config is bound to', () => {
  const s = silos();
  const report = importSilos(s);
  const api = join(s.memB, 'api.md');
  assert.ok(report.refused.some((r) => r.source === `${api}:3` && /not bound/.test(r.reason)), JSON.stringify(report.refused));
  assert.equal(byStatement(items(s.data, 'tenants/acme.sqlite'), 'The acme/api pager rotates weekly'), undefined);
  const cross = join(s.memA, 'cross.md');
  assert.ok(report.refused.some((r) => r.source === `${cross}:3` && /more than one repository/.test(r.reason)));
});

test('the dangling link is reported by name and nothing is created for it', () => {
  const s = silos();
  const report = importSilos(s);
  assert.deepEqual(report.danglingLinks, [{ file: join(s.memA, 'MEMORY.md'), link: 'ghost.md' }]);
  assert.equal(storeBytes(s.data).includes('a file that exists in neither folder'), false);
  assert.equal(storeBytes(s.data).includes('ghost'), false);
});

test('a gotcha note arrives with its symbol anchor; other kinds are skipped and counted', () => {
  const s = silos();
  const report = importSilos(s);
  const note = byStatement(items(s.data, 'tenants/acme.sqlite'), 'consume is called with the ledger lock held');
  assert.equal(note.status, 'proposed');
  assert.equal(note.type, 'hazard');
  assert.deepEqual(JSON.parse(note.anchors_json), [{ path: 'src/ledger.ts', symbol: 'src/ledger.ts#consume#function' }]);
  assert.equal(note.evidence[0].source_ref, `${join(s.acmeApi, 'notes.jsonl')}:1`);
  assert.equal(report.skippedNotes, 2);
  assert.equal(storeBytes(s.data).includes('The ledger tracks units'), false);
});

const proposalId = (s, file, text) => byStatement(items(s.data, file), text).id;

test('approve makes a proposal active, and it appears in the next slice of its tenant', () => {
  const s = silos();
  importSilos(s);
  const id = proposalId(s, 'tenants/acme.sqlite', 'Releases of acme/api are cut from the main branch only');
  const r = run(['approve', id], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /Releases of acme\/api are cut from the main branch only/);
  assert.doesNotMatch(sessionStart(s.acmeWeb, s.data, s.configA).stdout, /Releases of acme\/api/);

  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'), { readOnly: true });
  const audit = db.prepare("SELECT metadata_json FROM audit_events WHERE action = 'proposal_approved' AND subject_id = ?").get(id);
  db.close();
  assert.deepEqual(JSON.parse(audit.metadata_json), { decision: 'approve', shadow: 'hold', scope: 'repository' });
});

test('approve --scope widens a repository proposal to its organisation', () => {
  const s = silos();
  importSilos(s);
  const id = proposalId(s, 'tenants/acme.sqlite', 'Every public handler validates its input');
  assert.equal(run(['approve', id, '--scope', 'organisation'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.match(sessionStart(s.acmeWeb, s.data, s.configA).stdout, /Every public handler validates its input/);
  const person = proposalId(s, 'person.sqlite', 'Prefer short pull request descriptions');
  const cross = run(['approve', person, '--scope', 'repository'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(cross.status, 1, 'a proposal never moves between the person file and a tenant file');
});

test('reject keeps a tombstone, and a later import never proposes the statement again', () => {
  const s = silos();
  importSilos(s);
  const id = proposalId(s, 'tenants/acme.sqlite', 'Every public handler validates its input');
  const r = run(['reject', id, '--reason', 'too broad'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  const [tomb] = items(s.data, 'tenants/acme.sqlite', `id = '${id}'`);
  assert.equal(tomb.status, 'rejected');
  assert.equal(tomb.status_reason, 'too broad');
  assert.ok(tomb.valid_to);

  write(join(s.acmeApi, '.stack', 'review-standards.md'), '- every public handler validates its input.\n');
  const again = importSilos(s);
  assert.equal(again.proposed, 0);
  assert.ok(again.rejectedBefore >= 1);
  assert.equal(items(s.data, 'tenants/acme.sqlite', "statement LIKE '%validates its input%'").length, 1);
});

test('a statement already known is never proposed twice', () => {
  const s = silos();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Every public handler validates its input', '--scope', 'repository').status, 0);
  const first = importSilos(s);
  assert.equal(first.proposed, 6);
  const second = importSilos(s);
  assert.equal(second.proposed, 0);
  assert.equal(second.tombstones, 0);
  const acme = items(s.data, 'tenants/acme.sqlite');
  assert.equal(acme.filter((r) => r.statement === 'Every public handler validates its input').length, 1);
  assert.equal(new Set(acme.map((r) => r.statement.toLowerCase())).size, acme.length);
  assert.equal(items(s.data, 'person.sqlite').length, 1);
});

test('a statement holding a secret, an email or a handle is skipped and counted, never stored or printed', () => {
  const s = silos();
  const token = assemble('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  write(join(s.acmeApi, '.stack', 'review-standards.md'), `- Deploy with ${token}\n- Ask @${'janedoe'} before merging\n`);
  const r = run(['import'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const secret = join(s.memA, 'secret.md');
  assert.ok(report.refused.some((x) => x.source === `${secret}:3` && /email/.test(x.reason)));
  assert.ok(report.refused.some((x) => /secret/.test(x.reason)));
  assert.ok(report.refused.some((x) => /handle/.test(x.reason)));
  for (const value of [EMAIL, token, 'janedoe']) {
    assert.equal(storeBytes(s.data).includes(value), false, value);
    assert.equal(r.stdout.includes(value) || r.stderr.includes(value), false, value);
  }
});

test('a rejected retro proposal arrives as a tombstone, not a proposal', () => {
  const s = silos();
  const report = importSilos(s);
  const rows = items(s.data, 'tenants/acme.sqlite', "statement = 'Every handler logs its request id'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'rejected');
  assert.equal(rows[0].valid_to.slice(0, 10), REJECTED_AT);
  assert.equal(report.tombstones, 1);
});

test('a silo file that is a symbolic link outside its folder is skipped and reported', () => {
  const s = silos();
  const report = importSilos(s);
  assert.ok(report.skippedFiles.some((f) => f.path === join(s.memA, 'link.md') && /symbolic link/.test(f.reason)));
  assert.equal(storeBytes(s.data).includes('Planted outside'), false);
});

test('a statement that names no tenant and fails the organisation-free check is reported and not stored', () => {
  const s = silos();
  const report = importSilos(s);
  const orgish = join(s.memA, 'orgish.md');
  assert.ok(report.refused.some((r) => r.source === `${orgish}:3` && /organisation-free/.test(r.reason)));
  assert.equal(storeBytes(s.data).includes('is fragile'), false);
});

test('review lists proposals with evidence, scope and the shadow gate, only for this tenant and the person file', () => {
  const s = silos();
  importSilos(s);
  const out = run(['review'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Releases of acme\/api are cut from the main branch only/);
  assert.match(out.stdout, /repository acme\/api/);
  assert.match(out.stdout, /evidence: auto memory release\.md:3 \(agent\)/);
  assert.match(out.stdout, /shadow gate: hold/);
  assert.match(out.stdout, /Prefer short pull request descriptions/);
  assert.doesNotMatch(out.stdout, /Deploys of beta\/web/, 'another tenant is never listed');

  const beta = run(['review'], { cwd: s.betaWeb, data: s.data, config: s.configB });
  assert.match(beta.stdout, /Deploys of beta\/web/);
  assert.doesNotMatch(beta.stdout, /acme/);
  const id = proposalId(s, 'tenants/acme.sqlite', 'Releases of acme/api are cut from the main branch only');
  assert.equal(run(['approve', id], { cwd: s.betaWeb, data: s.data, config: s.configB }).status, 1);
  assert.equal(byStatement(items(s.data, 'tenants/acme.sqlite'), 'Releases of acme/api are cut from the main branch only').status, 'proposed');
});

test('a tombstone is reduced to a hash and a type 30 days after rejection, and still blocks the statement', () => {
  const s = silos();
  importSilos(s);
  const id = proposalId(s, 'tenants/acme.sqlite', 'Every public handler validates its input');
  assert.equal(run(['reject', id, '--reason', 'too broad'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare('UPDATE items SET valid_to = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), id);
  db.close();

  assert.equal(run(['review'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  const [tomb] = items(s.data, 'tenants/acme.sqlite', `id = '${id}'`);
  assert.equal(tomb.status, 'rejected');
  assert.equal(tomb.statement, '');
  assert.equal(tomb.status_reason, null);
  assert.equal(tomb.anchors_json, '[]');
  assert.equal(tomb.evidence.length, 0);
  assert.match(tomb.statement_key, /^[0-9a-f]{64}$/);
  assert.equal(tomb.type, 'convention');

  const again = importSilos(s);
  assert.equal(again.proposed, 0);
  assert.equal(byStatement(items(s.data, 'tenants/acme.sqlite'), 'Every public handler validates its input'), undefined);
});

test('a purge by age never turns a tombstone back into a proposal', () => {
  const s = silos();
  importSilos(s);
  assert.equal(run(['purge', '--older-than', '0', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
  const rows = items(s.data, 'tenants/acme.sqlite', "status != 'proposed'");
  assert.deepEqual(rows.map((r) => r.status), ['rejected']);
});

/** One more auto memory topic file in config A's folder. */
const addTopic = (s, name, description) => write(join(s.memA, name), topic(name.replace(/\.md$/, ''), description));

test('an auto memory statement naming its repository and another tenant\'s owner is refused', () => {
  const s = silos();
  addTopic(s, 'mixed.md', 'acme/api deploys pause during the Beta launch');
  const report = importSilos(s);
  assert.ok(report.refused.some((r) => r.source === `${join(s.memA, 'mixed.md')}:3` && /another tenant/.test(r.reason)), JSON.stringify(report.refused));
  assert.equal(storeBytes(s.data).includes('Beta launch'), false);
});

test('a repository named with its .git suffix is the same repository', () => {
  const s = silos();
  addTopic(s, 'clone.md', 'Clone https://github.com/acme/api.git shallowly in CI');
  importSilos(s);
  assert.equal(byStatement(items(s.data, 'tenants/acme.sqlite'), 'Clone https://github.com/acme/api.git shallowly in CI').scope_key, 'acme/api');
});

test('a person statement that names a tenant, an unknown owner/repo, or sits in a file named after a tenant is refused', () => {
  const s = silos();
  addTopic(s, 'word.md', 'Acme deploys need two approvals');
  addTopic(s, 'other.md', 'globex/api deploys need the VPN');
  addTopic(s, 'beta-notes.md', 'Prefer squash merges');
  const report = importSilos(s);
  for (const [file, reason] of [['word.md', /organisation-free/], ['other.md', /owner\/repo/], ['beta-notes.md', /file name/]]) {
    assert.ok(report.refused.some((r) => r.source === `${join(s.memA, file)}:3` && reason.test(r.reason)), `${file}: ${JSON.stringify(report.refused)}`);
  }
  const person = items(s.data, 'person.sqlite').map((r) => r.statement);
  assert.deepEqual(person, ['Prefer short pull request descriptions']);
});

test('a later rejection in the retro record turns an open proposal into a tombstone', () => {
  const s = silos();
  importSilos(s);
  const file = join(s.acmeApi, '.git', 'stack', 'retro-rejected.jsonl');
  write(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ kind: 'standard', text: 'Every public handler validates its input', at: REJECTED_AT })}\n`);
  const again = importSilos(s);
  assert.equal(again.tombstones, 1);
  const [row] = items(s.data, 'tenants/acme.sqlite', "statement = 'Every public handler validates its input'");
  assert.equal(row.status, 'rejected');
  const review = run(['review'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.doesNotMatch(review.stdout, /validates its input/);
});

test('an imported rejection older than 30 days is reduced at once', () => {
  const s = silos();
  const old = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  write(join(s.acmeApi, '.git', 'stack', 'retro-rejected.jsonl'), `${JSON.stringify({ kind: 'standard', text: 'Every handler logs its request id', at: old })}\n`);
  importSilos(s);
  const [tomb] = items(s.data, 'tenants/acme.sqlite', "status = 'rejected'");
  assert.equal(tomb.statement, '');
  assert.equal(tomb.evidence.length, 0);
});

test('a reduced tombstone keeps its repository, so a purge of that repository removes it', () => {
  const s = silos();
  importSilos(s);
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare("UPDATE items SET valid_to = ? WHERE status = 'rejected'").run(new Date(Date.now() - 31 * 86_400_000).toISOString());
  db.close();
  assert.equal(run(['review'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  const [tomb] = items(s.data, 'tenants/acme.sqlite', "status = 'rejected'");
  assert.equal(tomb.statement, '');
  assert.equal(run(['purge', '--repo', 'acme/api', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
  assert.equal(items(s.data, 'tenants/acme.sqlite', "status = 'rejected'").length, 0);
});

test('a purge by age leaves an expired item alone, and an item it leaves without evidence cannot be approved', () => {
  const s = silos();
  importSilos(s);
  const id = proposalId(s, 'tenants/acme.sqlite', 'Every public handler validates its input');
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare("UPDATE items SET status = 'expired', valid_to = ? WHERE id = ?").run(new Date().toISOString(), id);
  db.close();
  assert.equal(run(['purge', '--older-than', '0', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
  assert.equal(items(s.data, 'tenants/acme.sqlite', `id = '${id}'`)[0].status, 'expired');

  const release = proposalId(s, 'tenants/acme.sqlite', 'Releases of acme/api are cut from the main branch only');
  assert.equal(items(s.data, 'tenants/acme.sqlite', `id = '${release}'`)[0].evidence.length, 0);
  assert.equal(run(['review'], { cwd: s.acmeApi, data: s.data, config: s.configA }).stdout, '');
  assert.equal(run(['approve', release], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 1);
});

test('a reject reason kept in the person file must be organisation-free', () => {
  const s = silos();
  importSilos(s);
  const id = proposalId(s, 'person.sqlite', 'Prefer short pull request descriptions');
  const r = run(['reject', id, '--reason', 'acme reviewers asked for this'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /organisation-free/);
  assert.equal(items(s.data, 'person.sqlite')[0].status, 'proposed');
});

test('a Review Voice policy written as an indentless list, with escaped quotes, is read', () => {
  const s = silos();
  write(join(s.acmeApi, '.review-voice', 'policy.yaml'), [
    'suppressed_patterns:',
    `- ${JSON.stringify('Suppress "nit" comments on generated files')}`,
    'required_checks:',
    '- Releases keep the version consistent',
    '',
  ].join('\n'));
  importSilos(s);
  const acme = items(s.data, 'tenants/acme.sqlite');
  assert.ok(byStatement(acme, 'Suppress "nit" comments on generated files'));
  assert.ok(byStatement(acme, 'Releases keep the version consistent'));
});

test('an approved note keeps its symbol anchor through the session-start re-check', () => {
  const s = silos();
  importSilos(s);
  const id = proposalId(s, 'tenants/acme.sqlite', 'consume is called with the ledger lock held');
  assert.equal(run(['approve', id], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /consume is called with the ledger lock held \(src\/ledger\.ts#consume#function\)/);
  assert.equal(items(s.data, 'tenants/acme.sqlite', `id = '${id}'`)[0].status, 'active');
});
