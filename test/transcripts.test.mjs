import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { build } from 'esbuild';
import { setup as sandboxed, remember, run, sessionStart, assemble, storeBytes } from './helpers.mjs';

// Slice 17 (#12): corrections in transcripts become quoted proposals, opt-in.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (s, name, to = `${name}.jsonl`) => {
  const file = join(s.base, to);
  copyFileSync(join(here, 'fixtures/transcripts', `${name}.jsonl`), file);
  return file;
};
const setup = () => {
  const s = sandboxed();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Builds run from the repository root', '--scope', 'repository', '--type', 'convention').status, 0);
  return s;
};
const optIn = (s, on = 'on') => assert.equal(run(['init', '--transcripts', on, '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
const sql = (s, text, ...args) => {
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  try {
    return db.prepare(text).all(...args).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const end = (s, file, session = 'sess-1', cwd = s.acmeApi, event = 'SessionEnd') =>
  run(['transcript'], { cwd, data: s.data, config: s.configA, input: JSON.stringify({ session_id: session, hook_event_name: event, transcript_path: file, cwd }) });
const proposals = (s) => sql(s, "SELECT id, status, statement, origin_trust, scope_key FROM items WHERE statement LIKE 'Owner correction:%'");
const records = (s) => sql(s, 'SELECT kind, path, outcome, processed_at FROM transcripts ORDER BY at');

test('US1.1 SessionEnd records only the transcript path: the file is not read, no item is made', () => {
  const s = setup();
  optIn(s);
  const missing = join(s.base, 'never-written.jsonl'); // a hook that read the file would fail on it
  const r = end(s, missing);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(records(s).map((x) => [x.kind, x.path, x.processed_at]), [['path', missing, null]]);
  assert.equal(proposals(s).length, 0);
  assert.equal(readdirSync(s.base).includes('never-written.jsonl'), false);
});

test('US1.2 the next session start turns the owner correction into one proposal quoting it verbatim, and nothing else in the transcript', () => {
  const s = setup();
  optIn(s);
  assert.equal(end(s, fixture(s, 'correction')).status, 0);
  assert.equal(proposals(s).length, 0, 'not before the next session');
  assert.equal(sessionStart(s.acmeApi, s.data, s.configA).status, 0);
  const p = proposals(s);
  assert.equal(p.length, 1, JSON.stringify(p));
  assert.equal(p[0].statement, 'Owner correction: "No, use the other branch for the release."');
  assert.equal(p[0].status, 'proposed');
  assert.equal(p[0].origin_trust, 'owner');
  assert.equal(p[0].scope_key, 'acme/api');
  const [e] = sql(s, 'SELECT source_ref, author_role FROM evidence WHERE item_id = ?', p[0].id);
  assert.match(e.source_ref, /^transcript:sess-1:L7:correction\.jsonl$/);
  assert.equal(e.author_role, 'owner');
  assert.equal(records(s)[0].outcome, 'read');
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(proposals(s).length, 1, 'a record is read once');
});

test('US1.3 a clean transcript gives no proposal, including agent text with correction words and tool output', () => {
  const s = setup();
  optIn(s);
  end(s, fixture(s, 'clean'));
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(proposals(s).length, 0);
  assert.equal(records(s)[0].outcome, 'read');
});

test('US1.4 with the opt-in off nothing is recorded', () => {
  const s = setup();
  assert.equal(end(s, fixture(s, 'correction')).status, 0);
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 0);
  optIn(s, 'on');
  optIn(s, 'off');
  end(s, fixture(s, 'correction'));
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 0);
});

test('FR-001 the opt-in is its own consent category: under plan version 9 nothing is recorded until the owner agrees again', () => {
  const s = setup();
  optIn(s);
  const plan = JSON.parse(run(['init'], { cwd: s.base, data: s.data, config: s.configA }).stdout);
  assert.equal(plan.version, 14);
  assert.equal(plan.optIns.transcripts, true);
  assert.ok(plan.dataCategories.some((t) => /transcript/.test(t) && /30 days/.test(t) && /verbatim/.test(t)));
  const file = join(s.data, 'config.json');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  c.consent.version = 9;
  writeFileSync(file, JSON.stringify(c));
  end(s, fixture(s, 'correction'));
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 0, 'not covered');
  assert.equal(run(['init', '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
  end(s, fixture(s, 'correction'));
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 1, 'control: covered after agreeing');
});

test('a transcript deleted before processing is skipped and counted, and the daily sweep also finds corrections', () => {
  const s = setup();
  optIn(s);
  const gone = fixture(s, 'correction', 'gone.jsonl');
  end(s, gone, 'sess-gone');
  const kept = fixture(s, 'correction', 'kept.jsonl');
  end(s, kept, 'sess-kept');
  rmSync(gone);
  const r = run(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(records(s).map((x) => x.outcome).sort(), ['missing', 'read']);
  assert.equal(proposals(s).length, 1);
  const [a] = sql(s, "SELECT metadata_json FROM audit_events WHERE action = 'transcripts_processed'");
  assert.deepEqual({ read: 1, missing: 1 }, { read: JSON.parse(a.metadata_json).read, missing: JSON.parse(a.metadata_json).missing });
});

test('records older than 30 days are deleted unread, and purge removes records and episodes', () => {
  const s = setup();
  optIn(s);
  end(s, fixture(s, 'correction'));
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  db.prepare("UPDATE transcripts SET at = '2020-01-01T00:00:00.000Z'").run();
  db.close();
  run(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(records(s).length, 0);
  assert.equal(proposals(s).length, 0, 'expired before it was read');
  end(s, fixture(s, 'correction'));
  assert.equal(run(['purge', '--tenant', 'acme', '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 0);
});

test('a session outside every tenant records in the person file only (#80); a record is read only into the tenant it was recorded for', () => {
  const s = setup();
  optIn(s);
  assert.equal(end(s, fixture(s, 'correction'), 'sess-1', s.loose).status, 0);
  assert.equal(end(s, fixture(s, 'correction'), 'sess-2', s.noRemote).status, 0);
  const person = new DatabaseSync(join(s.data, 'person.sqlite'));
  assert.deepEqual(person.prepare('SELECT repository FROM transcripts ORDER BY session').all().map((r) => r.repository), ['loose/tool', '']);
  person.close();
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 0);
  // Recorded for acme, then a session of another tenant starts: acme's record stays unread.
  end(s, fixture(s, 'correction'), 'sess-acme');
  remember(s.betaWeb, s.data, s.configA, 'Beta builds run from the root', '--scope', 'repository', '--type', 'convention');
  sessionStart(s.betaWeb, s.data, s.configA);
  assert.equal(proposals(s).length, 0);
  assert.equal(records(s)[0].processed_at, null);
  const beta = new DatabaseSync(join(s.data, 'tenants/beta.sqlite'));
  assert.equal(beta.prepare('SELECT count(*) AS n FROM transcripts').get().n, 0);
  assert.equal(beta.prepare("SELECT count(*) AS n FROM items WHERE statement LIKE 'Owner correction:%'").get().n, 0);
  beta.close();
});

test('a credential in a correction is redacted before anything is stored, and the transcript text is never stored', () => {
  const s = setup();
  optIn(s);
  const secret = assemble('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
  const file = join(s.base, 'secret.jsonl');
  const row = (text) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
  writeFileSync(file, [row('Deploy the service'), row(`No, use the token ${secret} for the deploy.`), row('Nothing else of this line may be stored: the quiet blue marmot')].join('\n') + '\n');
  end(s, file);
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(proposals(s).length, 1);
  const bytes = storeBytes(s.data);
  assert.equal(bytes.includes(secret), false);
  assert.equal(bytes.includes('quiet blue marmot'), false);
  assert.match(proposals(s)[0].statement, /REDACTED/);
});

test('private spans and the do-not-index marker are honoured before anything is read', () => {
  const s = setup();
  optIn(s);
  const row = (text) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
  const a = join(s.base, 'private.jsonl');
  writeFileSync(a, [row('Deploy the service'), row('<private>No, use the staging account for everything here.</private> Looks fine otherwise.')].join('\n') + '\n');
  const b = join(s.base, 'noindex.jsonl');
  writeFileSync(b, [row('Deploy the service'), row('DO NOT INDEX THIS CHAT'), row('No, use the other branch for the release.')].join('\n') + '\n');
  end(s, a, 'sess-a');
  end(s, b, 'sess-b');
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(proposals(s).length, 0);
});

test('PostCompact keeps the redacted summary as an episode only under the opt-in, and it is never mined for corrections', () => {
  const s = setup();
  const compact = () => run(['transcript'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's9', hook_event_name: 'PostCompact', cwd: s.acmeApi, compact_summary: `The owner said: No, use the other branch for the release. Key ${assemble('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')}` }) });
  assert.equal(compact().status, 0);
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 0, 'off by default');
  optIn(s);
  assert.equal(compact().status, 0);
  const [e] = sql(s, "SELECT kind, summary FROM transcripts WHERE kind = 'summary'");
  assert.ok(e.summary.includes('use the other branch'));
  assert.equal(e.summary.includes('ghp_'), false);
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(proposals(s).length, 0);
});

// Scenario 5 and the extraction rules, on the module itself: bundled from source for this file.
async function load() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tr-'));
  const outfile = join(dir, 'transcripts.mjs');
  await build({ entryPoints: [join(here, '../src/capture/transcripts.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

test('US1.5 an item whose quote is not verbatim in the transcript is dropped, and one that is survives', async () => {
  const m = await load();
  const s = setup();
  optIn(s);
  const file = fixture(s, 'correction');
  end(s, file);
  const db = new DatabaseSync(join(s.data, 'tenants/acme.sqlite'));
  try {
    const paraphrase = () => [{ line: 7, quote: 'No, please prefer the other branch for the release.' }, { line: 3, quote: "Don't worry, it is small." }, { line: 7, quote: 'No, use the other branch for the release.' }];
    const done = m.processTranscripts(db, 'acme', { automation: true }, paraphrase);
    assert.equal(done.proposed, 1, 'only the verbatim quote of the owner turn');
    assert.deepEqual(db.prepare("SELECT statement FROM items WHERE statement LIKE 'Owner correction:%'").all().map((r) => r.statement), ['Owner correction: "No, use the other branch for the release."']);
  } finally {
    db.close();
  }
});

test('the deterministic pass finds correction sentences of the owner only', async () => {
  const m = await load();
  const t = (line, text) => ({ line, text });
  const found = m.findCorrections([t(1, "Don't start with this task line."), t(2, 'Looks good. No, use the other branch. Then continue.'), t(3, 'No problem at all, thanks.'), t(4, 'Never commit to main directly, please.')]);
  assert.deepEqual(found.map((c) => c.quote), ['No, use the other branch.', 'Never commit to main directly, please.']);
});

// ---- Tier 3 review corrections ----------------------------------------------------------------------------------------

const row = (text, extra = {}) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, ...extra });
const write = (s, name, ...lines) => {
  const file = join(s.base, name);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
};
const storeOf = (s, name) => new DatabaseSync(join(s.data, 'tenants', `${name}.sqlite`));

test('R1 purge --repo removes only that repository\'s transcript records, in every tenant file it reaches', () => {
  const s = setup();
  optIn(s);
  remember(s.betaWeb, s.data, s.configA, 'Beta builds run from the root', '--scope', 'repository', '--type', 'convention');
  end(s, fixture(s, 'correction', 'a1.jsonl'), 'api', s.acmeApi);
  end(s, fixture(s, 'correction', 'a2.jsonl'), 'web', s.acmeWeb);
  end(s, fixture(s, 'correction', 'b1.jsonl'), 'beta', s.betaWeb);
  const count = (name) => {
    const db = storeOf(s, name);
    try {
      return db.prepare('SELECT repository FROM transcripts ORDER BY repository').all().map((r) => r.repository);
    } finally {
      db.close();
    }
  };
  assert.deepEqual(count('acme'), ['acme/api', 'acme/web']);
  assert.equal(run(['purge', '--repo', 'acme/api', '--confirm'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.deepEqual(count('acme'), ['acme/web']);
  assert.deepEqual(count('beta'), ['beta/web']);
});

test('R2 private spans: a span inside a sentence drops the correction, a span across records hides what is between, an unclosed one hides the rest', () => {
  const s = setup();
  optIn(s);
  const spliced = write(s, 'spliced.jsonl', row('Deploy the service'), row('No, use <private>x</private> branch.'), row('No, use the other branch for the release.'));
  const across = write(s, 'across.jsonl', row('Deploy the service'), row('<private>keep this out'), row('No, use the staging account for everything here.'), row('and this</private>. Never push to main directly, please.'));
  const unclosed = write(s, 'unclosed.jsonl', row('Deploy the service'), row('No, use the other branch for the release. <private>from here'), row('Never push to main directly, please.'), row('No, use the staging account for everything here.'));
  end(s, spliced, 'sp');
  end(s, across, 'ac');
  end(s, unclosed, 'un');
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.deepEqual(proposals(s).map((p) => p.statement).sort(), [
    'Owner correction: "No, use the other branch for the release."',
    'Owner correction: "Never push to main directly, please."',
  ].sort());
  const sources = sql(s, "SELECT source_ref FROM evidence WHERE source_ref LIKE 'transcript:%' ORDER BY source_ref").map((r) => r.source_ref);
  assert.deepEqual(sources.map((x) => x.split(':').slice(1, 3).join(':')), ['ac:L4', 'sp:L3', 'un:L2'].sort());
});

test('R3 SessionEnd never opens the transcript: a transcript that reads as automation is still only recorded, and refused at processing', () => {
  const s = setup();
  optIn(s);
  const file = write(s, 'auto.jsonl', row('Deploy the service', { entrypoint: 'sdk-cli' }), row('No, use the other branch for the release.'));
  assert.equal(end(s, file, 'auto').status, 0);
  assert.deepEqual(records(s).map((x) => [x.path, x.processed_at]), [[file, null]], 'recorded without reading it');
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(proposals(s).length, 0, 'refused at processing');
  assert.equal(records(s)[0].outcome, 'automation');
});

test('R4 expiry runs on every sweep and session start even with the opt-in off, for paths and summaries alike', () => {
  const s = setup();
  optIn(s);
  end(s, fixture(s, 'correction'));
  run(['transcript'], { cwd: s.acmeApi, data: s.data, config: s.configA, input: JSON.stringify({ session_id: 's9', hook_event_name: 'PostCompact', cwd: s.acmeApi, compact_summary: 'A summary of the work so far' }) });
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 2);
  optIn(s, 'off');
  const db = storeOf(s, 'acme');
  db.prepare("UPDATE transcripts SET at = '2020-01-01T00:00:00.000Z'").run();
  db.close();
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 0, 'session start');
  optIn(s, 'on');
  end(s, fixture(s, 'correction'), 'later');
  optIn(s, 'off');
  const d2 = storeOf(s, 'acme');
  d2.prepare("UPDATE transcripts SET at = '2020-01-01T00:00:00.000Z'").run();
  d2.close();
  run(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(sql(s, 'SELECT count(*) AS n FROM transcripts')[0].n, 0, 'sweep');
});

// ---- second review corrections ------------------------------------------------------------------------------------------

test('R5 a human transcript swept from a process that reads as automation stays eligible: the decision rests on the record and the transcript, not the sweeper', () => {
  const s = setup();
  optIn(s);
  end(s, fixture(s, 'correction'));
  const r = run(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', GITHUB_ACTIONS: 'true' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(proposals(s).length, 1);
  assert.equal(records(s)[0].outcome, 'read');
});

test('R6 every deletion by expiry is audited exactly once, with the opt-in on or off, and a later sweep adds nothing', () => {
  const s = setup();
  const old = () => {
    const db = storeOf(s, 'acme');
    db.prepare("UPDATE transcripts SET at = '2020-01-01T00:00:00.000Z'").run();
    db.close();
  };
  const audits = () => sql(s, "SELECT action, metadata_json FROM audit_events WHERE action LIKE 'transcripts_%' ORDER BY created_at").map((a) => [a.action, JSON.parse(a.metadata_json).expired]);
  optIn(s);
  end(s, fixture(s, 'correction'));
  old();
  run(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.deepEqual(audits(), [['transcripts_expired', 1]], 'opted in, only an expired record');
  run(['sweep'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.deepEqual(audits(), [['transcripts_expired', 1]], 'nothing deleted, nothing audited');
  end(s, fixture(s, 'correction'), 'two');
  optIn(s, 'off');
  old();
  sessionStart(s.acmeApi, s.data, s.configA);
  assert.deepEqual(audits(), [['transcripts_expired', 1], ['transcripts_expired', 1]], 'opted out');
});

// ---- #84: private spans opened in records the owner filter skips ---------------------------------------------------------

const toolResult = (text) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: text }] } });
const toolUse = (input) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input }] } });
const OWNER_A = 'No, use the other branch for the release.';
const OWNER_B = 'Never push to main directly, please.';
const mined = (s, name, ...lines) => {
  end(s, write(s, `${name}.jsonl`, ...lines), name);
  sessionStart(s.acmeApi, s.data, s.configA);
  return proposals(s).map((p) => p.statement.replace(/^Owner correction: "|"$/g, ''));
};

test('#84.1 a private tag opened in a tool-result record hides an owner correction before its close, and only that one', () => {
  const s = setup();
  optIn(s);
  assert.deepEqual(mined(s, 'tr', row('Deploy the service'), toolResult('output <private>secret'), row(OWNER_A), toolResult('end</private>'), row(OWNER_B)), [OWNER_B]);
});

test('#84.1b a tag opened in a tool call or a non-text block of an owner record hides the next correction too', () => {
  const s = setup();
  optIn(s);
  const mixed = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: '<private>' }] }, { type: 'text', text: OWNER_A }] } });
  assert.deepEqual(mined(s, 'mx', row('Deploy the service'), toolUse({ command: 'echo <private>' }), row(OWNER_A)), []);
  assert.deepEqual(mined(s, 'mx2', row('Deploy the service'), mixed, row(OWNER_B)), []);
});

test('#84.2 a tag opened in a sidechain or a meta record hides a later owner correction', () => {
  const s = setup();
  optIn(s);
  const side = JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sub <private>' } });
  const meta = JSON.stringify({ type: 'user', isSidechain: false, isMeta: true, message: { role: 'user', content: 'meta <private>' } });
  assert.deepEqual(mined(s, 'sc', row('Deploy the service'), side, row(OWNER_A)), []);
  assert.deepEqual(mined(s, 'mt', row('Deploy the service'), meta, row(OWNER_B)), []);
});

test('#84.3 a span opened and closed inside a tool-result record leaves a later owner correction proposed', () => {
  const s = setup();
  optIn(s);
  assert.deepEqual(mined(s, 'ok', row('Deploy the service'), toolResult('a <private>hidden</private> b'), row(OWNER_A)), [OWNER_A]);
});

// ---- #85 review: tags are read from one stream, with nesting --------------------------------------------------------------

const textBlocks = (...texts) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: texts.map((text) => ({ type: 'text', text })) } });

const fresh = () => {
  const s = setup();
  optIn(s);
  return s;
};

test('#85.a an open tag split across two blocks or two records still opens the span', () => {
  assert.deepEqual(mined(fresh(), 'sa', row('Deploy the service'), toolResult('out <pri'), toolResult('vate> secret'), row(OWNER_A)), []);
  assert.deepEqual(mined(fresh(), 'sb', row('Deploy the service'), toolResult('out <'), toolResult('private> secret'), row(OWNER_B)), []);
  assert.deepEqual(mined(fresh(), 'sc2', row('Deploy the service'), textBlocks('<priv', 'ate> x'), row(OWNER_A)), []);
});

test('#85.b a close tag split across blocks or records closes the span, and what follows is proposed', () => {
  assert.deepEqual(mined(fresh(), 'ca', row('Deploy the service'), toolResult('<private> secret </pri'), toolResult('vate>'), row(OWNER_A)), [OWNER_A]);
});

test('#85.c nested spans stay private until the outer one closes', () => {
  assert.deepEqual(mined(fresh(), 'n1', row('Deploy the service'), toolResult('<private> a <private> b </private> c'), row(OWNER_A), toolResult('</private>'), row(OWNER_B)), [OWNER_B]);
  assert.deepEqual(mined(fresh(), 'n2', row('Deploy the service'), row(`<private> a <private> b </private> ${OWNER_A} </private> done.`), row(OWNER_B)), [OWNER_B]);
});

test('#85.d a close tag with no open span is ignored and hides nothing, and never cancels a later open', () => {
  assert.deepEqual(mined(fresh(), 'um', row('Deploy the service'), toolResult('stray </private> tag'), row(OWNER_A), row(`${OWNER_B} </private>`)).sort(), [OWNER_A, OWNER_B].sort());
  assert.deepEqual(mined(fresh(), 'um2', row('Deploy the service'), toolResult('</private><private>'), row(OWNER_A)), []);
});

// ---- #85 last pass: every string moves the private depth, whichever field it is in ----------------------------------------

const textBlock = (extra) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', ...extra }] } });

test('#85.e a private tag in a sibling field before the text, in a nested field, or in an array of strings hides the owner text that follows', () => {
  assert.deepEqual(mined(fresh(), 'e1', row('Deploy the service'), textBlock({ title: '<private>', text: OWNER_A })), []);
  assert.deepEqual(mined(fresh(), 'e2', row('Deploy the service'), textBlock({ annotation: { note: { body: 'x <private>' } }, text: OWNER_A })), []);
  assert.deepEqual(mined(fresh(), 'e3', row('Deploy the service'), textBlock({ citations: ['a', 'b <private>'], text: OWNER_A })), []);
  assert.deepEqual(mined(fresh(), 'e4', row('Deploy the service'), JSON.stringify({ type: 'user', isSidechain: false, extra: { pre: '<private>' }, message: { role: 'user', content: OWNER_A } })), []);
});

test('#85.f a closed private span in a sibling field leaves the text proposed, and a tag after the text does not hide it', () => {
  assert.deepEqual(mined(fresh(), 'f1', row('Deploy the service'), textBlock({ title: 'a <private>b</private>', text: OWNER_A })), [OWNER_A]);
  assert.deepEqual(mined(fresh(), 'f2', row('Deploy the service'), textBlock({ text: OWNER_A, title: '<private>' })), [OWNER_A]);
});

// ---- #85 owner decision: records are read in their written order ----------------------------------------------------------

test('#85.g an integer-like key written after message with a close tag does not close a span before the correction is read', () => {
  const late = `{"type":"user","isSidechain":false,"message":{"role":"user","content":${JSON.stringify(OWNER_A)}},"0":"</private>"}`;
  assert.deepEqual(mined(fresh(), 'g1', row('Deploy the service'), toolResult('<private>'), late), []);
  const lateNested = `{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(OWNER_A)}}]},"1":{"0":"</private>"}}`;
  assert.deepEqual(mined(fresh(), 'g2', row('Deploy the service'), toolResult('<private>'), lateNested), []);
});

test('#85.h an integer-like key written before message with an open tag still hides the text, and one written after does not hide it', () => {
  const early = `{"0":"<private>","type":"user","isSidechain":false,"message":{"role":"user","content":${JSON.stringify(OWNER_A)}}}`;
  assert.deepEqual(mined(fresh(), 'h1', row('Deploy the service'), early), []);
  const after = `{"type":"user","isSidechain":false,"message":{"role":"user","content":${JSON.stringify(OWNER_A)}},"0":"<private>"}`;
  assert.deepEqual(mined(fresh(), 'h2', row('Deploy the service'), after), [OWNER_A]);
});

test('#85.i a malformed line is handled as before: its raw text moves the depth, and the next valid record is read normally', () => {
  assert.deepEqual(mined(fresh(), 'i1', row('Deploy the service'), '{"type":"user","message":{"content":"<private> cut off', row(OWNER_A)), []);
  assert.deepEqual(mined(fresh(), 'i2', row('Deploy the service'), '{"type":"user","message":{"content":"cut off', row(OWNER_A)), [OWNER_A]);
});
