import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, remember, sessionStart, tokens } from './helpers.mjs';

function setBudget(data, budget) {
  const path = join(data, 'config.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), sessionBudget: budget }));
}

const statement = (n) => `Convention number ${n} applies to every module in this repository without exception`;

const full = (() => {
  let cached;
  return () => {
    if (cached) return cached;
    const s = setup();
    for (let n = 0; n < 60; n++) {
      const scope = ['repository', 'organisation', 'person'][n % 3];
      const r = remember(s.acmeApi, s.data, s.configA, statement(n), '--scope', scope, '--type', 'convention');
      assert.equal(r.status, 0, r.stderr);
    }
    cached = s;
    return s;
  };
})();

test('the slice never exceeds its budget, and prints only whole items', () => {
  const s = full();
  for (const budget of [0, 20, 50, 120, 300]) {
    setBudget(s.data, budget);
    const out = sessionStart(s.acmeApi, s.data, s.configA).stdout;
    assert.ok(tokens(out) <= budget, `budget ${budget}: ${tokens(out)} tokens`);
    if (budget === 0) assert.equal(out, '');
    for (const line of out.split('\n').filter((l) => l.startsWith('- '))) {
      assert.match(line, /Convention number \d+ applies to every module in this repository without exception$/);
    }
  }
});

test('when items are dropped, a last line says how many more there are', () => {
  const s = full();
  setBudget(s.data, 300);
  const out = sessionStart(s.acmeApi, s.data, s.configA).stdout;
  const shown = out.split('\n').filter((l) => l.startsWith('- ')).length;
  assert.ok(shown > 0 && shown < 60, `${shown} shown`);
  assert.match(out, new RegExp(`\\+${60 - shown} more`));
});

test('the slice is byte-identical for the same store and carries no timestamp', () => {
  const s = full();
  setBudget(s.data, 300);
  const a = sessionStart(s.acmeApi, s.data, s.configA).stdout;
  const b = sessionStart(s.acmeApi, s.data, s.configA).stdout;
  assert.ok(a.length > 0);
  assert.equal(a, b);
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/);
});

test('repository items rank before organisation and person items', () => {
  const s = full();
  setBudget(s.data, 2000);
  const lines = sessionStart(s.acmeApi, s.data, s.configA).stdout.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 60);
  const numbers = lines.map((l) => Number(/number (\d+)/.exec(l)[1]));
  assert.deepEqual(numbers.slice(0, 20).map((n) => n % 3), Array(20).fill(0));
});

test('the hook prints nothing when no item is visible', () => {
  const s = setup();
  const out = sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('the hook prints nothing and exits 0 when the store cannot be read', () => {
  const s = full();
  writeFileSync(join(s.data, 'config.json'), '{not json');
  const out = sessionStart(s.acmeApi, s.data, s.configA);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});
