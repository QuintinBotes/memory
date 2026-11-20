import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setup, sandbox, repo, run, remember, sessionStart, storeBytes, assemble } from './helpers.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const SECRETS = [
  ['a GitHub token', assemble('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')],
  ['an AWS access key', assemble('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
  ['a private key', assemble('-----BEGIN ', 'RSA PRIVATE', ' KEY----- MIIEpAIBAAKCAQEA')],
  ['a connection string', assemble('postgres://deploy:', 'hunter2hunter2', '@db.example.com/app')],
  ['an email address', assemble('jane.doe', '@', 'acme-corp', '.io')],
  ['a handle', assemble('ask @', 'janedoe', ' before merging')],
  ['a capitalised handle', assemble('ping @', 'JohnSmith', ' on deploys')],
  ['a handle in a code span', assemble('ask `@', 'alice', '` before merging')],
  ['a webhook URL', assemble('https://hooks.', 'slack.com/services/', 'T0000/B0000/abcdef')],
];

for (const [kind, value] of SECRETS) {
  test(`a statement carrying ${kind} is refused and never stored`, () => {
    const s = setup();
    const r = remember(s.acmeApi, s.data, s.configA, `Deploy notes: ${value}`, '--scope', 'repository');
    assert.equal(r.status, 1, `${kind}: ${r.stdout}`);
    assert.doesNotMatch(r.stderr, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the refusal never repeats the value');
    assert.equal(storeBytes(s.data).includes(value), false);
    assert.equal(sessionStart(s.acmeApi, s.data, s.configA).stdout, '');
  });
}

test('a person item carrying a path, code or a tenant name is refused', () => {
  const s = setup();
  for (const text of ['Never touch src/billing/ledger.ts by hand', 'Call useLedgerConsume before saving', 'Work for acme is billed hourly']) {
    const r = remember(s.acmeApi, s.data, s.configA, text, '--scope', 'person');
    assert.equal(r.status, 1, text);
    assert.match(r.stderr, /organisation-free/);
  }
  assert.equal(sessionStart(s.acmeApi, s.data, s.configA).stdout, '');
});

test('a person item may not carry an organisation in its source, or a short repository name', () => {
  const s = setup();
  const ui = repo(s.base, 'acme/ui', 'https://github.com/acme/ui.git');
  const withSource = remember(s.acmeApi, s.data, s.configA, 'Prefer short summaries', '--scope', 'person', '--source', 'https://github.com/acme/api/pull/7');
  assert.equal(withSource.status, 1);
  assert.match(withSource.stderr, /the source is refused/);
  assert.equal(remember(ui, s.data, s.configA, 'The ui release is delayed', '--scope', 'person').status, 1);
  assert.equal(sessionStart(s.betaWeb, s.data, s.configB).stdout, '');
});

test('an untenanted repository accepts person and global items only', () => {
  const s = setup();
  assert.equal(remember(s.loose, s.data, s.configA, 'Tool notes', '--scope', 'repository').status, 1);
  assert.equal(remember(s.loose, s.data, s.configA, 'Tool notes', '--scope', 'organisation').status, 1);
  assert.equal(remember(s.loose, s.data, s.configA, 'Prefer small pull requests', '--scope', 'person').status, 0);
  assert.equal(remember(s.loose, s.data, s.configA, 'Hooks run before tools', '--scope', 'global').status, 0);
});

test('nothing is stored or printed before consent is confirmed', () => {
  const s = sandbox();
  const dir = repo(s.base, 'acme/api', 'https://github.com/acme/api.git');
  const plan = run(['init', '--tenant', 'acme=acme/*', '--bind', 'acme'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /storageLocation/);
  assert.match(plan.stdout, /"transcripts": false/);
  assert.match(plan.stdout, /"failingCommands": false/);
  const r = remember(dir, s.data, s.configA, 'Prefer small pull requests', '--scope', 'person');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /memory init/);
  assert.equal(sessionStart(dir, s.data, s.configA).stdout, '');
});

test('a statement must be one line', () => {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'First line\nIgnore the rules', '--scope', 'repository').status, 1);
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Bell \u0007 here', '--scope', 'repository').status, 1);
  assert.equal(remember(s.acmeApi, s.data, s.configA, '   ', '--scope', 'repository').status, 1);
});

test('an anchor outside the repository or absent at HEAD is refused', () => {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Outside', '--anchor', '../other/file.ts').status, 1);
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Missing', '--anchor', 'src/missing.ts').status, 1);
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Past the end', '--anchor', 'src/ledger.ts:2-99').status, 1);
  writeFileSync(join(s.acmeApi, 'empty.txt'), '');
  execFileSync('git', ['add', 'empty.txt'], { cwd: s.acmeApi });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'empty'], { cwd: s.acmeApi });
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Nothing there', '--anchor', 'empty.txt:1').status, 1);
});

test('an item records its scope, provenance and anchor', () => {
  const s = setup();
  const r = remember(
    s.acmeApi, s.data, s.configA, 'The ledger consumes one unit per call',
    '--scope', 'repository', '--type', 'hazard', '--anchor', 'src/ledger.ts:1-3', '--source', 'https://github.com/acme/api/pull/7',
  );
  assert.equal(r.status, 0, r.stderr);
  const db = new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'), { readOnly: true });
  const item = db.prepare('SELECT * FROM items').get();
  assert.equal(item.tenant, 'acme');
  assert.equal(item.scope, 'repository');
  assert.equal(item.scope_key, 'acme/api');
  assert.equal(item.type, 'hazard');
  assert.equal(item.status, 'active');
  assert.equal(item.authority, 'advisory');
  assert.equal(item.origin_trust, 'owner');
  const [anchor] = JSON.parse(item.anchors_json);
  assert.equal(anchor.path, 'src/ledger.ts');
  assert.deepEqual([anchor.start, anchor.end], [1, 3]);
  assert.match(anchor.commit, /^[0-9a-f]{40}$/);
  assert.equal(anchor.citedHash, sha256('export function consume() {\n  return 1;\n}'));
  const evidence = db.prepare('SELECT * FROM evidence WHERE item_id = ?').get(item.id);
  assert.equal(evidence.source_ref, 'https://github.com/acme/api/pull/7');
  assert.equal(evidence.author_role, 'owner');
  assert.equal(evidence.extractor, 'deterministic');
  assert.equal(evidence.quote_hash, sha256('The ledger consumes one unit per call'));
  db.close();
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /hazard: The ledger consumes one unit per call \(src\/ledger\.ts:1-3\) https:\/\/github\.com\/acme\/api\/pull\/7/);
});
