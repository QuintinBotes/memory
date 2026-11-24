import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A lock older than this belongs to a process that died; the next refresh takes it over. */
const STALE_MS = 30_000;

/**
 * Runs `work` holding the anchor-refresh lock for one store file, or returns `undefined` without waiting when
 * another refresh holds it. The lock is a separate file, so a held refresh never blocks the store's readers or
 * writers or the session-start slice, and two refreshes never apply the same change twice.
 */
export function withRefreshLock<T>(storeFile: string, work: () => T): T | undefined {
  const lock = `${storeFile}.refresh.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2 && fd === undefined; attempt++) {
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs <= STALE_MS) return undefined;
        unlinkSync(lock);
      } catch {
        return undefined;
      }
    }
  }
  if (fd === undefined) return undefined;
  try {
    writeSync(fd, String(process.pid));
    return work();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}
