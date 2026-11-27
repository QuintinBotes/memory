import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assemble, remember, repo, run, sandbox, sessionStart } from './helpers.mjs';

// #139: tenants on hosts other than github.com, failing closed for every host no pattern names.
const ITEM = 'Releases are cut from the main branch only';
const OTHER = 'Deploys need a second approver';

function hosts(...patterns) {
  const s = sandbox();
  const r = run(['init', '--tenant', `acme=${patterns.join(',')}`, '--bind', 'acme', '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  return {
    ...s,
    // An SSH remote; assembled so the identity guard does not read it as an email.
    gitlab: repo(s.base, 'gitlab/api', assemble('git', '@gitlab.com:acme/api.git')),
    nested: repo(s.base, 'gitlab/nested', 'https://gitlab.com/acme/platform/api.git'),
    github: repo(s.base, 'github/api', 'https://github.com/acme/api.git'),
  };
}
const list = (s, cwd, ...flags) => run(['list', ...flags], { cwd, data: s.data, config: s.configA });

test('SC1: a GitLab pattern lets a GitLab clone remember a repository item, and session start prints it', () => {
  const s = hosts('gitlab.com/acme/*');
  const r = remember(s.gitlab, s.data, s.configA, ITEM, '--scope', 'repository', '--type', 'convention');
  assert.equal(r.status, 0, r.stderr);
  assert.match(sessionStart(s.gitlab, s.data, s.configA).stdout, new RegExp(ITEM));
  assert.match(list(s, s.gitlab, '--repo', 'gitlab.com/acme/api').stdout, new RegExp(ITEM));
});

test('SC2: a nested group resolves to the same tenant, at its full path', () => {
  const s = hosts('gitlab.com/acme/*');
  assert.equal(remember(s.nested, s.data, s.configA, ITEM, '--scope', 'repository').status, 0);
  assert.match(list(s, s.gitlab, '--repo', 'gitlab.com/acme/platform/api').stdout, new RegExp(ITEM));
  assert.doesNotMatch(list(s, s.gitlab).stdout, new RegExp(ITEM));
});

test('SC3: with only the GitLab pattern, a github.com clone of acme/api matches no tenant', () => {
  const s = hosts('gitlab.com/acme/*');
  assert.equal(remember(s.gitlab, s.data, s.configA, ITEM, '--scope', 'repository').status, 0);
  assert.equal(remember(s.gitlab, s.data, s.configA, OTHER, '--scope', 'organisation').status, 0);
  const out = sessionStart(s.github, s.data, s.configA).stdout;
  assert.doesNotMatch(out, new RegExp(ITEM));
  assert.doesNotMatch(out, new RegExp(OTHER));
  const r = remember(s.github, s.data, s.configA, 'Builds use npm ci', '--scope', 'repository');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /acme\/api matches no tenant/);
  assert.match(list(s, s.github).stderr, /the person file only: acme\/api matches no tenant/);
});

test('SC4: acme/api on github.com and on gitlab.com are never the same repository or organisation', () => {
  const s = hosts('acme/*', 'gitlab.com/acme/*');
  assert.equal(remember(s.gitlab, s.data, s.configA, ITEM, '--scope', 'repository').status, 0);
  assert.equal(remember(s.github, s.data, s.configA, OTHER, '--scope', 'repository').status, 0);
  const org = 'Every service exposes a health endpoint';
  assert.equal(remember(s.gitlab, s.data, s.configA, org, '--scope', 'organisation').status, 0);
  const onGithub = list(s, s.gitlab, '--repo', 'acme/api').stdout;
  assert.match(onGithub, new RegExp(OTHER));
  assert.doesNotMatch(onGithub, new RegExp(ITEM));
  assert.doesNotMatch(onGithub, new RegExp(org));
  const onGitlab = list(s, s.github, '--repo', 'gitlab.com/acme/api').stdout;
  assert.match(onGitlab, new RegExp(ITEM));
  assert.match(onGitlab, new RegExp(org));
  assert.doesNotMatch(onGitlab, new RegExp(OTHER));
  assert.doesNotMatch(sessionStart(s.github, s.data, s.configA).stdout, new RegExp(org));
  // github.com/ spelled out is the same key as without it.
  assert.match(list(s, s.gitlab, '--repo', 'github.com/acme/api').stdout, new RegExp(OTHER));
  const purged = run(['purge', '--repo', 'gitlab.com/acme/api', '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(purged.status, 0, purged.stderr);
  assert.doesNotMatch(list(s, s.gitlab).stdout, new RegExp(ITEM));
  assert.match(list(s, s.github).stdout, new RegExp(OTHER));
});

test('SC5: a host no pattern names matches no tenant, with the reason, and insteadOf does not change the host', () => {
  const s = hosts('gitlab.com/acme/*');
  assert.equal(remember(s.gitlab, s.data, s.configA, ITEM, '--scope', 'repository').status, 0);
  const elsewhere = repo(s.base, 'bitbucket/api', 'https://bitbucket.org/acme/api.git');
  assert.match(list(s, elsewhere).stderr, /no tenant pattern names the host bitbucket\.org/);
  const rewritten = repo(s.base, 'example/api', 'https://git.example.com/acme/api.git');
  execFileSync('git', ['config', 'url.https://gitlab.com/acme/.insteadOf', 'https://git.example.com/acme/'], { cwd: rewritten });
  assert.match(list(s, rewritten).stderr, /no tenant pattern names the host git\.example\.com/);
  assert.doesNotMatch(sessionStart(rewritten, s.data, s.configA).stdout, new RegExp(ITEM));
  execFileSync('git', ['config', `url.${assemble('git', '@gitlab.com:acme/')}.insteadOf`, 'https://github.com/acme/'], { cwd: s.github });
  assert.doesNotMatch(sessionStart(s.github, s.data, s.configA).stdout, new RegExp(ITEM));
  // A port, a host without a dot or a path that climbs out is no repository at all.
  for (const [i, remote] of ['https://gitlab.com:8443/acme/api.git', 'https://gitlab/acme/api.git', 'https://gitlab.com/acme/../api.git'].entries()) {
    const odd = repo(s.base, `odd/${i}`, remote);
    assert.doesNotMatch(sessionStart(odd, s.data, s.configA).stdout, new RegExp(ITEM), remote);
  }
});

test('patterns: a host holds a dot and takes groups below it; the plan lists the hosts, and a new one needs consent', () => {
  const s = hosts('gitlab.com/acme/*');
  for (const bad of ['gitlab.com/*', 'acme/platform/*', 'gitlab.com:22/acme/*']) {
    const r = run(['init', '--tenant', `x=${bad}`], { cwd: s.base, data: s.data, config: s.configA });
    assert.equal(r.status, 2, bad);
  }
  const plan = run(['init', '--tenant', 'more=git.example.com/platform/tools/*'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).hosts, ['git.example.com', 'gitlab.com']);
  const cfg = JSON.parse(readFileSync(join(s.data, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.tenants, { acme: ['gitlab.com/acme/*'] }, 'a plan without --confirm saves nothing');
});

test('SC6: a GitHub-only consent saved by 0.9.2 still holds; the plan hash covers no hosts', () => {
  const s = sandbox();
  // The configs key is fixed so the hash is too; the hash is what origin/main's dist (0.9.2) saved for this config.
  const configDir = '/memory-hash-fixture/claude';
  mkdirSync(s.data, { recursive: true });
  writeFileSync(join(s.data, 'config.json'), JSON.stringify({
    tenants: { acme: ['acme/*'], beta: ['beta/*', 'beta2/api'] },
    configs: { [configDir]: ['acme', 'beta'] },
    optIns: { transcripts: false, failingCommands: false },
    consent: { planHash: '55a85f45ce31e0d7449166e720f1a29027c5fbdbeb922148195e72a1cf675f3a', grantedAt: '2026-11-27T22:58:52.934Z', version: 13 },
  }));
  const github = repo(s.base, 'acme/api', 'https://github.com/acme/api.git');
  const r = remember(github, s.data, configDir, ITEM, '--scope', 'repository');
  assert.equal(r.status, 0, r.stderr);
  assert.match(sessionStart(github, s.data, configDir).stdout, new RegExp(ITEM));
});

test('SC7: memory ci off github.com says why in one line, runs no gh and opens no store', () => {
  const s = hosts('gitlab.com/acme/*');
  const dir = join(s.base, 'gh');
  mkdirSync(dir);
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\ntouch "${dir}/called"\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  const r = run(['ci'], { cwd: s.gitlab, data: s.data, config: s.configA, path: `${dir}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'nothing captured: memory ci reads GitHub Actions through gh, which is not available on gitlab.com\n');
  assert.equal(existsSync(join(dir, 'called')), false);
  assert.equal(existsSync(join(s.data, 'tenants', 'acme.sqlite')), false);
});
