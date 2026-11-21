import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { quarantineOf, reduceTombstones, statementKey, type Trust } from '../items.ts';

/**
 * One schema for every file, tenant and person alike. Migrations follow
 * Review Voice's store: an ordered list, applied by `user_version`.
 *
 * Items are shaped like Swarm Code Factory's world facts and Orbit's lessons,
 * so an export is a mapping, not a rewrite. There is no column for raw text:
 * the statement is stored only after the gate refused anything sensitive.
 */
const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
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

  // v3 - the normalised statement's hash (slice 3): what a duplicate and a tombstone are matched by.
  (db) => {
    db.exec('ALTER TABLE items ADD COLUMN statement_key TEXT; CREATE INDEX idx_items_key ON items (tenant, statement_key);');
    const set = db.prepare('UPDATE items SET statement_key = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, statement FROM items').all() as { id: string; statement: string }[]) {
      set.run(statementKey(r.statement), r.id);
    }
  },

  // v4 - feedback counts, the quarantine flag and the full-text index (slice 4). The index is
  // keyed by item id, not rowid, which a VACUUM may renumber, and deletes securely (#23).
  // shortcut: deleting an item scans the index for its id: 2 ms for one item at 10,000 items,
  // about 10 s to purge a whole 10,000-item tenant; index the id if purges that large matter.
  (db) => {
    db.exec(`
  ALTER TABLE items ADD COLUMN helped INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN wrong INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN reinforced_at TEXT;
  ALTER TABLE items ADD COLUMN quarantine TEXT;
  CREATE VIRTUAL TABLE items_fts USING fts5 (item_id UNINDEXED, statement, rationale, tokenize = 'porter unicode61');
  INSERT INTO items_fts (items_fts, rank) VALUES ('secure-delete', 1);
  INSERT INTO items_fts (item_id, statement, rationale) SELECT id, statement, rationale FROM items;
  CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
    INSERT INTO items_fts (item_id, statement, rationale) VALUES (new.id, new.statement, new.rationale);
  END;
  CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
    DELETE FROM items_fts WHERE item_id = old.id;
  END;
  CREATE TRIGGER items_fts_update AFTER UPDATE OF statement, rationale ON items BEGIN
    UPDATE items_fts SET statement = new.statement, rationale = new.rationale WHERE item_id = old.id;
  END;
  `);
    // Proposals stored before quarantine existed are classified as a new one would be.
    const set = db.prepare('UPDATE items SET quarantine = ? WHERE id = ?');
    const rows = db.prepare("SELECT id, statement, origin_trust FROM items WHERE status = 'proposed'").all() as { id: string; statement: string; origin_trust: string }[];
    for (const r of rows) {
      const flag = quarantineOf({ statement: r.statement, status: 'proposed', trust: r.origin_trust as Trust });
      if (flag !== null) set.run(flag, r.id);
    }
  },

  // v5 - agents' stale reports, counted for the owner instead of hiding the item. An item an agent
  // took out of recall before comes back active with its report; the next re-check judges its citation.
  `ALTER TABLE items ADD COLUMN stale_reports INTEGER NOT NULL DEFAULT 0;
   UPDATE items SET status = 'active', status_reason = NULL, stale_reports = 1 WHERE status = 'stale' AND status_reason = 'reported stale';`,
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
  const version = (): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version() < MIGRATIONS.length) {
    // Read the version again under the write lock: another session may have
    // migrated between the first read and the lock.
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let v = version(); v < MIGRATIONS.length; v++) {
        const migration = MIGRATIONS[v]!;
        if (typeof migration === 'string') db.exec(migration);
        else migration(db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  reduceTombstones(db);
  return db;
}
