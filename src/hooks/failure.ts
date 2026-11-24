import type { DatabaseSync } from 'node:sqlite';
import { consented, currentConfigDir, loadConfig, subagentAllowed } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { resolveContext } from '../context.ts';
import { errorLines, fingerprintFailure, normalizeLine } from '../fingerprint.ts';
import { failureStatements, itemsById } from '../items.ts';
import { chooseSlice, estimate, row } from '../slice.ts';
import { HOOK_BUSY_MS, openStore } from '../store/db.ts';
import { MAIN_AGENT } from '../store/ledger.ts';
import { tenantFile } from '../store/paths.ts';
import { inTransaction } from '../store/transaction.ts';
import type { Log } from './point-of-action.ts';

/** What one failure may show, fence included. */
export const FAILURE_BUDGET = 120;

// Made on first use, as the point-of-action ledger is, so a store that never shows a recipe is untouched. It holds the
// fingerprint's hash and item ids, never error text. `contradicted` is 1 once the repeat was charged to the item.
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

/** What a normalised line holds in place of what varies between runs; these say nothing about the cause. */
const PLACEHOLDER = /<(?:path|tmp|time|dur|hex|uuid|n|repo|port)>/g;
/** Words too common in errors to identify one. */
const COMMON = new Set(['error', 'failed', 'fail', 'warning', 'exit', 'code']);
/** A signature needs this many words that are neither common nor a placeholder, or it matches nothing. */
export const MIN_SIGNATURE_WORDS = 2;

/** The distinct words of a normalised line: NFC, placeholders dropped, lower case. */
export const words = (line: string): string[] => [...new Set(line.normalize('NFC').replace(PLACEHOLDER, ' ').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w !== ''))];

/** A statement is one line, so a recipe writes its signature first and the repair after this: `ERR_MODULE_NOT_FOUND esbuild => run npm ci`. */
export const SIGNATURE_END = ' => ';

/** The words of an item's signature, its statement up to `SIGNATURE_END` (all of it without one), as an error line is read. */
export const signatureWords = (statement: string): string[] => words(normalizeLine(statement.split(SIGNATURE_END)[0]!));

/** Whether the signature is too weak to match: fewer than two words that are not common ones or placeholders. */
export const weakSignature = (statement: string): boolean => signatureWords(statement).filter((w) => !COMMON.has(w)).length < MIN_SIGNATURE_WORDS;

/** An item matches when all the words of its signature are in one normalised line of the error. */
const matches = (statement: string, lines: Set<string>[], all: Set<string>): boolean => {
  const mine = signatureWords(statement);
  if (mine.filter((w) => !COMMON.has(w)).length < MIN_SIGNATURE_WORDS || mine.some((w) => !all.has(w))) return false;
  return lines.some((line) => mine.every((w) => line.has(w)));
};

/** The marker that makes a recipe verified: a source of its evidence has the token `passed-after:<ref>`, the command passing after the fix at <ref>. */
const VERIFIED = /(^|\s)passed-after:\S+/;

interface Plan {
  /** Matching items not yet shown for this fingerprint, to this agent in this session. */
  show: string[];
  /** Items shown for this fingerprint that match again and were not yet charged in this session. */
  charge: string[];
}

/** What this failure needs done, from the ledger as it stands; a store with no ledger has shown nothing. */
function plan(db: DatabaseSync, matching: string[], session: string, agent: string, fingerprint: string): Plan {
  let shown: { item_id: string }[] = [];
  let charged = new Set<string>();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'failure_ledger'").get() !== undefined) {
    shown = db.prepare('SELECT item_id FROM failure_ledger WHERE session = ? AND agent = ? AND fingerprint = ?').all(session, agent, fingerprint) as { item_id: string }[];
    charged = new Set((db.prepare('SELECT DISTINCT item_id FROM failure_ledger WHERE session = ? AND contradicted = 1').all(session) as { item_id: string }[]).map((r) => r.item_id));
  }
  const seen = new Set(shown.map((r) => r.item_id));
  return { show: matching.filter((id) => !seen.has(id)), charge: matching.filter((id) => seen.has(id) && !charged.has(id)) };
}

/**
 * The PostToolUseFailure hook on Bash: the failure-pattern and repair-recipe items whose signature the error carries,
 * once per fingerprint and item per agent, within 120 estimated tokens. Nothing for an interrupt. An item shown for a
 * fingerprint that fails again, in the same session and by the same agent, is charged one contradiction for that
 * session; a later session never charges it. It needs no opt-in because it stores no error text: the ledger keeps a
 * hash. It reads first and takes the write lock only to show an item or charge one. Returns the hook's JSON, or '' for
 * nothing; a store that cannot be had in time is logged as skipped.
 */
export function failureRecall(data: string, input: Record<string, unknown>, log: Log): string {
  const config = loadConfig(data);
  const agentType = str(input['agent_type']);
  const error = str(input['error']);
  if (!consented(config) || input['tool_name'] !== 'Bash' || input['is_interrupt'] === true || error === undefined) return '';
  if (agentType !== undefined && !subagentAllowed(config, agentType)) return '';
  const context = resolveContext(str(input['cwd']) ?? process.cwd(), config, currentConfigDir());
  if (context.tenant === null || context.repository === null || context.owner === null) return '';
  // Claude Code starts a Bash error with "Exit code N".
  const code = /^Exit code (\d+)/.exec(error)?.[1];
  const { fingerprint } = fingerprintFailure(error, code === undefined ? null : Number(code));
  const lines = errorLines(error).map((l) => new Set(words(l)));
  const all = new Set(lines.flatMap((l) => [...l]));
  const session = str(input['session_id']) ?? 'unknown';
  const agent = str(input['agent_id']) ?? MAIN_AGENT;
  const base = { session, agent, via: 'failure-recall', at: new Date().toISOString() };
  try {
    const db = openStore(tenantFile(data, context.tenant), false, HOOK_BUSY_MS);
    if (db === null) return '';
    try {
      const matching = failureStatements(db, context.tenant, context.repository, context.owner).filter((i) => matches(i.statement, lines, all)).map((i) => i.id);
      if (matching.length === 0) return '';
      const first = plan(db, matching, session, agent, fingerprint);
      if (first.show.length === 0 && first.charge.length === 0) return '';
      const result = inTransaction(db, () => {
        db.exec(CREATE);
        // The ledger may have changed between the read and the lock.
        const { show, charge } = plan(db, matching, session, agent, fingerprint);
        for (const id of charge) {
          db.prepare('UPDATE items SET contradictions = contradictions + 1 WHERE id = ?').run(id);
          db.prepare('UPDATE failure_ledger SET contradicted = 1 WHERE session = ? AND agent = ? AND fingerprint = ? AND item_id = ?').run(session, agent, fingerprint, id);
        }
        const items = itemsById(db, show).map((i) => ((db.prepare('SELECT source_ref FROM evidence WHERE item_id = ?').all(i.id) as { source_ref: string }[]).some((e) => VERIFIED.test(e.source_ref)) ? { ...i, type: `${i.type} (verified)` } : i));
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
