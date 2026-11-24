import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, sessionStart, remember } from './helpers.mjs';

// FR-008 of #22: a session started by automation neither captures nor proposes unless the consent plan names it.
const HEADLESS = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };

const itemCount = (s) => {
  const file = join(s.data, 'tenants/acme.sqlite');
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT count(*) AS n FROM items').get().n;
  } finally {
    db.close();
  }
};

function capture(s, env, entrypoint) {
  const path = join(s.data, 'config.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), capture: { model: 'fake' } }));
  const file = join(s.base, 'auto.jsonl');
  const msg = (type, text, extra = {}) => JSON.stringify({ type, ...extra, message: { content: [{ type: 'text', text }] } });
  const noise = Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `step ${i}, running the tests again`, i === 0 && entrypoint ? { entrypoint } : {}));
  writeFileSync(file, [...noise, msg('assistant', 'LESSON: The nightly job runs after the backup')].join('\n') + '\n');
  return run(['capture', '--foreground'], {
    cwd: s.acmeApi, data: s.data, config: s.configA, env,
    input: JSON.stringify({ session_id: 'sa', hook_event_name: 'SessionEnd', transcript_path: file, cwd: s.acmeApi }),
  });
}

const propose = (s, env) =>
  run(['mcp'], {
    cwd: s.acmeApi, data: s.data, config: s.configA, env,
    input: [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_propose', arguments: { statement: 'The cache is cleared on deploy', scope: 'repository', type: 'convention', evidence: { source: 'agent-1' } } } },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n',
  }).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === 1).result;

test('capture in a person-started session still works', () => {
  const s = setup();
  assert.match(capture(s, {}).stderr, /captured 1/);
  assert.equal(itemCount(s), 1);
});

for (const [name, env, entrypoint] of [
  ['a headless Claude Code entrypoint', HEADLESS, undefined],
  ['a GitHub Actions job', { GITHUB_ACTIONS: 'true' }, undefined],
  ['a CI environment', { CI: 'true' }, undefined],
  ['a transcript that records an SDK entrypoint', {}, 'sdk-cli'],
]) {
  test(`capture is refused in ${name}`, () => {
    const s = setup();
    const r = capture(s, env, entrypoint);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /started by automation/);
    assert.equal(itemCount(s), 0);
  });
}

test('memory_propose is refused in an automation-started session, and is not stored', () => {
  const s = setup();
  const r = propose(s, HEADLESS);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /started by automation/);
  assert.equal(itemCount(s), 0);
  assert.notEqual(propose(s, {}).isError, true, 'a person-started session may propose');
});

test('naming automation in the consent plan lets those sessions capture and propose, and it takes a new confirmation', () => {
  const s = setup();
  const cfg = JSON.parse(readFileSync(join(s.data, 'config.json'), 'utf8'));
  writeFileSync(join(s.data, 'config.json'), JSON.stringify({ ...cfg, automation: true }));
  assert.match(capture(s, HEADLESS).stderr, /off|set up|agreed|changed/i, 'unconfirmed, memory is inert');
  assert.equal(itemCount(s), 0);
  const init = run(['init', '--automation', 'on', '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).automationSessions, true);
  assert.match(capture(s, HEADLESS).stderr, /captured 1/);
  assert.notEqual(propose(s, HEADLESS).isError, true);
  const off = run(['init', '--automation', 'off', '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(JSON.parse(off.stdout).automationSessions, false);
  assert.equal(propose(s, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }).isError, true);
});

test('the default plan says automation sessions are off, and a consent saved before this stays valid', () => {
  const s = setup();
  const r = run(['init'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(JSON.parse(r.stdout).automationSessions, false);
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Still consented', '--scope', 'repository').status, 0);
});

test('the session slice is still shown in an automation-started session: only writing is refused', () => {
  const s = setup();
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Releases are cut from main', '--scope', 'repository').status, 0);
  const r = run(['session-start'], {
    cwd: s.acmeApi, data: s.data, config: s.configA, env: HEADLESS,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: s.acmeApi }),
  });
  assert.match(r.stdout, /Releases are cut from main/);
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, /Releases are cut from main/);
});
