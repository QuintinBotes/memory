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

/** What a program memory runs for itself (git) may see: no key, token or path of the environment reaches it. */
const PASS_THROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'];
export const PROGRAM_MAX_OUTPUT = 64 * 1024 * 1024;
/** Ends a program that does not answer; `MEMORY_PROGRAM_TIMEOUT_MS` shortens it, for tests of exactly that. */
export const programTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env['MEMORY_PROGRAM_TIMEOUT_MS']);
  return Number.isInteger(n) && n > 0 ? n : 15_000;
};

/**
 * Runs `program` with `args` without a shell, with the environment cut to PASS_THROUGH plus `extra`, SIGKILL at the
 * timeout (SIGTERM can be ignored) and its output capped. `stdout` is null when it exited non-zero; an error is returned
 * (never thrown) when it could not run, timed out or flooded, with `missing` set when it is not installed.
 */
export function runProgram(program: string, args: readonly string[], cwd: string, extra: Record<string, string> = {}): { stdout: string | null; error?: Error; missing?: boolean } {
  const env: Record<string, string> = { ...extra };
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  const r = spawnSync(program, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: programTimeoutMs(), killSignal: 'SIGKILL', maxBuffer: PROGRAM_MAX_OUTPUT });
  if (r.error !== undefined) return { stdout: null, error: r.error, missing: (r.error as NodeJS.ErrnoException).code === 'ENOENT' };
  return { stdout: r.status === 0 ? r.stdout : null };
}
