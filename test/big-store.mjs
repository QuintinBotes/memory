import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** 2,000 distinct words with no digit, so no statement is split off by its numbers. */
export const wordOf = (n) => `zq${[...n.toString(26)].map((c) => String.fromCharCode(97 + parseInt(c, 26))).join('')}`;
const TYPES = ['preference', 'convention', 'decision', 'hazard', 'precedent', 'failure-pattern', 'repair-recipe'];

/**
 * Adds `count` active items to an existing tenant file, the same every time: a linear congruential
 * sequence picks each statement's words, type and scope, so no fixture file is committed. The
 * statements draw seven words from 2,000, in the 70/30 mix of repository and organisation scope a tenant holds.
 */
export function fillStore(file, tenant, repository, owner, count = 10_000) {
  const db = new DatabaseSync(file);
  let seed = 12345;
  const next = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), (seed >>> 16) % n);
  const item = db.prepare(
    `INSERT INTO items (id, tenant, scope, scope_key, type, statement, statement_key, status, authority, origin_trust, anchors_json, valid_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'advisory', 'owner', '[]', ?, ?)`,
  );
  const evidence = db.prepare(`INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor) VALUES (?, ?, 'remember', 'owner', 'x', ?, 'deterministic')`);
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const words = Array.from({ length: 7 }, () => wordOf(next(2000)));
    const statement = `Bulk fixture ${words.join(' ')}`;
    const at = new Date(Date.now() - (count - i) * 1000).toISOString();
    const repo = next(10) < 7;
    item.run(`b-${String(i).padStart(6, '0')}`, tenant, repo ? 'repository' : 'organisation', repo ? repository : owner, TYPES[next(TYPES.length)], statement, createHash('sha256').update(statement).digest('hex'), at, at);
    evidence.run(`be-${i}`, `b-${String(i).padStart(6, '0')}`, at);
  }
  db.exec('COMMIT');
  db.close();
  return join(file);
}
