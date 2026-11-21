import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(join(process.env.LAB_REPO, path)).href);
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('the cli prints its version', () => {
  assert.equal(execFileSync(process.execPath, [join(process.env.LAB_REPO, 'cli.mjs'), '--version'], { encoding: 'utf8' }), '1.0.0\n');
});

test('the check still uses its dependency: the environment was at fault, not the check', () => {
  assert.match(readFileSync(join(process.env.LAB_REPO, 'scripts/check.mjs'), 'utf8'), /from 'fmt'/);
});
