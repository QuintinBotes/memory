import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setup, remember, run, runAsync, storeBytes } from './helpers.mjs';

// #82: purge --repo deletes only that repository's episodes; those of unknown origin stay until --tenant.
const ERROR = (word) => `node:internal/modules/esm/resolve:873\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '${word}' imported from /work/a/scripts/build.mjs\nNode.js v22.13.0\n`;
const file = (s) => join(s.data, 'tenants/acme.sqlite');
const sql = (s, text, ...args) => {
  const db = new DatabaseSync(file(s));
  try {
    return db.prepare(text).all(...args).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const failed = (s, cwd, session, command, word) =>
  runAsync(['failure-recall'], { cwd, data: s.data, config: s.configA, input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd, hook_event_name: 'PostToolUseFailure', error: ERROR(word), is_interrupt: false }) });
const purge = (s, ...args) => run(['purge', ...args], { cwd: s.base, data: s.data, config: s.configA });

async function seeded() {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Builds run from the repository root', '--scope', 'repository').status, 0);
  assert.equal(run(['init', '--failing-commands', 'on', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
  assert.equal((await failed(s, s.acmeApi, 'sa', 'npm run build', 'apipackagezq')).status, 0);
  assert.equal((await failed(s, s.acmeWeb, 'sw', 'npm run build', 'webpackagezq')).status, 0);
  return s;
}
const repos = (s) => sql(s, 'SELECT repository FROM episodes ORDER BY repository').map((r) => r.repository);

test('#82 sc1: each episode records its repository, and purge --repo deletes only that repository, leaving no bytes', async () => {
  const s = await seeded();
  assert.deepEqual(repos(s), ['acme/api', 'acme/web']);
  const preview = JSON.parse(purge(s, '--repo', 'acme/api').stdout);
  assert.deepEqual(preview.episodesByRepository, { 'acme/api': 1, 'acme/web': 1 });
  assert.equal(preview.episodes, 1);
  assert.equal(sql(s, 'SELECT count(*) AS n FROM episodes')[0].n, 2, 'a preview deletes nothing');
  const r = purge(s, '--repo', 'acme/api', '--confirm');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(repos(s), ['acme/web']);
  assert.equal(storeBytes(s.data).includes('apipackagezq'), false);
  assert.equal(storeBytes(s.data).includes('webpackagezq'), true, 'control: the other repository is intact');
});

test('#82 sc2: episodes of unknown origin survive purge --repo, and the preview names them with the --tenant command', async () => {
  const s = await seeded();
  const db = new DatabaseSync(file(s));
  db.exec("UPDATE episodes SET repository = NULL WHERE session = 'sw'");
  db.close();
  const preview = JSON.parse(purge(s, '--repo', 'acme/api').stdout);
  assert.equal(preview.episodesNotAttributable, 1);
  assert.equal(preview.episodes, 1);
  assert.match(preview.notAttributable.join('\n'), /purge --tenant acme\b/);
  assert.equal(purge(s, '--repo', 'acme/api', '--confirm').status, 0);
  assert.deepEqual(repos(s), [null]);
});

test('#82 sc3: purge --tenant deletes every episode in the tenant, attributed or not', async () => {
  const s = await seeded();
  const db = new DatabaseSync(file(s));
  db.exec("UPDATE episodes SET repository = NULL WHERE session = 'sw'");
  db.close();
  const r = purge(s, '--tenant', 'acme', '--confirm');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sql(s, 'SELECT count(*) AS n FROM episodes')[0].n, 0);
  assert.equal(storeBytes(s.data).includes('webpackagezq'), false);
});

test('#82 migration: v17 adds the column to a v16 store and its old episodes stay unknown', async () => {
  const s = await seeded();
  const db = new DatabaseSync(file(s));
  // The v16 table: no repository column, and the unique key without it.
  db.exec(`CREATE TABLE old (id TEXT PRIMARY KEY, session TEXT NOT NULL, command_key TEXT NOT NULL, command TEXT NOT NULL, fingerprint TEXT NOT NULL, signature TEXT NOT NULL, head TEXT NOT NULL, at TEXT NOT NULL, repaired_at TEXT, UNIQUE (session, command_key, fingerprint));
    INSERT INTO old SELECT id, session, command_key, command, fingerprint, signature, head, at, repaired_at FROM episodes;
    DROP TABLE episodes; ALTER TABLE old RENAME TO episodes; CREATE INDEX idx_episodes_open ON episodes (session, command_key); PRAGMA user_version = 16;`);
  db.close();
  assert.equal(purge(s, '--repo', 'acme/api').status, 0);
  assert.deepEqual(repos(s), [null, null]);
  assert.equal(sql(s, 'PRAGMA user_version')[0].user_version, 17);
});

test('#82 review: one session, command and fingerprint failing in two repositories is two episodes, and purging one keeps the other', async () => {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Builds run from the repository root', '--scope', 'repository').status, 0);
  assert.equal(run(['init', '--failing-commands', 'on', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
  assert.equal((await failed(s, s.acmeApi, 'same', 'npm run build', 'samepackagezq')).status, 0);
  assert.equal((await failed(s, s.acmeWeb, 'same', 'npm run build', 'samepackagezq')).status, 0);
  assert.deepEqual(repos(s), ['acme/api', 'acme/web']);
  assert.equal(purge(s, '--repo', 'acme/api', '--confirm').status, 0);
  assert.deepEqual(repos(s), ['acme/web']);
});
