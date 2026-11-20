import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'dist/memory.mjs');

test('the bundle prints the manifest version', () => {
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const out = execFileSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), manifest.version);
});

test('the marketplace entry carries the manifest version', () => {
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(market.plugins[0].version, manifest.version);
});
