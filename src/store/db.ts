import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One schema for every file, tenant and person alike. Migrations follow
 * Review Voice's store: an ordered list, applied by `user_version`.
 *
 * Items are shaped like Swarm Code Factory's world facts and Orbit's lessons,
 * so an export is a mapping, not a rewrite. There is no column for raw text:
 * the statement is stored only after the gate refused anything sensitive.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('repository', 'organisation', 'person', 'global')),
    scope_key TEXT NOT NULL,
    type TEXT NOT NULL,
    statement TEXT NOT NULL,
    rationale TEXT,
    status TEXT NOT NULL,
    authority TEXT NOT NULL DEFAULT 'advisory',
    origin_trust TEXT NOT NULL,
    anchors_json TEXT NOT NULL DEFAULT '[]',
    support INTEGER NOT NULL DEFAULT 1,
    contradictions INTEGER NOT NULL DEFAULT 0,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    expires_at TEXT,
    supersedes TEXT,
    promoted_to TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_items_visible ON items (status, scope, scope_key);

  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    source_ref TEXT NOT NULL,
    author_role TEXT NOT NULL,
    quote_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    extractor TEXT NOT NULL
  );
  CREATE INDEX idx_evidence_item ON evidence (item_id);

  CREATE TABLE audit_events (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    subject_type TEXT,
    subject_id TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,

  // v2 - why an item went stale (slice 2), so the owner can see it before a recheck.
  `ALTER TABLE items ADD COLUMN status_reason TEXT;`,
];

/**
 * Opens one store file. Readers pass `create: false` and get null for a file
 * that does not exist, so reading never creates a store for a tenant.
 */
export function openStore(path: string, create: boolean): DatabaseSync | null {
  if (!existsSync(path)) {
    if (!create) return null;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}
