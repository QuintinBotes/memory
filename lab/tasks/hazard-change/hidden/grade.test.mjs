import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(join(process.env.LAB_REPO, path)).href);
const { consume } = await load('src/ledger.mjs');

test('a negative amount is refused with a RangeError', () => assert.throws(() => consume(-1), RangeError));

test('consume stays synchronous, as the run lock it runs under needs', () => {
  assert.notEqual(consume.constructor.name, 'AsyncFunction');
  assert.equal(typeof consume(2), 'number');
});
