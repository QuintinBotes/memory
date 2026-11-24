import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './transaction.ts';

/** What one agent may be shown at the point of action in one session, fences and all. */
export const AGENT_SESSION_BUDGET = 600;
/** The main agent's key: Claude Code sends no agent id for it. */
export const MAIN_AGENT = 'main';
/** Rows older than this are dropped on the next write, so the table does not grow without bound. */
const KEEP_DAYS = 14;

// The table is made on first use, not by a migration, so a store that never sees the capability is untouched.
const CREATE = `CREATE TABLE IF NOT EXISTS ledger (
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tokens INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (session, agent, item_id)
)`;

/**
 * Under the write lock: the items this agent was not shown yet go to `pick`, with the tokens it has left, and what
 * `pick` returns is recorded as shown, so two hooks of one agent never show one item twice. Returns `pick`'s result.
 */
export function claim<T extends { shown: { id: string; tokens: number }[] }>(
  db: DatabaseSync,
  session: string,
  agent: string,
  candidates: string[],
  pick: (unseen: string[], tokensLeft: number) => T,
): T {
  return inTransaction(db, () => {
    db.exec(CREATE);
    const rows = db.prepare('SELECT item_id, tokens FROM ledger WHERE session = ? AND agent = ?').all(session, agent) as { item_id: string; tokens: number }[];
    const seen = new Set(rows.map((r) => r.item_id));
    const used = rows.reduce((sum, r) => sum + r.tokens, 0);
    const result = pick(candidates.filter((id) => !seen.has(id)), AGENT_SESSION_BUDGET - used);
    const at = new Date().toISOString();
    const insert = db.prepare('INSERT INTO ledger (session, agent, item_id, tokens, at) VALUES (?, ?, ?, ?, ?)');
    for (const s of result.shown) insert.run(session, agent, s.id, s.tokens, at);
    db.prepare('DELETE FROM ledger WHERE at < ?').run(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
    return result;
  });
}

/** The items shown to any agent of `session`, with their statements. */
export function shownIn(db: DatabaseSync, session: string): { id: string; statement: string }[] {
  // A store with no ledger table has shown nothing: the error is the caller's "nothing to list".
  return db
    .prepare('SELECT DISTINCT i.id, i.statement FROM ledger l JOIN items i ON i.id = l.item_id WHERE l.session = ? ORDER BY i.id')
    .all(session) as { id: string; statement: string }[];
}

/** A compaction wipes the main agent's context, so it may be shown its items again. */
export function resetMain(db: DatabaseSync, session: string): void {
  inTransaction(db, () => {
    db.exec(CREATE);
    db.prepare('DELETE FROM ledger WHERE session = ? AND agent = ?').run(session, MAIN_AGENT);
  });
}
