/**
 * Bundles the plugin CLI into one committed file.
 *
 * The plugin installs by git clone with no install step, so users never run
 * `npm install`. The shipped bundle has no runtime dependencies beyond Node.
 *
 *   node scripts/build.mjs           build dist/memory.mjs
 *   node scripts/build.mjs --check   fail if the committed bundle is stale
 *
 * Adapted from Review Voice's scripts/build.mjs
 * (https://github.com/QuintinBotes/review-voice, MIT).
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'src/cli.ts');
const outfile = join(root, 'dist/memory.mjs');
const checkOnly = process.argv.includes('--check');

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  write: false,
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
});

const built = result.outputFiles[0].text;

if (checkOnly) {
  if (!existsSync(outfile)) {
    console.error('dist/memory.mjs is missing. Run: npm run build');
    process.exit(1);
  }
  if ((await readFile(outfile, 'utf8')) !== built) {
    console.error('dist/memory.mjs is stale: it does not match src/.\nRun `npm run build` and commit the result.');
    process.exit(1);
  }
  console.log('dist/memory.mjs is up to date.');
  process.exit(0);
}

await writeFile(outfile, built, { mode: 0o755 });

// Prove the bundle loads before declaring success.
try {
  execFileSync(process.execPath, [outfile, '--version'], { stdio: 'pipe' });
} catch (error) {
  console.error('The bundle was written but does not run:\n');
  console.error((error.stderr ?? Buffer.from('')).toString().split('\n').slice(0, 12).join('\n'));
  process.exit(1);
}

console.log(`Built ${outfile} (${(built.length / 1024).toFixed(1)} kB), loads cleanly`);
