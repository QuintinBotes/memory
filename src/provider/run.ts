import { spawnSync } from 'node:child_process';

/** A provider that does not answer in this long counts as failed; recall and the refresh must stay cheap. */
export const PROVIDER_TIMEOUT_MS = 5000;
export const PROVIDER_MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Runs the configured provider command, the one runner every provider call uses (impact recall, symbol anchors). The
 * command is an absolute program with arguments (config checks), run without a shell, with `request` as one JSON line on
 * stdin. Only PATH and HOME reach it; the data directory and keys in the environment do not. SIGKILL ends it at the timeout
 * (SIGTERM can be trapped), and its output is capped. `stdout` is returned only when it exited 0 in time.
 */
export function runProvider(command: readonly string[], cwd: string, request: unknown): { ok: true; stdout: string } | { ok: false; reason: string } {
  const [program, ...args] = command as [string, ...string[]];
  const r = spawnSync(program, args, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    timeout: PROVIDER_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: PROVIDER_MAX_OUTPUT,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (r.error !== undefined) return { ok: false, reason: `${program} ${(r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `did not answer within ${PROVIDER_TIMEOUT_MS} ms` : `failed: ${r.error.message}`}` };
  if (r.status !== 0) return { ok: false, reason: `${program} exited ${r.status ?? 'by signal'}` };
  return { ok: true, stdout: r.stdout };
}
