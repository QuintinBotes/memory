import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';

/**
 * FR-008 of #22: whether a session was started by a program rather than a person at the terminal. Claude Code hands
 * a hook no field that says so, so this reads what it does leave: the entrypoint it exports to the processes it
 * starts (`CLAUDE_CODE_ENTRYPOINT`: `sdk-cli` for `claude -p`, `sdk-ts`, `sdk-py`, `github-action`), `GITHUB_ACTIONS` a workflow sets, and the entrypoint it records on a transcript's lines. Anything that clears those looks like a person.
 */
const isAutomated = (entrypoint: unknown): boolean => typeof entrypoint === 'string' && (entrypoint.startsWith('sdk') || entrypoint === 'github-action');

function transcriptEntrypoint(path: string): string | undefined {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n', 40)) {
      const e = (JSON.parse(line) as { entrypoint?: unknown }).entrypoint;
      if (typeof e === 'string') return e;
    }
  } catch {
    // No transcript, or a line that is not JSON: nothing to read.
  }
  return undefined;
}

/** Why the session reads as automation, or null for a person. */
export function automationReason(env: NodeJS.ProcessEnv = process.env, transcript?: string): string | null {
  if (isAutomated(env['CLAUDE_CODE_ENTRYPOINT'])) return `entrypoint ${env['CLAUDE_CODE_ENTRYPOINT']}`;
  if (env['GITHUB_ACTIONS'] === 'true') return 'a GitHub Actions job';
  const recorded = transcript === undefined ? undefined : transcriptEntrypoint(transcript);
  return isAutomated(recorded) ? `transcript entrypoint ${recorded}` : null;
}

/** The refusal an automation-started session gets from capture and propose, or null: a person's session, or one the consent plan names. */
export function automationRefusal(config: Config, env: NodeJS.ProcessEnv = process.env, transcript?: string): string | null {
  if (config.automation === true) return null;
  const why = automationReason(env, transcript);
  return why === null ? null : `this session was started by automation (${why}); memory neither captures nor proposes in it unless the consent plan names automation sessions (memory init --automation on)`;
}
