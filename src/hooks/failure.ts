import type { DatabaseSync } from 'node:sqlite';
import { consented, currentConfigDir, loadConfig, subagentAllowed } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { resolveContext } from '../context.ts';
import { fingerprintFailure, normalizeLine } from '../fingerprint.ts';
import { failureStatements, itemsById, type Visible } from '../items.ts';
import { chooseSlice, estimate, row } from '../slice.ts';
import { HOOK_BUSY_MS, openStore } from '../store/db.ts';
import { MAIN_AGENT } from '../store/ledger.ts';
import { tenantFile } from '../store/paths.ts';
import { inTransaction } from '../store/transaction.ts';
import type { Log } from './point-of-action.ts';

/** What one failure may show, fence included. */
export const FAILURE_BUDGET = 120;

// Made on first use, as the point-of-action ledger is, so a store that never sees a failure is untouched. It holds the
// fingerprint's hash and item ids, never error text.
const CREATE = `CREATE TABLE IF NOT EXISTS failure_ledger (
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  contradicted INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  PRIMARY KEY (session, agent, fingerprint, item_id)
)`;
const KEEP_DAYS = 14;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const words = (line: string): string[] => line.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w !== '');

/** A statement is one line, so a recipe writes its signature first and the repair after this: `ERR_MODULE_NOT_FOUND esbuild => run npm ci`. */
export const SIGNATURE_END = ' => ';

/**
 * Whether an item's signature, its statement up to `SIGNATURE_END` (all of it without one), matches one of the
 * error's normalised lines: every word of it is in that line. Fewer than two words say too little to match anything.
 */
export function matches(statement: string, signature: Set<string>[]): boolean {
  const mine = new Set(words(normalizeLine(statement.split(SIGNATURE_END)[0]!)));
  return mine.size >= 2 && signature.some((line) => [...mine].every((w) => line.has(w)));
}

/** A recipe is verified when a source of its evidence says the command passed after it: the word `passed`. */
const verified = (db: DatabaseSync, id: string): boolean =>
  (db.prepare('SELECT source_ref FROM evidence WHERE item_id = ?').all(id) as { source_ref: string }[]).some((e) => /(^|\s)passed(\s|$)/.test(e.source_ref));

/**
 * The PostToolUseFailure hook on Bash: the failure-pattern and repair-recipe items whose signature line the error
 * carries, once per fingerprint per agent, within 120 estimated tokens. Nothing for an interrupt. The same fingerprint
 * failing again after a recall counts once as a contradiction of what was shown. It needs no opt-in because it stores
 * no error text: the ledger keeps a hash. Returns the hook's JSON, or '' for nothing; a store that cannot be had in
 * time is logged as skipped.
 */
export function failureRecall(data: string, input: Record<string, unknown>, log: Log): string {
  const config = loadConfig(data);
  const agentType = str(input['agent_type']);
  const error = str(input['error']);
  if (!consented(config) || input['tool_name'] !== 'Bash' || input['is_interrupt'] === true || error === undefined) return '';
  if (agentType !== undefined && !subagentAllowed(config, agentType)) return '';
  const context = resolveContext(str(input['cwd']) ?? process.cwd(), config, currentConfigDir());
  if (context.tenant === null || context.repository === null || context.owner === null) return '';
  const { fingerprint, signature } = fingerprintFailure(error);
  const lines = signature.map((l) => new Set(words(l)));
  const session = str(input['session_id']) ?? 'unknown';
  const agent = str(input['agent_id']) ?? MAIN_AGENT;
  const base = { session, agent, via: 'failure-recall', at: new Date().toISOString() };
  try {
    const db = openStore(tenantFile(data, context.tenant), false, HOOK_BUSY_MS);
    if (db === null) return '';
    try {
      const result = inTransaction(db, () => {
        db.exec(CREATE);
        const shown = db.prepare('SELECT item_id FROM failure_ledger WHERE session = ? AND agent = ? AND fingerprint = ? AND contradicted = 0').all(session, agent, fingerprint) as { item_id: string }[];
        const seen = db.prepare('SELECT 1 FROM failure_ledger WHERE session = ? AND agent = ? AND fingerprint = ? LIMIT 1').get(session, agent, fingerprint);
        if (seen !== undefined) {
          for (const { item_id } of shown) db.prepare('UPDATE items SET contradictions = contradictions + 1 WHERE id = ?').run(item_id);
          db.prepare('UPDATE failure_ledger SET contradicted = 1 WHERE session = ? AND agent = ? AND fingerprint = ?').run(session, agent, fingerprint);
          return { text: '', shown: [] as Visible[] };
        }
        const found = failureStatements(db, context.tenant!, context.repository!, context.owner!).filter((i) => matches(i.statement, lines));
        // A verified recipe says so in its type, which is all the row has room for.
        const items = itemsById(db, found.map((i) => i.id)).map((i) => (verified(db, i.id) ? { ...i, type: `${i.type} (verified)` } : i));
        const slice = chooseSlice(items, FAILURE_BUDGET);
        const at = new Date().toISOString();
        for (const i of slice.shown) db.prepare('INSERT INTO failure_ledger (session, agent, fingerprint, item_id, at) VALUES (?, ?, ?, ?, ?)').run(session, agent, fingerprint, i.id, at);
        db.prepare('DELETE FROM failure_ledger WHERE at < ?').run(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
        return slice;
      });
      if (result.text === '') return '';
      if (covers(config, 'injections')) log(result.shown.map((i) => ({ event: 'injected', ...base, item: i.id, anchors: [], tokens: estimate(row(i)) })));
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: result.text } });
    } finally {
      db.close();
    }
  } catch {
    if (covers(config, 'injections')) log([{ event: 'skipped', ...base }]);
    return '';
  }
}
