import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { setup, run } from './helpers.mjs';

// #81: every git memory runs goes through the shared runner: allowlisted environment, SIGKILL at a timeout, capped output.
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function stub(s, name, script) {
  const dir = join(s.base, `bin-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}
const at = (s, dir, env = {}) => ({ cwd: s.acmeApi, data: s.data, config: s.configA, path: `${dir}:/usr/bin:/bin`, env });

test('G1 git sees only an allowlisted environment: no SCF key, no API key', () => {
  const s = setup();
  const log = join(s.base, 'env.log');
  const dir = stub(s, 'env', `env > "${log}"\nexec "${realGit}" "$@"`);
  const r = run(['list'], at(s, dir, { SCF_API_KEY: 'scf-secret', ANTHROPIC_API_KEY: 'anthropic-secret', VOYAGE_API_KEY: 'voyage-secret' }));
  assert.equal(r.status, 0, r.stderr);
  const seen = readFileSync(log, 'utf8');
  assert.match(seen, /^PATH=/m);
  assert.doesNotMatch(seen, /SCF_API_KEY|ANTHROPIC_API_KEY|VOYAGE_API_KEY|secret/);
});

test('G2 a git that ignores SIGTERM is killed at the timeout', { timeout: 60_000 }, () => {
  const s = setup();
  const dir = stub(s, 'hang', 'trap "" TERM\nexec sleep 3600');
  const r = run(['list'], at(s, dir, { MEMORY_PROGRAM_TIMEOUT_MS: '300' }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ETIMEDOUT/);
});

test('G3 a git that floods output is cut off and the run fails instead of filling memory', { timeout: 60_000 }, () => {
  const s = setup();
  const dir = stub(s, 'flood', 'exec yes');
  const r = run(['list'], at(s, dir));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ENOBUFS/);
});

test('G4 a machine without git has no tenant and says so instead of failing', () => {
  const s = setup();
  const empty = join(s.base, 'empty');
  mkdirSync(empty);
  const r = run(['list'], { cwd: s.acmeApi, data: s.data, config: s.configA, path: empty });
  assert.equal(r.status, 0, r.stderr);
});

test('G5 MEMORY_PROGRAM_TIMEOUT_MS is ignored outside the test harness and clamped to 100 ms - 15 s inside it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-ts-'));
  const outfile = join(dir, 'run.mjs');
  await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), '../src/provider/run.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, logLevel: 'silent' });
  const { programTimeoutMs } = await import(pathToFileURL(outfile).href);
  assert.equal(programTimeoutMs({ MEMORY_PROGRAM_TIMEOUT_MS: '1' }), 15_000);
  assert.equal(programTimeoutMs({ MEMORY_PROGRAM_TIMEOUT_MS: '999999999' }), 15_000);
  const h = { MEMORY_TEST_HARNESS: '1' };
  assert.equal(programTimeoutMs({ ...h, MEMORY_PROGRAM_TIMEOUT_MS: '1' }), 100);
  assert.equal(programTimeoutMs({ ...h, MEMORY_PROGRAM_TIMEOUT_MS: '300' }), 300);
  assert.equal(programTimeoutMs({ ...h, MEMORY_PROGRAM_TIMEOUT_MS: '999999999' }), 15_000);
  assert.equal(programTimeoutMs(h), 15_000);
});
