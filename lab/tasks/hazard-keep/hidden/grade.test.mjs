import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(join(process.env.LAB_REPO, path)).href);
const { slug, excerpt } = await load('src/slug.mjs');

test('excerpt returns the first n words', () => assert.equal(excerpt('one two  three four', 2), 'one two'));

test('slug keeps the rules published links were made with', () => {
  assert.equal(slug('Hello, World_2'), 'hello-world-2');
  assert.equal(slug('  Ça va '), 'a-va');
});
