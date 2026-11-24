import type { DatabaseSync } from 'node:sqlite';

const inside = new WeakSet<DatabaseSync>();

/**
 * Runs `work` in one write transaction that commits whole or leaves no trace. The lock is taken up front, so a
 * writer waits its turn (busy timeout) instead of failing on a lock upgrade. Called inside another `inTransaction`
 * it joins that one, so a caller can make several writes one unit.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (inside.has(db)) return work();
  db.exec('BEGIN IMMEDIATE');
  inside.add(db);
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    inside.delete(db);
  }
}
