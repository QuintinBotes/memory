import type { DatabaseSync } from 'node:sqlite';
import { redact } from '../redact/redact.ts';
import { safe } from '../render/rows.ts';
import { recordAudit } from '../store/audit.ts';
import { inTransaction } from '../store/transaction.ts';
import { applySupersession } from '../consolidate.ts';
import { read, type EvidenceRow, type ItemRow } from './markdown.ts';
import type { Anchor } from '../items.ts';
import { scfEndpoint } from '../config.ts';

/**
 * Swarm Code Factory (SCF) as a later backend (#13): this tenant's proposals are posted to the SCF configured for it as
 * `world_proposal`s of `world_fact`s with layer `memory`, and SCF's decisions and run outcomes come back. Reads only the
 * tenant's own store, never the person file; an item of person or global scope never leaves.
 *
 * SCF routes used (apps/api/scf_api/routers/world.py): GET and POST /world/proposals. The outcome read,
 * GET /world/facts/{id}/feedback answering {items: [{run_id, outcome}]}, is the contract this slice asks of SCF (its
 * world_fact_feedback rows have no REST read yet).
 */

export const SCF_TIMEOUT_MS = 10_000;
const MAX_ANSWER = 5_000_000;
const PAGE = 200;
const MAX_PAGES = 50;

export class ScfError extends Error {}

export interface ScfClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/**
 * A client for one SCF. After the first failure it makes no further call: a run against an SCF that is down costs one
 * timeout, not one per item. A redirect is an error, so the key is never sent to another host. An answer's body is never
 * repeated in a message.
 */
export function scfClient(base: URL, key: string, timeoutMs = SCF_TIMEOUT_MS): ScfClient {
  let failed: ScfError | null = null;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (failed !== null) throw failed;
    const fail = (message: string): never => {
      failed = new ScfError(message);
      throw failed;
    };
    let res: Response;
    try {
      // Built from the validated origin and a fixed route, then checked: the key is never sent to another origin.
      const target = new URL(`${scfEndpoint(base)}${path}`);
      if (target.origin !== base.origin) return fail(`SCF at ${base.host}: a request would leave its origin`);
      res = await fetch(target, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return fail(`SCF at ${base.host} is unreachable or too slow`);
    }
    if (!res.ok) return fail(`SCF at ${base.host} answered ${res.status}`);
    try {
      // Read a chunk at a time and stop at the cap, so an oversized answer is never held whole.
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body ?? []) {
        size += chunk.byteLength;
        // Leaving the loop cancels the stream.
        if (size > MAX_ANSWER) return fail(`SCF at ${base.host} answered too much`);
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error === failed) throw error;
      return fail(`SCF at ${base.host} sent an answer memory cannot read`);
    }
  };
  return { get: (path) => call('GET', path), post: (path, body) => call('POST', path, body) };
}

export interface Remote {
  id: string;
  status: string;
  fact_id: string | null;
  item: string | null;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Every proposal SCF holds for this workspace, with the memory item id each carries, a page at a time. */
export async function remoteProposals(client: ScfClient): Promise<Remote[]> {
  const out: Remote[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = obj(await client.get(`/world/proposals?limit=${PAGE}&offset=${page * PAGE}`))['items'];
    if (!Array.isArray(items)) throw new ScfError('SCF sent proposals in a shape memory does not know');
    for (const raw of items) {
      const p = obj(raw);
      const item = obj(obj(p['payload'])['qualifiers'])['memory_item_id'];
      if (typeof p['id'] !== 'string' || typeof p['status'] !== 'string') throw new ScfError('SCF sent a proposal in a shape memory does not know');
      // A blank id names no proposal: never adopted, so the item is sent again and gets a real one.
      if (p['id'].trim() === '') continue;
      out.push({ id: p['id'], status: p['status'], fact_id: typeof p['fact_id'] === 'string' ? p['fact_id'] : null, item: typeof item === 'string' ? item : null });
    }
    if (items.length < PAGE) return out;
  }
  throw new ScfError(`SCF holds more than ${MAX_PAGES * PAGE} proposals, more than memory lists; nothing was sent`);
}

/** An item as SCF's ProposalIn: the statement is the fact's value, the item's own fields ride in its qualifiers. */
function proposalOf(row: ItemRow, evidence: EvidenceRow[]): Record<string, unknown> {
  const anchors = (JSON.parse(row.anchors_json) as Anchor[]).map((a) => ({ path: a.path, ...(a.symbol === undefined ? {} : { symbol: a.symbol }) }));
  return {
    subject: row.scope_key,
    phrase: row.type,
    value: row.statement,
    layer: 'memory',
    rationale: row.rationale ?? '',
    qualifiers: {
      memory_item_id: row.id,
      type: row.type,
      scope: row.scope,
      origin_trust: row.origin_trust,
      anchors,
      evidence: evidence.map((e) => ({ source_ref: e.source_ref, author_role: e.author_role, captured_at: e.captured_at })),
    },
  };
}

export interface ExportResult {
  posted: number;
  /** Already sent by an earlier run, here or from another machine. */
  already: number;
  /** Items some outbound field of which redaction would change: a stored item should never hold such text, so none of it is sent. */
  withheld: number;
}

/** Every string an outbound payload carries, at any depth. */
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : typeof v === 'object' && v !== null ? Object.values(v).flatMap(strings) : []);
/** Whether redaction would change any outbound field: statement, rationale, anchors, source references, all of it. */
const redactable = (payload: unknown): boolean => strings(payload).some((t) => Object.keys(redact(t).counts).length > 0);

/**
 * Posts this tenant's proposed items, none twice: an item linked to this SCF is skipped, and SCF's own list (`remote`,
 * read before the store was opened) links a proposal a crashed run sent but could not record. Links are written in one
 * transaction after every post succeeded, so a failure part-way leaves the store as it was and the next run adopts what
 * was already posted.
 */
export async function exportToScf(db: DatabaseSync, tenant: string, client: ScfClient, remote: Remote[], endpoint: string, repository?: string): Promise<ExportResult> {
  const linked = new Set((db.prepare('SELECT item_id FROM scf_links WHERE endpoint = ?').all(endpoint) as { item_id: string }[]).map((r) => r.item_id));
  const all = read(db, tenant, repository).filter(
    ({ row }) => row.status === 'proposed' && row.quarantine === null && row.statement !== '' && (row.scope === 'repository' || row.scope === 'organisation') && row.scope_key !== '',
  );
  const todo = all.filter(({ row }) => !linked.has(row.id));
  const result: ExportResult = { posted: 0, already: all.length - todo.length, withheld: 0 };
  const known = new Map(remote.flatMap((p) => (p.item === null ? [] : [[p.item, p] as const])));
  const links: { id: string; proposal: string }[] = [];
  for (const { row, evidence } of todo) {
    const found = known.get(row.id);
    if (found !== undefined) {
      links.push({ id: row.id, proposal: found.id });
      result.already++;
      continue;
    }
    const payload = proposalOf(row, evidence);
    if (redactable(payload)) {
      result.withheld++;
      continue;
    }
    let answer: Record<string, unknown>;
    try {
      answer = obj(await client.post('/world/proposals', payload));
    } catch (error) {
      if (error instanceof ScfError && result.posted > 0) throw new ScfError(`${error.message}; ${result.posted} proposals were already sent and the next run adopts them`);
      throw error;
    }
    if (typeof answer['id'] !== 'string' || answer['id'].trim() === '') throw new ScfError('SCF answered a proposal without an id');
    links.push({ id: row.id, proposal: answer['id'] });
    result.posted++;
  }
  inTransaction(db, () => {
    const link = db.prepare('INSERT OR IGNORE INTO scf_links (item_id, endpoint, proposal_id, exported_at) VALUES (?, ?, ?, ?)');
    for (const { id, proposal } of links) {
      link.run(id, endpoint, proposal, new Date().toISOString());
      recordAudit(db, 'scf_exported', { type: 'item', id }, { proposal });
    }
  });
  return result;
}

export interface FeedbackResult {
  approved: number;
  rejected: number;
  /** Accepted in SCF, but the evidence was purged here: the item stays proposed, for the owner. */
  held: number;
  helped: number;
  wrong: number;
}

const FEEDBACK_PAGE = 500;
const HELD = 'accepted in SCF, evidence purged here';

/** Items SCF accepted whose evidence was purged here, as `memory review` lists them for the owner. */
export function heldInScf(db: DatabaseSync, tenant: string): string[] {
  if (tenant === '') return [];
  const rows = db
    .prepare("SELECT DISTINCT i.id, i.type, i.scope, i.scope_key, i.statement FROM scf_links l JOIN items i ON i.id = l.item_id WHERE l.held IS NOT NULL AND i.status = 'proposed' AND i.tenant = ? ORDER BY i.id")
    .all(tenant) as { id: string; type: string; scope: string; scope_key: string; statement: string }[];
  return rows.map((r) => `${safe(`- [${r.id}] ${r.type}, ${r.scope_key === '' ? r.scope : `${r.scope} ${r.scope_key}`}, ${HELD}: ${JSON.stringify(safe(r.statement))}`)}\n`);
}

/** Every run outcome SCF holds for a fact, a page at a time; one it does not know, or a listing it cuts short, is an error, never a count. */
async function outcomes(client: ScfClient, fact: string): Promise<{ run: string; outcome: 'reinforced' | 'weakened' }[]> {
  const out: { run: string; outcome: 'reinforced' | 'weakened' }[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = obj(await client.get(`/world/facts/${encodeURIComponent(fact)}/feedback?limit=${FEEDBACK_PAGE}&offset=${page * FEEDBACK_PAGE}`))['items'];
    if (!Array.isArray(items)) throw new ScfError('SCF sent feedback in a shape memory does not know');
    for (const raw of items) {
      const f = obj(raw);
      if (typeof f['run_id'] !== 'string' || (f['outcome'] !== 'reinforced' && f['outcome'] !== 'weakened')) throw new ScfError('SCF sent feedback in a shape memory does not know');
      out.push({ run: f['run_id'], outcome: f['outcome'] });
    }
    if (items.length < FEEDBACK_PAGE) return out;
  }
  throw new ScfError('SCF holds more run outcomes for one fact than memory lists; nothing was applied');
}

/**
 * Brings SCF's side back: an accepted proposal makes its item active, a rejected one rejects it (the owner decided it
 * in SCF's inbox), and each run outcome on the accepted fact counts once as helped or wrong. Everything is fetched first
 * and applied in one transaction, so an SCF that fails part-way changes nothing. Only items this store linked to this SCF
 * are touched, looked up by their link, whatever SCF answers.
 */
export async function importFromScf(db: DatabaseSync, tenant: string, client: ScfClient, remote: Remote[], endpoint: string): Promise<FeedbackResult> {
  const result: FeedbackResult = { approved: 0, rejected: 0, held: 0, helped: 0, wrong: 0 };
  const links = db
    .prepare('SELECT l.item_id, l.proposal_id, l.fact_id, i.status, EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = i.id) AS has_evidence FROM scf_links l JOIN items i ON i.id = l.item_id WHERE l.endpoint = ? AND i.tenant = ? ORDER BY l.item_id')
    .all(endpoint, tenant) as { item_id: string; proposal_id: string; fact_id: string | null; status: string; has_evidence: number }[];
  const byId = new Map(remote.map((p) => [p.id, p]));
  const seen = db.prepare('SELECT 1 FROM scf_feedback WHERE item_id = ? AND run_id = ?');
  const plan: { id: string; decision: 'accepted' | 'rejected' | 'held' | null; fact: string | null; fresh: { run: string; outcome: 'reinforced' | 'weakened' }[] }[] = [];
  for (const l of links) {
    const p = byId.get(l.proposal_id);
    if (p === undefined) continue;
    const decided = p.status === 'accepted' || p.status === 'rejected';
    const fact = p.status === 'accepted' ? (l.fact_id ?? p.fact_id) : null;
    const fresh = fact === null ? [] : (await outcomes(client, fact)).filter((o) => seen.get(l.item_id, o.run) === undefined);
    // A purge here is the owner's decision; SCF accepting does not undo it.
    const decision = !decided || l.status !== 'proposed' ? null : p.status === 'accepted' && l.has_evidence === 0 ? 'held' : (p.status as 'accepted' | 'rejected');
    plan.push({ id: l.item_id, decision, fact, fresh });
  }
  inTransaction(db, () => {
    const now = new Date().toISOString();
    for (const { id, decision, fact, fresh } of plan) {
      if (decision === 'accepted') {
        if (db.prepare("UPDATE items SET status = 'active', status_reason = NULL, stale_reports = 0, valid_from = ? WHERE id = ? AND tenant = ? AND status = 'proposed'").run(now, id, tenant).changes === 1) {
          const older = (db.prepare('SELECT supersedes FROM items WHERE id = ?').get(id) as { supersedes: string | null }).supersedes;
          if (older !== null) applySupersession(db, id, older, 'proposed', true);
          recordAudit(db, 'proposal_approved', { type: 'item', id }, { decision: 'approve', via: 'scf' });
          result.approved++;
        }
      } else if (decision === 'held') {
        if (db.prepare('UPDATE scf_links SET held = ? WHERE item_id = ? AND endpoint = ? AND held IS NULL').run(HELD, id, endpoint).changes === 1) result.held++;
      } else if (decision === 'rejected') {
        if (db.prepare("UPDATE items SET status = 'rejected', valid_to = ?, status_reason = 'rejected in SCF' WHERE id = ? AND tenant = ? AND status = 'proposed'").run(now, id, tenant).changes === 1) {
          recordAudit(db, 'proposal_rejected', { type: 'item', id }, { decision: 'reject', via: 'scf' });
          result.rejected++;
        }
      }
      if (fact !== null) db.prepare('UPDATE scf_links SET fact_id = ? WHERE item_id = ? AND endpoint = ? AND fact_id IS NULL').run(fact, id, endpoint);
      if (fresh.length === 0) continue;
      const add = db.prepare('INSERT OR IGNORE INTO scf_feedback (item_id, run_id, outcome) VALUES (?, ?, ?)');
      let helped = 0;
      let wrong = 0;
      for (const o of fresh) {
        if (add.run(id, o.run, o.outcome).changes === 1) o.outcome === 'reinforced' ? helped++ : wrong++;
      }
      db.prepare('UPDATE items SET helped = helped + ?, wrong = wrong + ?, reinforced_at = CASE WHEN ? > 0 THEN ? ELSE reinforced_at END WHERE id = ?').run(helped, wrong, helped, now, id);
      recordAudit(db, 'scf_feedback', { type: 'item', id }, { helped, wrong });
      result.helped += helped;
      result.wrong += wrong;
    }
  });
  return result;
}
