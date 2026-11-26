import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, run, runAsync, sessionStart } from './helpers.mjs';

// #80: person-scope corrections from sessions outside every tenant, and the model-based extraction pass.
const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-provider.mjs');

const row = (text) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const write = (s, name, ...turns) => {
  const file = join(s.base, name);
  writeFileSync(file, turns.map(row).join('\n') + '\n');
  return file;
};
const optIn = (s, on = 'on') => assert.equal(run(['init', '--transcripts', on, '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
const end = (s, file, cwd, session = 'sess-1') =>
  run(['transcript'], { cwd, data: s.data, config: s.configA, input: JSON.stringify({ session_id: session, hook_event_name: 'SessionEnd', transcript_path: file, cwd }) });
const query = (file, text, ...args) => {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file);
  try {
    return db.prepare(text).all(...args).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const person = (s) => join(s.data, 'person.sqlite');
const acme = (s) => join(s.data, 'tenants/acme.sqlite');
const corrections = (file) => query(file, "SELECT id, scope, scope_key, statement, status, origin_trust FROM items WHERE statement LIKE 'Owner correction:%' ORDER BY statement");
const configure = (s, model) => {
  const file = join(s.data, 'config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), transcriptModel: model }));
};

// ---- Part 1: person-scope corrections ----------------------------------------------------------------------------------

test('#80 1.1 a session outside every tenant with one owner correction gives one person-scope proposal quoting it verbatim at the next sweep', () => {
  const s = setup();
  optIn(s);
  const file = write(s, 'outside.jsonl', 'Tidy up the notes folder', 'No, always ask me before deleting anything.');
  assert.equal(end(s, file, s.loose).status, 0);
  assert.deepEqual(query(person(s), "SELECT kind, path FROM transcripts").map((r) => [r.kind, r.path]), [['path', file]]);
  assert.equal(corrections(person(s)).length, 0, 'not before the sweep');
  const r = run(['sweep'], { cwd: s.loose, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  const p = corrections(person(s));
  assert.deepEqual(p.map((x) => [x.scope, x.statement, x.status, x.origin_trust]), [['person', 'Owner correction: "No, always ask me before deleting anything."', 'proposed', 'owner']]);
  assert.equal(query(acme(s), 'SELECT count(*) AS n FROM transcripts')[0]?.n ?? 0, 0, 'no tenant file is touched');
});

test('#80 1.2 the same correction naming a repository path makes no person-scope proposal', () => {
  const s = setup();
  optIn(s);
  const file = write(s, 'path.jsonl', 'Tidy up the notes folder', 'No, always ask me before deleting anything in src/ledger.ts here.', 'No, always ask me before you touch loose/tool at all.');
  end(s, file, s.loose);
  assert.equal(run(['sweep'], { cwd: s.loose, data: s.data, config: s.configA }).status, 0);
  assert.equal(corrections(person(s)).length, 0);
  assert.equal(query(person(s), 'SELECT outcome FROM transcripts')[0].outcome, 'read', 'control: it was read');
});

test('#80 1.3 with the opt-in off a session outside every tenant records nothing', () => {
  const s = setup();
  const file = write(s, 'off.jsonl', 'Tidy up the notes folder', 'No, always ask me before deleting anything.');
  assert.equal(end(s, file, s.loose).status, 0);
  run(['sweep'], { cwd: s.loose, data: s.data, config: s.configA });
  assert.equal(query(person(s), 'SELECT count(*) AS n FROM transcripts')[0]?.n ?? 0, 0);
  assert.equal(corrections(person(s)).length, 0);
});

// ---- Part 2: the model-based extraction pass --------------------------------------------------------------------------

/** A stand-in for a local Ollama: answers /api/generate with `reply`, and keeps each request body. */
async function ollama(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ path: req.url, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'x', response: JSON.stringify(reply), done: true }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

const NO_CUE = 'Keep the changelog entries in past tense from now on.';
const recorded = (s) => {
  optIn(s);
  end(s, write(s, 'nocue.jsonl', 'Write the release notes', `Looks fine. ${NO_CUE}`), s.acmeApi);
  assert.equal(sessionStart(s.acmeApi, s.data, s.configA).status, 0);
  assert.equal(corrections(acme(s)).length, 0, 'the rule pass finds nothing without a cue');
};

test('#80 2.1 the pass configured and a correction with no rule cue: the batch makes one proposal quoting it verbatim, through a local Ollama', async () => {
  const s = setup();
  recorded(s);
  const server = await ollama({ corrections: [{ line: 2, quote: NO_CUE }] });
  try {
    configure(s, { url: server.url });
    const r = await runAsync(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(r.status, 0, r.stderr);
    const p = corrections(acme(s));
    assert.deepEqual(p.map((x) => [x.statement, x.status, x.scope_key]), [[`Owner correction: "${NO_CUE}"`, 'proposed', 'acme/api']]);
    assert.equal(server.seen.length, 1);
    assert.equal(server.seen[0].path, '/api/generate');
    assert.equal(server.seen[0].body.model, 'inkling-2-mini', 'the documented default model');
    assert.match(server.seen[0].body.prompt, /past tense/);
    assert.doesNotMatch(server.seen[0].body.prompt, /Write the release notes/, 'the task turn is not a correction');
    const again = await runAsync(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(server.seen.length, 1, 'a transcript is read by the model once');
  } finally {
    server.close();
  }
});

test('#80 2.1b the pass is off by default and needs the transcripts opt-in', () => {
  const s = setup();
  recorded(s);
  const r = run(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /transcriptModel/);
  optIn(s, 'off');
  configure(s, { url: 'http://127.0.0.1:9', command: [process.execPath, FAKE, join(s.base, 'f.json'), join(s.base, 'log')] });
  assert.notEqual(run(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.equal(existsSync(join(s.base, 'log')), false);
});

test('#80 2.2 a model reply that paraphrases is dropped', async () => {
  const s = setup();
  recorded(s);
  const server = await ollama({ corrections: [{ line: 2, quote: 'Keep changelog entries in the past tense from now on.' }, { line: 1, quote: 'Write the release notes' }] });
  try {
    configure(s, { url: server.url });
    const r = await runAsync(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(server.seen.length, 1);
    assert.equal(corrections(acme(s)).length, 0);
  } finally {
    server.close();
  }
});

test('#80 2.3 a client tenant and a remote model: the pass does not run for that tenant, and says so', () => {
  const s = setup();
  recorded(s);
  const fixture = join(s.base, 'fake.json');
  writeFileSync(fixture, JSON.stringify({ mode: 'crash' }));
  const log = join(s.base, 'calls.log');
  configure(s, { url: 'https://models.example.com', command: [process.execPath, FAKE, fixture, log] });
  const r = run(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not run for tenant acme/);
  assert.equal(existsSync(log), false, 'the model was never called');
  assert.equal(query(acme(s), 'SELECT outcome FROM transcripts')[0].outcome, 'read');
});

// #101: the model pass and the semantic leg share one check for a model on this machine.
for (const [url, local] of [['http://localhost:11434', true], ['http://[::1]:11434', true], ['http://127.0.0.1:11434', true], ['http://192.0.2.10:11434', false], ['http://models.lan:11434', false]]) {
  test(`#101 the model pass treats ${url} as ${local ? 'on' : 'not on'} this machine, as the semantic leg does`, () => {
    const s = setup();
    recorded(s);
    const fixture = join(s.base, 'fake.json');
    writeFileSync(fixture, JSON.stringify({ mode: 'crash' }));
    const log = join(s.base, 'calls.log');
    configure(s, { url, command: [process.execPath, FAKE, fixture, log] });
    const r = run(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.equal(/not run for tenant acme/.test(r.stderr), !local, r.stderr);
    assert.equal(existsSync(log), local, local ? 'the model was asked' : 'the model was never called');
  });
}

const snapshot = (s) => JSON.stringify([query(acme(s), 'SELECT * FROM items ORDER BY id'), query(acme(s), 'SELECT * FROM transcripts ORDER BY id'), query(acme(s), 'SELECT * FROM audit_events ORDER BY rowid')]);
for (const mode of ['hang', 'flood', 'crash']) {
  test(`#80 2.4 a model that ${mode === 'hang' ? 'never answers and ignores SIGTERM' : mode === 'flood' ? 'floods output' : 'fails'}: the batch stops at its limits after one call and memory is unchanged`, () => {
    const s = setup();
    recorded(s);
    end(s, write(s, 'second.jsonl', 'Write the release notes', NO_CUE), s.acmeApi, 'sess-2');
    sessionStart(s.acmeApi, s.data, s.configA);
    const fixture = join(s.base, 'fake.json');
    writeFileSync(fixture, JSON.stringify({ mode }));
    const log = join(s.base, 'calls.log');
    configure(s, { command: [process.execPath, FAKE, fixture, log] });
    const before = snapshot(s);
    const started = Date.now();
    const r = run(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA, env: { MEMORY_PROGRAM_TIMEOUT_MS: '500' } });
    assert.ok(Date.now() - started < 20_000, 'stopped at the limit');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /model failed/);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'no second call after the failure');
    assert.equal(existsSync(`${log}.survived`), false, 'the model outlived the kill');
    assert.equal(snapshot(s), before);
  });
}

test('#80 config: transcriptModel is checked', () => {
  const s = setup();
  for (const bad of [{ url: 'not a url' }, { model: '' }, { command: ['relative/prog'] }, { url: 'ftp://127.0.0.1' }, 'x']) {
    configure(s, bad);
    const r = run(['corrections'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /transcriptModel/);
  }
});
