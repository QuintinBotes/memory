import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { scrub } from '../capture/capture.ts';
import { covers } from '../consent/plan.ts';
import type { Context } from '../context.ts';
import { refusal } from '../gate.ts';
import { READ_TIMEOUT_MS, EmbedError, notOnThisMachine, providerFor } from '../embed/provider.ts';
import { cosine, loadVectors } from '../embed/vectors.ts';
import { headToHeadDir } from '../eval/head-to-head/scorecard.ts';
import type { Visible } from '../items.ts';
import { openStore } from '../store/db.ts';
import { personFile, tenantFile } from '../store/paths.ts';

/** FR-001 of #28: the leg runs only while the tenant's last head-to-head scorecard shows more of memory's misses than this to be vocabulary misses. */
export const VOCABULARY_TRIGGER = 0.2;

/** Why the semantic leg may not run for `tenant`, read from its last head-to-head scorecard, or null when it may. */
export function triggerRefusal(data: string, tenant: string): string | null {
  const need = `the leg needs a vocabulary-miss share above ${VOCABULARY_TRIGGER * 100}%`;
  let share: unknown;
  try {
    share = (JSON.parse(readFileSync(join(headToHeadDir(data, tenant), 'last.json'), 'utf8')) as { vocabulary_miss_share?: unknown } | null)?.vocabulary_miss_share;
  } catch {
    return `${tenant} has no head-to-head scorecard, and ${need}; memory eval head-to-head measures it`;
  }
  if (typeof share !== 'number') return `${tenant}'s last head-to-head scorecard has no vocabulary-miss share, and ${need}`;
  if (share <= VOCABULARY_TRIGGER) return `${tenant}'s last head-to-head scorecard shows a vocabulary-miss share of ${Math.round(share * 1000) / 10}%, and ${need}`;
  return null;
}

/** Each store this process may read, as visibleItems opens them: the bound tenant's, then the person file. */
function storeFiles(data: string, context: Context): string[] {
  const tenant = context.tenant !== null && context.repository !== null && context.owner !== null ? [tenantFile(data, context.tenant)] : [];
  return [...tenant, personFile(data)];
}

/**
 * The semantic leg (#28), reached only by memory_search and diff recall, never by a hook: the cosine of each of `items`
 * with `query`, from the vectors kept in its own file, or why the leg was skipped. Null when no embedder is configured,
 * the default. The query is the one call a read makes, cut off after READ_TIMEOUT_MS.
 */
export async function similarities(
  data: string,
  context: Context,
  config: Config,
  query: string,
  items: Visible[],
): Promise<{ similarity: Map<string, number> } | { note: string } | null> {
  const provider = providerFor(config, READ_TIMEOUT_MS);
  if (provider === null) return null;
  const skipped = (reason: string): { note: string } => ({ note: `Semantic leg skipped (${reason}); items are ranked by words and paths only.` });
  if (!covers(config, 'embeddings')) return skipped('your consent does not cover embeddings yet; run memory init and confirm');
  // The trigger is measured per tenant, so the person file alone never opens the leg.
  if (context.tenant === null) return skipped(`no tenant's head-to-head scorecard applies here: ${context.reason}`);
  const closed = triggerRefusal(data, context.tenant);
  if (closed !== null) return skipped(closed);
  if (!provider.local) return skipped(notOnThisMachine(provider, context.tenant));
  // The query leaves this process as the statements do: one that carries a secret or an email is not sent at all.
  const refused = refusal(query);
  if (refused !== null) return skipped(`the query cannot be sent: ${refused}`);
  const wanted = new Set(items.map((i) => i.id));
  const stored = new Map<string, Float32Array>();
  for (const file of storeFiles(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      for (const [id, v] of loadVectors(db, provider.model)) if (wanted.has(id)) stored.set(id, v);
    } finally {
      db.close();
    }
  }
  let q: Float32Array | undefined;
  try {
    // With nothing to compare against no request is made; embedding no text still reports a missing key.
    q = (await provider.embed(stored.size === 0 ? [] : [scrub(query)], 'query'))[0];
  } catch (error) {
    if (error instanceof EmbedError) return skipped(error.message);
    throw error;
  }
  if (q === undefined) return skipped(`no vectors from ${provider.model}; memory embed --backfill stores them`);
  // shortcut: brute-force cosine, move to an index above ~50k items
  return { similarity: new Map([...stored].map(([id, v]) => [id, cosine(q, v)])) };
}
