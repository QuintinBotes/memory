import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, repo, run, remember, sessionStart } from './helpers.mjs';

const REPO_ITEM = 'Releases are cut from the main branch only';
const ORG_ITEM = 'Every service exposes a health endpoint';
const PERSON_ITEM = 'Explain changes in plain English';

function seeded() {
  const s = setup();
  const ok = (r) => assert.equal(r.status, 0, r.stderr);
  ok(remember(s.acmeApi, s.data, s.configA, REPO_ITEM, '--scope', 'repository', '--type', 'convention', '--anchor', 'src/ledger.ts:1-3'));
  ok(remember(s.acmeApi, s.data, s.configA, ORG_ITEM, '--scope', 'organisation', '--type', 'convention'));
  ok(remember(s.acmeApi, s.data, s.configA, PERSON_ITEM, '--scope', 'person', '--type', 'preference'));
  return s;
}

test('a remembered item reaches the next session in its repository, tenant and config', () => {
  const s = seeded();
  const out = sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`\\[m-[0-9a-f]+\\] convention: ${REPO_ITEM}`));
  assert.match(out.stdout, /src\/ledger\.ts:1-3/);
  assert.match(out.stdout, new RegExp(ORG_ITEM));
  assert.match(out.stdout, new RegExp(PERSON_ITEM));
});

test('tenant A items are absent from a tenant B repository', () => {
  const s = seeded();
  const out = sessionStart(s.betaWeb, s.data, s.configA).stdout;
  assert.doesNotMatch(out, new RegExp(REPO_ITEM));
  assert.doesNotMatch(out, new RegExp(ORG_ITEM));
  assert.match(out, new RegExp(PERSON_ITEM));
});

test('tenant items are absent from untenanted repositories and repositories with no remote', () => {
  const s = seeded();
  for (const dir of [s.loose, s.noRemote, s.base]) {
    const out = sessionStart(dir, s.data, s.configA).stdout;
    assert.doesNotMatch(out, new RegExp(REPO_ITEM));
    assert.doesNotMatch(out, new RegExp(ORG_ITEM));
    assert.match(out, new RegExp(PERSON_ITEM));
  }
});

test('tenant items are absent in a config not bound to the tenant', () => {
  const s = seeded();
  const out = sessionStart(s.acmeApi, s.data, s.configB).stdout;
  assert.doesNotMatch(out, new RegExp(REPO_ITEM));
  assert.doesNotMatch(out, new RegExp(ORG_ITEM));
  assert.match(out, new RegExp(PERSON_ITEM));
});

test('an organisation item reaches sibling repositories of the same owner only', () => {
  const s = seeded();
  const sibling = sessionStart(s.acmeWeb, s.data, s.configA).stdout;
  assert.match(sibling, new RegExp(ORG_ITEM));
  assert.doesNotMatch(sibling, new RegExp(REPO_ITEM));
});

test('the other tenant file and the person file never hold a tenant item', () => {
  const s = seeded();
  assert.equal(remember(s.betaWeb, s.data, s.configB, 'Deploys need a second approver', '--scope', 'repository').status, 0);
  for (const file of [join(s.data, 'tenants', 'beta.sqlite'), join(s.data, 'person.sqlite')]) {
    const bytes = readFileSync(file);
    assert.equal(bytes.includes(REPO_ITEM), false, file);
    assert.equal(bytes.includes(ORG_ITEM), false, file);
  }
});

test('a remote matched by two tenants, or on another host, has no tenant', () => {
  const s = seeded();
  const cfgPath = join(s.data, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  // Adding an overlapping tenant changes the plan, so consent is given again.
  const r = run(['init', '--tenant', 'acme2=acme/api', '--bind', 'acme,beta,acme2', '--confirm'], {
    cwd: s.base, data: s.data, config: s.configA,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Object.keys(JSON.parse(readFileSync(cfgPath, 'utf8')).tenants).length > Object.keys(cfg.tenants).length);
  assert.doesNotMatch(sessionStart(s.acmeApi, s.data, s.configA).stdout, new RegExp(REPO_ITEM));

  const other = repo(s.base, 'acme/elsewhere', 'https://gitlab.example.com/acme/web.git');
  assert.doesNotMatch(sessionStart(other, s.data, s.configA).stdout, new RegExp(ORG_ITEM));
});

test('a configuration edited by hand, after consent, makes memory inert until confirmed again', () => {
  const s = seeded();
  const cfgPath = join(s.data, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.tenants.acme.push('other/*');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.equal(sessionStart(s.acmeApi, s.data, s.configA).stdout, '');
  const r = remember(s.acmeApi, s.data, s.configA, 'Another statement', '--scope', 'person');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /memory init/);
});

test('a git URL rewrite cannot turn another host into a tenant', () => {
  const s = seeded();
  const other = repo(s.base, 'elsewhere/web', 'https://gitlab.example.com/team/web.git');
  execFileSync('git', ['config', 'url.https://github.com/acme/.insteadOf', 'https://gitlab.example.com/team/'], { cwd: other });
  const out = sessionStart(other, s.data, s.configA).stdout;
  assert.doesNotMatch(out, new RegExp(ORG_ITEM));
  assert.match(out, new RegExp(PERSON_ITEM));
});
