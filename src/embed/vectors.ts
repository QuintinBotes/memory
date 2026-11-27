import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { EmbedError, WRITE_TIMEOUT_MS, notOnThisMachine, providerFor, type EmbeddingProvider } from './provider.ts';

const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
// Copied first: a blob read from SQLite is not aligned for a Float32Array.
const fromBlob = (b: Uint8Array): Float32Array => new Float32Array(new Uint8Array(b).buffer);

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Embeds each active item of this file that has no vector from `provider.model`. Quarantined text is never
 * embedded: it is not sent anywhere. Returns how many were embedded; throws EmbedError when the provider fails.
 */
export async function embedPending(db: DatabaseSync, provider: EmbeddingProvider): Promise<number> {
  const pending = db
    .prepare(
      `SELECT id, statement FROM items WHERE status = 'active' AND quarantine IS NULL AND statement != ''
         AND id NOT IN (SELECT item_id FROM item_vectors WHERE model = ?) ORDER BY id`,
    )
    .all(provider.model) as { id: string; statement: string }[];
  if (pending.length === 0) return 0;
  const vectors = await provider.embed(pending.map((p) => p.statement), 'document');
  if (vectors.length !== pending.length) throw new EmbedError('the provider returned the wrong number of vectors');
  // The item may have been purged or quarantined while the provider answered: the guard writes nothing then.
  const put = db.prepare(
    `INSERT OR REPLACE INTO item_vectors (item_id, model, dims, vector, created_at)
     SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND status = 'active' AND quarantine IS NULL)`,
  );
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    pending.forEach((p, i) => put.run(p.id, provider.model, vectors[i]!.length, toBlob(vectors[i]!), now, p.id));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return pending.length;
}

/** Every vector of `model` in this file, by item id. */
export function loadVectors(db: DatabaseSync, model: string): Map<string, Float32Array> {
  const rows = db.prepare('SELECT item_id, vector FROM item_vectors WHERE model = ?').all(model) as { item_id: string; vector: Uint8Array }[];
  return new Map(rows.map((r) => [r.item_id, fromBlob(r.vector)]));
}

/**
 * After a write: embeds what is now active here and has no vector. A failure never undoes the write; it is said, and
 * `memory embed --backfill` fills the gap. No key is the normal state of a machine that does not use embeddings, so it is not said.
 */
export async function embedAfterWrite(db: DatabaseSync, config: Config, tenant: string): Promise<void> {
  if (!covers(config, 'embeddings')) return;
  const provider = providerFor(config, WRITE_TIMEOUT_MS);
  if (provider === null) return;
  // `tenant` is the file's tenant, '' for the person file: a tenant's text goes only to an embedder on this machine (#28).
  if (tenant !== '' && !provider.local) {
    console.error(`memory: not embedded (${notOnThisMachine(provider, tenant)})`);
    return;
  }
  try {
    await embedPending(db, provider);
  } catch (error) {
    if (!(error instanceof EmbedError)) throw error;
    if (!error.noKey) console.error(`memory: not embedded (${error.message}); memory embed --backfill fills it later`);
  }
}
