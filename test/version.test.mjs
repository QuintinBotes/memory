import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './helpers.mjs';

// #108: Claude Code updates an installed plugin only when the marketplace's version changes, so the three must move together.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

test('#108 plugin.json, the marketplace entry and package.json name one version, with a changelog section and --version for it', () => {
  const version = json('.claude-plugin/plugin.json').version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(json('.claude-plugin/marketplace.json').plugins.find((p) => p.name === 'memory').version, version);
  assert.equal(json('package.json').version, version);
  assert.match(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  assert.equal(run(['--version']).stdout.trim(), version);
});
