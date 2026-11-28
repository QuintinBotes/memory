import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(join(process.env.LAB_REPO, path)).href);
const money = await load('src/money.mjs');

test('toCents turns mills into whole cents', () => {
  assert.equal(money.toCents(0), 0);
  assert.equal(money.toCents(1234), 123);
  assert.equal(money.toCents(1236), 124);
});

test('toCents rounds a half to even, as the repository decided', () => {
  assert.equal(money.toCents(125), 12);
  assert.equal(money.toCents(135), 14);
  assert.equal(money.toCents(5), 0);
  assert.equal(money.toCents(15), 2);
});

test('formatCents still formats', () => assert.equal(money.formatCents(1205), '12.05'));
