import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(join(process.env.LAB_REPO, path)).href);
const time = await load('src/time.mjs');

test('parseDuration turns 90s, 5m and 2h into milliseconds', () => {
  assert.equal(time.parseDuration('90s'), 90_000);
  assert.equal(time.parseDuration('5m'), 300_000);
  assert.equal(time.parseDuration('2h'), 7_200_000);
});

test('the module has named exports only', () => assert.equal(time.default, undefined));
