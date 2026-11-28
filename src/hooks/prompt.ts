import { DEFAULT_SESSION_BUDGET, currentConfigDir, neverSubagent } from '../config.ts';
import { resolveContext } from '../context.ts';
import { textMatches } from '../items.ts';
import { rank, searchTerms } from '../recall/rank.ts';
import { visibleItems } from '../recall/visible.ts';
import { ITEMS_LABEL, fence } from '../render/rows.ts';
import { estimate, row, sessionSlice } from '../slice.ts';
import { HOOK_BUSY_MS, openStore } from '../store/db.ts';
import { MAIN_AGENT, claim } from '../store/ledger.ts';
import { tenantFile } from '../store/paths.ts';
import { INJECTION_BUDGET, enabled, type Log } from './point-of-action.ts';

/** A prompt of fewer words than this is a reply ("yes", "go on"), not a question memory can answer. */
export const MIN_PROMPT_WORDS = 4;
/** The fixed bar: an item is shown only when its text holds at least this many of the prompt's distinct search terms. */
export const MIN_SHARED_TERMS = 2;
/** Words that make up a question rather than its subject, so they count toward nothing. */
const FILLER = new Set(['how', 'what', 'why', 'where', 'who', 'can', 'could', 'would', 'should', 'we', 'you', 'your', 'me', 'my', 'our', 'us', 'please', 'here', 'there', 'let', 'just', 'about']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The prompt's search terms, or none for a prompt that gets nothing: a slash command or a few words. */
export function promptTerms(prompt: string): string[] {
  const text = prompt.trim();
  if (text.startsWith('/') || text.split(/\s+/).length < MIN_PROMPT_WORDS) return [];
  return searchTerms(text).filter((t) => !FILLER.has(t));
}

/**
 * The UserPromptSubmit hook: the active, unanchored items of the repository's tenant that share at least two of the
 * prompt's words, best first as memory_search ranks them, leaving out the session slice and what this agent was shown,
 * within 120 tokens per prompt and the ledger's 600 per agent per session. No model, no network. The prompt is read
 * here and nowhere kept: not in the store, not in the log. Returns the hook's JSON, or '' for nothing; a store that
 * cannot be had in time is logged as skipped.
 */
export function promptRecall(data: string, input: Record<string, unknown>, log: Log): string {
  const config = enabled(data, ['promptRecall']);
  const agentType = str(input['agent_type']);
  const prompt = str(input['prompt']);
  if (config === null || prompt === undefined || (agentType !== undefined && neverSubagent(agentType))) return '';
  const terms = promptTerms(prompt);
  if (terms.length < MIN_SHARED_TERMS) return '';
  const cwd = str(input['cwd']) ?? process.cwd();
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null || context.owner === null) return '';
  const session = str(input['session_id']) ?? 'unknown';
  const agent = str(input['agent_id']) ?? MAIN_AGENT;
  const base = { session, agent, via: 'prompt', at: new Date().toISOString() };
  try {
    const db = openStore(tenantFile(data, context.tenant), false, HOOK_BUSY_MS);
    if (db === null) return '';
    try {
      // The bar first, one term at a time, on the index alone: a prompt that clears it for no item costs one query per word.
      const shared = new Map<string, number>();
      for (const t of terms) for (const id of textMatches(db, [t]).keys()) shared.set(id, (shared.get(id) ?? 0) + 1);
      const over = new Set([...shared].filter(([, n]) => n >= MIN_SHARED_TERMS).map(([id]) => id));
      if (over.size === 0) return '';
      // Then the candidates memory_search would see (active, this repository's, not repeated by an instruction file),
      // so the slice printed at session start can be left out: it is chosen from the same items.
      const items = visibleItems(data, context, cwd, terms, HOOK_BUSY_MS, []);
      const inSlice = new Set(sessionSlice(items, config.sessionBudget ?? DEFAULT_SESSION_BUDGET, config.pointOfAction === true).shown.map((i) => i.id));
      // Only the tenant's own items: the ledger that keeps them to once per agent lives in the tenant's file.
      const eligible = items.filter((i) => over.has(i.id) && i.anchors.length === 0 && !inSlice.has(i.id) && (i.scope === 'repository' || i.scope === 'organisation'));
      const hits = rank(eligible, [], Date.now(), undefined, undefined, [], context.repository).map((h) => h.item);
      if (hits.length === 0) return '';
      const byId = new Map(hits.map((i) => [i.id, i]));
      const result = claim(db, session, agent, hits.map((i) => i.id), (unseen, left) => {
        const budget = Math.min(INJECTION_BUDGET, left);
        const rows: string[] = [];
        const shown: { id: string; tokens: number }[] = [];
        // Whole rows in rank order; one that does not fit is skipped and a later, shorter one may still fit.
        for (const id of unseen) {
          const r = row(byId.get(id)!);
          if (estimate(fence(ITEMS_LABEL, [...rows, r].join(''))) > budget) continue;
          rows.push(r);
          shown.push({ id, tokens: estimate(r) });
        }
        const text = rows.length === 0 ? '' : fence(ITEMS_LABEL, rows.join(''));
        // The fence belongs to the first row, so the rows' tokens add up to the injection's.
        if (shown.length > 0) shown[0]!.tokens += estimate(text) - shown.reduce((sum, s) => sum + s.tokens, 0);
        return { text, shown };
      });
      if (result.text === '') return '';
      log(result.shown.map((s) => ({ event: 'injected', ...base, item: s.id, anchors: [], tokens: s.tokens })));
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.text } });
    } finally {
      db.close();
    }
  } catch {
    log([{ event: 'skipped', ...base }]);
    return '';
  }
}
