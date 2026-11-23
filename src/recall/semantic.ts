import type { Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import type { Context } from '../context.ts';
import { READ_TIMEOUT_MS, EmbedError, providerFor } from '../embed/provider.ts';
import { cosine, loadVectors } from '../embed/vectors.ts';
import type { Visible } from '../items.ts';
import { openStore } from '../store/db.ts';
import { personFile, tenantFile } from '../store/paths.ts';

/** Each store this process may read, as visibleItems opens them: the bound tenant's, then the person file. */
function storeFiles(data: string, context: Context): string[] {
  const tenant = context.tenant !== null && context.repository !== null && context.owner !== null ? [tenantFile(data, context.tenant)] : [];
  return [...tenant, personFile(data)];
}

/**
 * The cosine of each of `items` with `query`, from the vectors kept in its own file, or why
 * embeddings were not used. The query is the one network call a read makes, and it is cut off
 * after READ_TIMEOUT_MS, so a search never waits long on a provider.
 */
export async function similarities(
  data: string,
  context: Context,
  config: Config,
  query: string,
  items: Visible[],
): Promise<{ similarity: Map<string, number> } | { note: string }> {
  const unused = (reason: string): { note: string } => ({ note: `Embeddings not used (${reason}); items are ranked by words and paths only.` });
  if (!covers(config, 'embeddings')) return unused('your consent does not cover them yet; run memory init and confirm');
  const provider = providerFor(config, READ_TIMEOUT_MS);
  let q: Float32Array;
  try {
    q = (await provider.embed([query], 'query'))[0]!;
  } catch (error) {
    if (error instanceof EmbedError) return unused(error.message);
    throw error;
  }
  const wanted = new Set(items.map((i) => i.id));
  const similarity = new Map<string, number>();
  for (const file of storeFiles(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      // shortcut: brute-force cosine, move to an index above ~50k items
      for (const [id, v] of loadVectors(db, provider.model)) if (wanted.has(id)) similarity.set(id, cosine(q, v));
    } finally {
      db.close();
    }
  }
  return similarity.size === 0 ? unused(`no vectors from ${provider.model}; memory embed --backfill stores them`) : { similarity };
}
