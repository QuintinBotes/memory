import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(join(process.env.LAB_REPO, path)).href);
const units = await load('src/units.mjs');

for (const name of ['metres', 'kilograms', 'seconds', 'litres', 'kelvin']) {
  test(`${name} refuses a value that is not a finite number, in the repository's message style`, () => {
    assert.equal(units[name](2), 2);
    assert.throws(
      () => units[name]('x'),
      (e) => e.message.includes(name) && /^[a-z]/.test(e.message) && !e.message.endsWith('.'),
    );
  });
}
