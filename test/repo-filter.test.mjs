import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, remember, tools, storeBytes } from './helpers.mjs';

const API = 'Api ledger entries settle nightly';
const WEB = 'Web pages render on the server';
const ORG = 'Acme services expose a health endpoint';
const P_API = 'Zephyr habit of the first kind: keep diffs small';
const P_WEB = 'Zephyr habit of the second kind: name tests by behaviour';
const P_LOOSE = 'Zephyr habit of the third kind: prefer plain scripts';
const P_NULL = 'Zephyr habit of unknown origin: write the why in commits';
const BETA = 'Beta deploys need a second approver';

const db = (s, file, readOnly = true) => new DatabaseSync(join(s.data, file), { readOnly });
const rows = (s, file, sql = 'SELECT * FROM items ORDER BY created_at, id') => {
  const d = db(s, file);
  try {
    return d.prepare(sql).all();
  } finally {
    d.close();
  }
};
const originOf = (s, text, file) => rows(s, file, 'SELECT statement, origin_repository AS o FROM items').find((r) => r.statement === text)?.o;
const ok = (r) => assert.equal(r.status, 0, r.stderr);

/** Acme: items of two repositories, an organisation item and person items learned in three places (and one nowhere); beta: one item. */
function seeded() {
  const s = setup();
  ok(remember(s.acmeApi, s.data, s.configA, API));
  ok(remember(s.acmeWeb, s.data, s.configA, WEB));
  ok(remember(s.acmeApi, s.data, s.configA, ORG, '--scope', 'organisation'));
  ok(remember(s.acmeApi, s.data, s.configA, P_API, '--scope', 'person'));
  ok(remember(s.acmeWeb, s.data, s.configA, P_WEB, '--scope', 'person'));
  ok(remember(s.loose, s.data, s.configA, P_LOOSE, '--scope', 'person'));
  ok(remember(s.noRemote, s.data, s.configA, P_NULL, '--scope', 'global'));
  ok(remember(s.betaWeb, s.data, s.configB, BETA));
  return s;
}

const list = (s, cwd, ...args) => run(['list', ...args], { cwd, data: s.data, config: s.configA });
const has = (out, ...texts) => texts.every((t) => out.includes(t));
const hasNone = (out, ...texts) => texts.every((t) => !out.includes(t));

/** The beta store becomes bytes SQLite cannot open: a command that opened it fails, so one that succeeds never did. */
function poisonBeta(s) {
  writeFileSync(join(s.data, 'tenants', 'beta.sqlite'), 'this is not a database, and opening it is an error');
  for (const ext of ['-wal', '-shm']) assert.equal(existsSync(join(s.data, 'tenants', `beta.sqlite${ext}`)), false);
}

// --- origin recorded on every write path

test('remember records the repository it ran in, and null where there is none', () => {
  const s = seeded();
  assert.equal(originOf(s, API, 'tenants/acme.sqlite'), 'acme/api');
  assert.equal(originOf(s, WEB, 'tenants/acme.sqlite'), 'acme/web');
  assert.equal(originOf(s, ORG, 'tenants/acme.sqlite'), 'acme/api');
  assert.equal(originOf(s, P_API, 'person.sqlite'), 'acme/api');
  assert.equal(originOf(s, P_WEB, 'person.sqlite'), 'acme/web');
  assert.equal(originOf(s, P_LOOSE, 'person.sqlite'), 'loose/tool');
  assert.equal(originOf(s, P_NULL, 'person.sqlite'), null);
});

test('memory_propose records the repository for a repository and a person proposal', () => {
  const s = setup();
  const [repo, person] = tools(s.acmeApi, s.data, s.configA, [
    ['memory_propose', { statement: 'Releases are cut from main', scope: 'repository', type: 'convention', evidence: { source: 'agent-1' } }],
    ['memory_propose', { statement: 'Summaries should be short', scope: 'person', type: 'preference', evidence: { source: 'agent-1' } }],
  ]);
  assert.equal(repo.isError, false, repo.text);
  assert.equal(person.isError, false, person.text);
  assert.equal(originOf(s, 'Releases are cut from main', 'tenants/acme.sqlite'), 'acme/api');
  assert.equal(originOf(s, 'Summaries should be short', 'person.sqlite'), 'acme/api');
  const [none] = tools(s.noRemote, s.data, s.configA, [['memory_propose', { statement: 'Lint before pushing', scope: 'global', type: 'preference', evidence: { source: 'agent-1' } }]]);
  assert.equal(none.isError, false, none.text);
  assert.equal(originOf(s, 'Lint before pushing', 'person.sqlite'), null);
});

test('capture records the repository it captured in', () => {
  const s = setup();
  const path = join(s.data, 'config.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), capture: { model: 'fake' } }));
  const msg = (type, text) => JSON.stringify({ type, message: { content: [{ type: 'text', text }] } });
  const noise = Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `ok, looking at step ${i}; running the tests again`));
  const file = join(s.base, 't.jsonl');
  writeFileSync(file, [...noise, msg('assistant', 'LESSON: Retries in the ledger must be idempotent because the queue redelivers'), msg('user', 'thanks')].join('\n') + '\n');
  ok(run(['capture', '--foreground'], {
    cwd: s.acmeWeb, data: s.data, config: s.configA,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionEnd', transcript_path: file, cwd: s.acmeWeb }),
  }));
  const [item] = rows(s, 'tenants/acme.sqlite');
  assert.equal(item.scope_key, 'acme/web');
  assert.equal(item.origin_repository, 'acme/web');
});

test('import records the repository a statement names, and leaves a person statement unknown', () => {
  const s = setup();
  const folder = join(s.configA, 'projects', '-tmp-work', 'memory');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'MEMORY.md'), '- [Releases](release.md) - how releases are cut\n- Prefer short pull request descriptions\n');
  writeFileSync(join(folder, 'release.md'), '---\nname: release\ndescription: Releases of acme/api are cut from the main branch only\nmetadata:\n  type: project\n---\n\nDetail.\n');
  ok(run(['import'], { cwd: s.acmeApi, data: s.data, config: s.configA }));
  const tenant = rows(s, 'tenants/acme.sqlite');
  assert.equal(tenant.length, 1);
  assert.equal(tenant[0].origin_repository, 'acme/api');
  const person = rows(s, 'person.sqlite');
  assert.equal(person.length, 1);
  assert.equal(person[0].origin_repository, null);
});

// --- migration

test('schema 14 backfills repository items from their scope key and leaves the rest unknown', () => {
  const s = seeded();
  for (const file of ['tenants/acme.sqlite', 'person.sqlite']) {
    const d = db(s, file, false);
    d.exec('ALTER TABLE items DROP COLUMN origin_repository; PRAGMA user_version = 13;');
    d.close();
  }
  ok(list(s, s.acmeApi));
  assert.equal(originOf(s, API, 'tenants/acme.sqlite'), 'acme/api');
  assert.equal(originOf(s, WEB, 'tenants/acme.sqlite'), 'acme/web');
  assert.equal(originOf(s, ORG, 'tenants/acme.sqlite'), null);
  assert.equal(originOf(s, P_API, 'person.sqlite'), null);
  assert.equal(rows(s, 'person.sqlite', 'PRAGMA user_version')[0].user_version, 14);
});

// --- list and export filters

test('list without either option is unchanged', () => {
  const s = seeded();
  const r = list(s, s.acmeApi);
  ok(r);
  assert.ok(has(r.stdout, API, ORG, P_API, P_WEB, P_LOOSE, P_NULL), r.stdout);
  assert.ok(hasNone(r.stdout, WEB, BETA), r.stdout);
});

test('list --repo shows that repository, its organisation items and the person items learned in it', () => {
  const s = seeded();
  const web = list(s, s.acmeApi, '--repo', 'acme/web');
  ok(web);
  assert.ok(has(web.stdout, WEB, ORG, P_WEB), web.stdout);
  assert.ok(hasNone(web.stdout, API, P_API, P_LOOSE, P_NULL, BETA), web.stdout);
  const api = list(s, s.acmeWeb, '--repo', 'ACME/API');
  ok(api);
  assert.ok(has(api.stdout, API, ORG, P_API), api.stdout);
  assert.ok(hasNone(api.stdout, WEB, P_WEB, P_LOOSE, P_NULL), api.stdout);
});

test('list --all-repos shows every item of the bound tenant and the person file, and nothing of another tenant', () => {
  const s = seeded();
  const r = list(s, s.acmeApi, '--all-repos');
  ok(r);
  assert.ok(has(r.stdout, API, WEB, ORG, P_API, P_WEB, P_LOOSE, P_NULL), r.stdout);
  assert.ok(hasNone(r.stdout, BETA), r.stdout);
  const bare = list(s, s.noRemote, '--all-repos');
  ok(bare);
  assert.ok(has(bare.stdout, P_API, P_WEB, P_LOOSE, P_NULL), 'with no tenant here the person file is all there is');
  assert.ok(hasNone(bare.stdout, API, WEB, ORG, BETA), bare.stdout);
});

test('--repo and --all-repos exclude each other, and a malformed --repo is a usage error', () => {
  const s = seeded();
  for (const args of [['--repo', 'acme/web', '--all-repos'], ['--repo', 'acme'], ['--repo', 'acme/web/extra'], ['--repo', '../x/y'], ['--repo', '']]) {
    const r = list(s, s.acmeApi, ...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
  }
  const out = join(s.base, 'out');
  assert.equal(run(['export', '--markdown', out, '--repo', 'acme/web', '--all-repos'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 2);
  assert.equal(run(['export', '--markdown', out, '--repo', 'nope'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 2);
});

/** The statements an export folder holds. */
function exported(dir) {
  const out = [];
  for (const name of readdirSync(join(dir, 'items'))) {
    const text = readFileSync(join(dir, 'items', name), 'utf8');
    out.push(...[API, WEB, ORG, P_API, P_WEB, P_LOOSE, P_NULL, BETA].filter((t) => text.includes(t)));
  }
  return out.sort();
}

test('export --repo and --all-repos limit what is written, and the default is unchanged', () => {
  const s = seeded();
  const exportTo = (name, ...args) => {
    const dir = join(s.base, name);
    const r = run(['export', '--markdown', dir, ...args], { cwd: s.acmeApi, data: s.data, config: s.configA });
    ok(r);
    return { dir, r };
  };
  const plain = exportTo('plain');
  assert.deepEqual(exported(plain.dir), [API, WEB, ORG, P_API, P_WEB, P_LOOSE, P_NULL].sort());
  const all = exportTo('all', '--all-repos');
  assert.deepEqual(exported(all.dir), exported(plain.dir));
  const web = exportTo('web', '--repo', 'acme/web');
  assert.deepEqual(exported(web.dir), [WEB, ORG, P_WEB].sort());
  assert.match(web.r.stdout, /exported 3 items/);
});

// --- agents

const search = (s, cwd, args) => tools(cwd, s.data, s.configA, [['memory_search', { query: 'ledger pages render zephyr habit health endpoint', ...args }]])[0];

test('memory_search without repository is unchanged, and with repository searches that repository', () => {
  const s = seeded();
  const here = search(s, s.acmeApi, {});
  assert.equal(here.isError, false, here.text);
  assert.ok(has(here.text, API), here.text);
  assert.ok(hasNone(here.text, WEB, 'Paths are not matched'), here.text);

  const web = search(s, s.acmeApi, { repository: 'acme/web' });
  assert.equal(web.isError, false, web.text);
  assert.ok(has(web.text, WEB, P_WEB), web.text);
  assert.ok(hasNone(web.text, API, P_API, P_LOOSE, P_NULL, 'Paths are not matched'), 'no paths were given, so there is nothing to say about them');

  const same = search(s, s.acmeApi, { repository: 'acme/api', paths: ['src/ledger.ts'] });
  assert.ok(has(same.text, API) && hasNone(same.text, WEB, 'Paths are not matched'), same.text);
});

test('memory_search of another repository skips anchor-path matching and says so once', () => {
  const s = setup();
  ok(remember(s.acmeApi, s.data, s.configA, 'Consume holds the ledger lock', '--anchor', 'src/ledger.ts:1-3'));
  ok(remember(s.acmeWeb, s.data, s.configA, 'Rendering holds the ledger cache'));
  const r = search(s, s.acmeApi, { repository: 'acme/web', paths: ['src/ledger.ts'] });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text.split('\n').filter((l) => l.startsWith('Paths are not matched')).length, 1, r.text);
  assert.ok(has(r.text, 'Rendering holds the ledger cache') && hasNone(r.text, 'Consume holds'), r.text);
  assert.doesNotMatch(r.text, /anchor \d/);
});

// --- the tenant wall

const WALL = /not a repository of the tenant bound here|no tenant is bound here/;

test('list --repo and export --repo refuse a repository of another tenant and open nothing of it', () => {
  const s = seeded();
  poisonBeta(s);
  // The control: a command that does open the beta store fails on it.
  assert.notEqual(list(s, s.betaWeb).status, 0);
  const r = list(s, s.acmeApi, '--repo', 'beta/web');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, WALL);
  assert.equal(r.stdout, '');
  assert.doesNotMatch(r.stderr + r.stdout, /Beta deploys|tenant beta|database/);
  const out = join(s.base, 'out');
  const e = run(['export', '--markdown', out, '--repo', 'beta/web'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(e.status, 1, e.stderr);
  assert.match(e.stderr, WALL);
  assert.equal(existsSync(out), false);
});

test('a repository that matches no tenant is refused', () => {
  const s = seeded();
  for (const repo of ['loose/tool', 'nobody/nothing']) {
    const r = list(s, s.acmeApi, '--repo', repo);
    assert.equal(r.status, 1, `${repo}: ${r.stderr}`);
    assert.match(r.stderr, WALL);
    assert.equal(r.stdout, '');
  }
});

test('a repository that matches two tenants is not reachable from either', () => {
  const s = seeded();
  ok(run(['init', '--tenant', 'acme2=acme/web', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }));
  const r = list(s, s.acmeApi, '--repo', 'acme/web');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, WALL);
  assert.equal(r.stdout, '');
  assert.doesNotMatch(r.stderr, /acme2/);
});

test('with no tenant here, --repo is refused even for a repository the config is bound to', () => {
  const s = seeded();
  for (const cwd of [s.loose, s.noRemote]) {
    const r = list(s, cwd, '--repo', 'acme/api');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /no tenant is bound here/);
    assert.equal(r.stdout, '');
    assert.ok(hasNone(r.stderr, API, WEB));
  }
  const out = join(s.base, 'out');
  assert.equal(run(['export', '--markdown', out, '--repo', 'acme/api'], { cwd: s.loose, data: s.data, config: s.configA }).status, 1);
});

test('memory_search refuses another tenant, no tenant match and no tenant here, and reads nothing of them', () => {
  const s = seeded();
  poisonBeta(s);
  for (const [cwd, repository] of [[s.acmeApi, 'beta/web'], [s.acmeApi, 'loose/tool'], [s.loose, 'acme/api'], [s.noRemote, 'acme/web']]) {
    const r = search(s, cwd, { repository });
    assert.equal(r.isError, true, `${repository}: ${r.text}`);
    assert.match(r.text, WALL);
    assert.ok(hasNone(r.text, 'Beta deploys', 'tenant beta', 'database'), r.text);
  }
  const malformed = search(s, s.acmeApi, { repository: 'not-a-repo' });
  assert.equal(malformed.isError, true);
});

test('--all-repos never opens another tenant\'s file', () => {
  const s = seeded();
  poisonBeta(s);
  const r = list(s, s.acmeApi, '--all-repos');
  ok(r);
  assert.ok(has(r.stdout, API, WEB, P_API), r.stdout);
  const out = join(s.base, 'out');
  ok(run(['export', '--markdown', out, '--all-repos'], { cwd: s.acmeApi, data: s.data, config: s.configA }));
  assert.equal(exported(out).includes(BETA), false);
});

// --- purge

test('purge --repo previews and deletes the person and global items learned in that repository, and no others', () => {
  const s = seeded();
  const purge = (...args) => run(['purge', '--repo', 'acme/api', ...args], { cwd: s.base, data: s.data, config: s.configA });
  const preview = purge();
  ok(preview);
  const shown = JSON.parse(preview.stdout);
  assert.equal(shown.files['person.sqlite'].items, 1, 'the preview names the person file and its one item');
  assert.equal(shown.files['tenants/acme.sqlite'].items, 1);
  assert.equal(shown.items, 2);
  assert.ok(storeBytes(s.data).includes(P_API), 'nothing was deleted by a preview');

  ok(purge('--confirm'));
  const left = rows(s, 'person.sqlite', 'SELECT statement FROM items').map((r) => r.statement).sort();
  assert.deepEqual(left, [P_LOOSE, P_NULL, P_WEB].sort());
  const bytes = storeBytes(s.data);
  assert.equal(bytes.includes(P_API), false, 'no recoverable bytes of the purged person item');
  assert.equal(bytes.includes(API), false);
  assert.ok(bytes.includes(P_WEB) && bytes.includes(WEB));
});

// --- ranking

const whyOf = (text, statement) => {
  const line = text.split('\n').find((l) => l.includes(statement));
  assert.ok(line, `${statement} is in: ${text}`);
  return line.slice(line.indexOf('· why: '));
};

test('a person item learned in the current repository ranks with a bonus its why names; other and unknown origins get none', () => {
  const s = seeded();
  const r = search(s, s.acmeApi, {});
  assert.equal(r.isError, false, r.text);
  assert.match(whyOf(r.text, P_API), /person 1, this repository 0\.5,/);
  for (const other of [P_WEB, P_LOOSE, P_NULL]) assert.doesNotMatch(whyOf(r.text, other), /this repository/, other);
  // The same item read from the repository it was not learned in gets nothing.
  const web = search(s, s.acmeWeb, {});
  assert.doesNotMatch(whyOf(web.text, P_API), /this repository/);
  assert.match(whyOf(web.text, P_WEB), /this repository 0\.5/);
});
