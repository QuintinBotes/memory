import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { quarantineOf, reduceTombstones, statementKey, type Trust } from '../items.ts';
import { recordAudit } from './audit.ts';

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
  (db) => {
    db.exec('ALTER TABLE items ADD COLUMN stale_reports INTEGER NOT NULL DEFAULT 0;');
    const hidden = db.prepare("SELECT id FROM items WHERE status = 'stale' AND status_reason = 'reported stale'").all() as { id: string }[];
    const restore = db.prepare("UPDATE items SET status = 'active', status_reason = NULL, stale_reports = 1 WHERE id = ?");
    for (const { id } of hidden) {
      restore.run(id);
      recordAudit(db, 'item_restored', { type: 'item', id }, { reason: 'an agent stale report is now counted, not obeyed' });
    }
  },

  // v6 - secure deletion (#23). Its one change to the file, rewriting a store written before it, runs in openStore.
  () => {},

  // v7 - embeddings (#44): one vector per item, kept in the item's own file and deleted with it. The model and
  // dims say what produced it, so a vector from another model is never compared with a query from this one.
  `
  CREATE TABLE item_vectors (
    item_id TEXT PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  `,

  // v8 - taint (#22, FR-006): the external content a session had read when it made the evidence, named by its source.
  // It lives on the evidence, so a merge adds to it, an undo takes it away and a supersession leaves the older item's own.
  // Skipped when the column is there, so a store a test or an older install rolled back by version alone still opens.
  (db) => {
    const has = (db.prepare('PRAGMA table_info(evidence)').all() as { name: string }[]).some((c) => c.name === 'taint');
    if (!has) db.exec('ALTER TABLE evidence ADD COLUMN taint TEXT;');
  },

  // v9 - anchor paths (#14, SC-003): one row per item and anchor path, kept by triggers so every writer of
  // `anchors_json` maintains it, and backfilled for stores written before it. The point-of-action hook looks
  // items up by path here instead of parsing every item's anchors. IF NOT EXISTS, so a rolled-back store reopens.
  `
  CREATE TABLE IF NOT EXISTS item_anchors (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    PRIMARY KEY (path, item_id)
  ) WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS item_anchors_insert AFTER INSERT ON items BEGIN
    INSERT OR IGNORE INTO item_anchors SELECT NEW.id, json_extract(value, '$.path') FROM json_each(NEW.anchors_json)
      WHERE json_extract(value, '$.path') IS NOT NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS item_anchors_update AFTER UPDATE OF anchors_json ON items BEGIN
    DELETE FROM item_anchors WHERE item_id = NEW.id;
    INSERT OR IGNORE INTO item_anchors SELECT NEW.id, json_extract(value, '$.path') FROM json_each(NEW.anchors_json)
      WHERE json_extract(value, '$.path') IS NOT NULL;
  END;
  DELETE FROM item_anchors;
  INSERT OR IGNORE INTO item_anchors SELECT items.id, json_extract(a.value, '$.path') FROM items, json_each(items.anchors_json) a
    WHERE items.anchors_json != '[]' AND json_extract(a.value, '$.path') IS NOT NULL;
  `,

  // v10 - edits to an instruction file (#26, #40): a conflict with a loaded line, or a promotion into the file. A row
  // is only ever a proposal; `memory conflicts apply --confirm` is the one writer of the file. Deleted with its item.
  // IF NOT EXISTS, so a store a test or an older install rolled back by version alone still opens.
  `
  CREATE TABLE IF NOT EXISTS instruction_edits (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('conflict', 'promotion')),
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    old_line TEXT NOT NULL,
    new_line TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (item_id, kind, file, old_line)
  );
  `,

  // v11 - the failure fingerprints and check ids an item applies to (#11), read from Orbit's lessons and run-end
  // observations, so a run that repeats one finds the item. Deleted with its item.
  `
  CREATE TABLE IF NOT EXISTS item_keys (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('fingerprint', 'check')),
    key TEXT NOT NULL,
    PRIMARY KEY (kind, key, item_id)
  ) WITHOUT ROWID;
  `,

  // v12 - failures and reverts (#18). An episode is one failed session command, scrubbed, kept 30 days (only with the
  // failing-commands opt-in); commit_items names the items shown in the session that made a commit, and reverts the
  // reverts of such commits already counted, so one revert is never counted twice, and revert_counts the contradictions
  // those reverts have added to an item (one per session that reverted it, none for a revert that was itself reverted).
  `
  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    command_key TEXT NOT NULL,
    command TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    signature TEXT NOT NULL,
    head TEXT NOT NULL,
    at TEXT NOT NULL,
    repaired_at TEXT,
    UNIQUE (session, command_key, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS idx_episodes_open ON episodes (session, command_key);
  CREATE TABLE IF NOT EXISTS commit_items (
    commit_sha TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    session TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (commit_sha, item_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS reverts (
    revert_sha TEXT PRIMARY KEY,
    reverted_sha TEXT NOT NULL,
    at TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    linked INTEGER NOT NULL DEFAULT 0,
    cancelled_by TEXT
  );
  CREATE TABLE IF NOT EXISTS revert_counts (
    item_id TEXT PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    applied INTEGER NOT NULL
  );
  `,

  // v13 - promotions (#19): a proposal to turn an item into a check, a line of the review-standards file or a test. A row is
  // only a proposal; a rejected one stays, so it is never proposed again. Deleted with its item.
  `
  CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    target TEXT NOT NULL CHECK (target IN ('review-standards', 'test')),
    symbol TEXT NOT NULL DEFAULT '',
    file TEXT,
    line TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'rejected', 'resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (item_id, target, symbol)
  );
  `,

  // v14 - the repository an item was learned in (null = unknown), so a person or global item can be filtered, recalled and
  // purged by where it came from. Repository items take it from their scope key; older person, global and organisation
  // items stay unknown. Skipped when the column is there, so a store rolled back by version alone still opens.
  (db) => {
    const has = (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some((c) => c.name === 'origin_repository');
    if (!has) db.exec('ALTER TABLE items ADD COLUMN origin_repository TEXT;');
    db.exec("UPDATE items SET origin_repository = scope_key WHERE scope = 'repository' AND origin_repository IS NULL;");
  },

  // v15 - transcripts, opt-in (#12): where a session's transcript is, recorded by the SessionEnd hook and read at the next
  // session start or sweep, and the redacted compaction summaries kept as episodes. Never the transcript's text; deleted
  // after 30 days.
  `
  CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('path', 'summary')),
    repository TEXT NOT NULL,
    path TEXT,
    summary TEXT,
    at TEXT NOT NULL,
    processed_at TEXT,
    outcome TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_transcripts_open ON transcripts (kind, processed_at);
  `,
];
const SECURE_DELETE = 6;

/** How long a writer waits for the store's one write lock before it fails; a hook waits far less, so a busy store never costs a tool call. */
export const WRITE_BUSY_MS = 5000;
export const HOOK_BUSY_MS = 250;

/**
 * Opens one store file. Readers pass `create: false` and get null for a file
 * that does not exist, so reading never creates a store for a tenant.
 */
export function openStore(path: string, create: boolean, busyMs = WRITE_BUSY_MS): DatabaseSync | null {
  if (!existsSync(path)) {
    if (!create) return null;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  // Deleted content is overwritten, not left in free pages (#23); the full-text index has its own option, set in v4.
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyMs)}; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA synchronous = NORMAL;`);
  // Write-ahead log: readers see a snapshot and are never blocked by the writer, and writers queue on one lock.
  // The mode is stored in the file, so it is switched once, and only a store not yet in it takes the lock to do so.
  if ((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL');
  const version = (): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  // A store written before secure deletion is rewritten once, before the version that records it, so text deleted
  // earlier is gone too; a rewrite that fails is tried again on the next open.
  if (version() > 0 && version() < SECURE_DELETE) db.exec('VACUUM');
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
