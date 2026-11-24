import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A lock older than this belongs to a process that died; the next taker takes it over. */
const STALE_MS = 30_000;

/**
 * Runs `work` holding the lock file `lock`, or returns `undefined` when it is still held after `waitMs` (0 never waits).
 * A separate file, so a holder never blocks a store's readers or writers.
 */
export function withFileLock<T>(lock: string, work: () => T, waitMs = 0): T | undefined {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released between the open and the stat: try again
      }
      if (Date.now() >= deadline) return undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
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

/**
 * The anchor-refresh lock for one store file: held means skip, never wait, so a held refresh never delays the
 * session-start slice, and two refreshes never apply the same change twice.
 */
export const withRefreshLock = <T>(storeFile: string, work: () => T): T | undefined => withFileLock(`${storeFile}.refresh.lock`, work);
