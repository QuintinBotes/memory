// Adapted from Review Voice, plugins/review-voice/src/store/paths.ts at 707ba60
// (https://github.com/QuintinBotes/review-voice, MIT).
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Memory stores everything outside any repository, in the platform's data
 * directory, so a store can never be committed by accident and lands where a
 * user's backup and privacy tooling already looks.
 */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['MEMORY_DATA_DIR'];
  if (override !== undefined && override.length > 0) return override;

  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'claude-code-memory');
    case 'win32': {
      const appData = env['APPDATA'];
      return appData !== undefined && appData.length > 0
        ? join(appData, 'claude-code-memory')
        : join(home, 'AppData', 'Roaming', 'claude-code-memory');
    }
    default: {
      const xdg = env['XDG_DATA_HOME'];
      return xdg !== undefined && xdg.length > 0
        ? join(xdg, 'claude-code-memory')
        : join(home, '.local', 'share', 'claude-code-memory');
    }
  }
}

/** One file per tenant, beside one person file. A tenant name is checked before it gets here. */
export const tenantFile = (data: string, tenant: string): string => join(data, 'tenants', `${tenant}.sqlite`);
export const personFile = (data: string): string => join(data, 'person.sqlite');
