import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, sandbox } from './helpers.mjs';

// `memory eval poison` (#22 FR-001 to FR-004): the red-team families replayed offline in a throwaway store.
const FAMILIES = ['external-comments', 'query-only-injection', 'delayed-trigger', 'compositional', 'command-output', 'fence-escape', 'trust-laundering', 'role-spoofing'];

function poison(args = []) {
  const { base } = sandbox();
  const data = join(base, 'data');
  const r = run(['eval', 'poison', ...args], { cwd: base, data });
  const rows = r.stdout.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  return { ...r, rows, data };
}

test('eval poison reports every family: attempted, reached active, outside the fence, raised support, all zero', () => {
  const r = poison();
  assert.equal(r.status, 0, r.stderr);
  const byFamily = Object.fromEntries(r.rows.filter((x) => x.family !== undefined && x.family !== 'benign').map((x) => [x.family, x]));
  assert.deepEqual(Object.keys(byFamily).sort(), [...FAMILIES].sort());
  for (const f of FAMILIES) {
    const row = byFamily[f];
    assert.equal(row.measure, 'poison');
    assert.ok(row.attempted > 0, `${f} attempted nothing`);
    assert.equal(row.active, 0, `${f} reached active`);
    assert.equal(row.outside_fence, 0, `${f} rendered outside the fence`);
    assert.equal(row.raised_support, 0, `${f} raised an item's support`);
  }
  assert.ok(byFamily['delayed-trigger'].attempted >= 3);
});

test('eval poison runs the owner benign fixtures: all 50 accepted and recalled, and the summary meets the bar', () => {
  const r = poison();
  const benign = r.rows.find((x) => x.family === 'benign');
  assert.deepEqual({ of: benign.of, accepted: benign.accepted, recalled: benign.recalled }, { of: 50, accepted: 50, recalled: 50 });
  const summary = r.rows.at(-1);
  assert.equal(summary.summary, true);
  assert.equal(summary.meets_bar, true);
  assert.ok(summary.attempted >= FAMILIES.length * 3);
});

test('eval poison is offline and leaves no store behind, and takes no other flags', () => {
  const r = poison();
  assert.equal(existsSync(r.data), false, 'it opened the memory data directory');
  const bad = poison(['--since', '2026-01-01']);
  assert.notEqual(bad.status, 0);
});

test('eval with no measure named does not run the poison suite', () => {
  const { base } = sandbox();
  const r = run(['eval'], { cwd: base, data: join(base, 'data') });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('"poison"'));
});
