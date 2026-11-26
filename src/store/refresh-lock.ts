import { closeSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A lock older than this belongs to a process that died; the next taker takes it over. */
const STALE_MS = 30_000;

/** Takes the lock file `lock`, or returns undefined when it is still held after `waitMs` (0 never waits); the result releases it. */
function acquire(lock: string, waitMs: number, staleMs: number): (() => void) | undefined {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
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
  writeSync(fd, String(process.pid));
  const held = fd;
  return () => {
    closeSync(held);
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  };
}

/**
 * Runs `work` holding the lock file `lock`, or returns `undefined` when it is still held after `waitMs` (0 never waits).
 * A separate file, so a holder never blocks a store's readers or writers.
 */
export function withFileLock<T>(lock: string, work: () => T, waitMs = 0, staleMs = STALE_MS): T | undefined {
  const release = acquire(lock, waitMs, staleMs);
  if (release === undefined) return undefined;
  try {
    return work();
  } finally {
    release();
  }
}

/**
 * As withFileLock for work that awaits (a network call): held until the promise settles. A heartbeat touches the lock
 * while the work runs, so a long run is never taken for a dead one; `staleMs` is only injectable for tests.
 */
export async function withFileLockAsync<T>(lock: string, work: () => Promise<T>, waitMs = 0, staleMs = STALE_MS): Promise<T | undefined> {
  const release = acquire(lock, waitMs, staleMs);
  if (release === undefined) return undefined;
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      // released or taken over: nothing to refresh
    }
  }, Math.max(1, Math.floor(staleMs / 3)));
  try {
    return await work();
  } finally {
    clearInterval(beat);
    release();
  }
}

/**
 * The anchor-refresh lock for one store file: held means skip, never wait, so a held refresh never delays the
 * session-start slice, and two refreshes never apply the same change twice.
 */
export const withRefreshLock = <T>(storeFile: string, work: () => T): T | undefined => withFileLock(`${storeFile}.refresh.lock`, work);
