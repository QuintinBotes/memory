import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setup, run, remember, tools, fenced } from './helpers.mjs';

const REVIEW = 'review toolset: reviews a pull request diff and reports defects';
const REFACTOR = 'refactor toolset: restructures modules without changing behaviour';
const RELEASE = 'release toolset: cuts a version and writes the changelog';

function toolset(s, statement) {
  const r = remember(s.acmeApi, s.data, s.configA, statement, '--scope', 'global', '--type', 'toolset');
  assert.equal(r.status, 0, r.stderr);
  return /remembered (m-[0-9a-f]+)/.exec(r.stdout)[1];
}

const route = (s, task) => run(['route', '--', task], { cwd: s.acmeApi, data: s.data, config: s.configA });
const outcome = (s, id, ...args) => run(['outcome', id, ...args], { cwd: s.acmeApi, data: s.data, config: s.configA });

/** Each routed toolset in order, with its counts. */
function routed(s, task) {
  const r = route(s, task);
  assert.equal(r.status, 0, r.stderr);
  return fenced(r.stdout).map((l) => {
    const m = /^\[(m-[0-9a-f]+)\] toolset · .* · accepted (\d+) · rejected (\d+) · cost ([\d.]+)$/.exec(l);
    assert.ok(m, l);
    return { id: m[1], accepted: Number(m[2]), rejected: Number(m[3]), cost: Number(m[4]) };
  });
}
const counts = (s, id) => routed(s, 'toolset').find((t) => t.id === id);

test('SC1: an accepted run raises the toolset\'s accepted count by one', () => {
  const s = setup();
  const id = toolset(s, REVIEW);
  assert.deepEqual(counts(s, id), { id, accepted: 0, rejected: 0, cost: 0 });
  const r = outcome(s, id, 'accepted', '--source', 'run-1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(counts(s, id), { id, accepted: 1, rejected: 0, cost: 0 });
  // The outcome is evidence on the item.
  const db = new DatabaseSync(join(s.data, 'person.sqlite'));
  assert.deepEqual(db.prepare('SELECT source_ref, outcome FROM evidence WHERE item_id = ? AND outcome IS NOT NULL').all(id).map((e) => ({ ...e })), [{ source_ref: 'run-1', outcome: 'accepted' }]);
  db.close();
});

test('SC2: a rejected run raises the rejected count by one and adds its cost', () => {
  const s = setup();
  const id = toolset(s, REVIEW);
  assert.equal(outcome(s, id, 'rejected', '--cost', '1.5').status, 0);
  assert.deepEqual(counts(s, id), { id, accepted: 0, rejected: 1, cost: 1.5 });
  assert.equal(outcome(s, id, 'rejected', '--cost', '2').status, 0);
  assert.deepEqual(counts(s, id), { id, accepted: 0, rejected: 2, cost: 3.5 });
  assert.equal(outcome(s, id, 'maybe').status, 2);
  assert.equal(outcome(s, id, 'rejected', '--cost', '-1').status, 2);
  // Only an active toolset takes an outcome.
  const other = remember(s.acmeApi, s.data, s.configA, 'Releases are cut from main', '--scope', 'global').stdout.match(/m-[0-9a-f]+/)[0];
  assert.equal(outcome(s, other, 'accepted').status, 1);
});

test('SC3: for a code review task the review toolset ranks first', () => {
  const s = setup();
  toolset(s, REFACTOR);
  const review = toolset(s, REVIEW);
  toolset(s, RELEASE);
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Every pull request gets a review before merge', '--scope', 'global').status, 0);
  const rows = routed(s, 'Do a code review of the open pull request');
  assert.equal(rows[0].id, review);
  // Only toolsets are routed.
  assert.ok(!route(s, 'Do a code review of the open pull request').stdout.includes('before merge'));
});

test('SC4: a toolset is global and names no repository', () => {
  const s = setup();
  const id = toolset(s, REVIEW);
  const [got] = tools(s.acmeApi, s.data, s.configA, [['memory_get', { id, format: 'json' }]]);
  assert.equal(got.isError, false, got.text);
  const item = JSON.parse(fenced(got.text).join('\n'));
  assert.equal(item.scope, 'global');
  assert.equal(item.scopeKey, '');
  assert.ok(!got.text.includes('acme'), got.text);
  assert.ok(!route(s, 'review').stdout.includes('acme'));
  const db = new DatabaseSync(join(s.data, 'person.sqlite'));
  assert.equal(db.prepare('SELECT origin_repository FROM items WHERE id = ?').get(id).origin_repository, null);
  db.close();
  // Any other scope is refused.
  const r = remember(s.acmeApi, s.data, s.configA, RELEASE, '--scope', 'repository', '--type', 'toolset');
  assert.equal(r.status, 2, r.stdout);
  // An agent cannot propose one, in any scope.
  const [proposed] = tools(s.acmeApi, s.data, s.configA, [['memory_propose', { statement: RELEASE, scope: 'global', type: 'toolset', evidence: { source: 'session-1' } }]]);
  assert.equal(proposed.isError, true, proposed.text);
});

test('SC5: of two toolsets with the same purpose, both are returned with counts and more accepted ranks first', () => {
  const s = setup();
  const alpha = toolset(s, 'north reviews pull requests and flags defects early');
  const beta = toolset(s, 'south reviews pull requests and suggests style fixes');
  // The one created first would win a tie on id alone, so give the other the better record.
  const [, second] = [alpha, beta].sort();
  assert.equal(outcome(s, second, 'accepted').status, 0);
  assert.equal(outcome(s, second, 'accepted').status, 0);
  const rows = routed(s, 'review this pull request');
  assert.deepEqual(rows.map((r) => [r.id, r.accepted]), [[second, 2], [[alpha, beta].sort()[0], 0]]);
});

// #99: one run is one outcome, however often it is reported.
test('#99 the same --source recorded twice counts once and says so; no --source and another source still count', () => {
  const s = setup();
  const id = toolset(s, REVIEW);
  assert.equal(outcome(s, id, 'accepted', '--cost', '0.4', '--source', 'run-1').status, 0);
  const again = outcome(s, id, 'accepted', '--cost', '0.4', '--source', 'run-1');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already recorded/);
  assert.deepEqual(counts(s, id), { id, accepted: 1, rejected: 0, cost: 0.4 });
  assert.equal(outcome(s, id, 'rejected', '--source', 'run-1').status, 0, 'a different verdict for the same run is still the same run');
  assert.deepEqual(counts(s, id), { id, accepted: 1, rejected: 0, cost: 0.4 });
  assert.equal(outcome(s, id, 'accepted').status, 0);
  assert.equal(outcome(s, id, 'accepted').status, 0);
  assert.equal(outcome(s, id, 'accepted', '--source', 'run-2').status, 0);
  assert.deepEqual(counts(s, id), { id, accepted: 4, rejected: 0, cost: 0.4 });
});
