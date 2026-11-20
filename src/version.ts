import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The manifest is the one source of the version, so `--version` cannot drift from it. */
export function pluginVersion(): string {
  const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0-unknown';
}
