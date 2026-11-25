import type { DatabaseSync } from 'node:sqlite';
import { redact } from '../redact/redact.ts';
import { recordAudit } from '../store/audit.ts';
import { inTransaction } from '../store/transaction.ts';
import { decide, proposals } from '../review/review.ts';
import { read, type EvidenceRow, type ItemRow } from './markdown.ts';
import type { Anchor } from '../items.ts';

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
      res = await fetch(new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base), {
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
      const text = await res.text();
      if (text.length > MAX_ANSWER) return fail(`SCF at ${base.host} answered too much`);
      return JSON.parse(text) as unknown;
    } catch {
      return fail(`SCF at ${base.host} sent an answer memory cannot read`);
    }
  };
  return { get: (path) => call('GET', path), post: (path, body) => call('POST', path, body) };
}

interface Remote {
  id: string;
  status: string;
  fact_id: string | null;
  item: string | null;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Every proposal SCF holds for this workspace, with the memory item id each carries, a page at a time. */
async function remoteProposals(client: ScfClient): Promise<Remote[]> {
  const out: Remote[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = obj(await client.get(`/world/proposals?limit=${PAGE}&offset=${page * PAGE}`))['items'];
    if (!Array.isArray(items)) throw new ScfError('SCF sent proposals in a shape memory does not know');
    for (const raw of items) {
      const p = obj(raw);
      const item = obj(obj(p['payload'])['qualifiers'])['memory_item_id'];
      if (typeof p['id'] !== 'string' || typeof p['status'] !== 'string') throw new ScfError('SCF sent a proposal in a shape memory does not know');
      out.push({ id: p['id'], status: p['status'], fact_id: typeof p['fact_id'] === 'string' ? p['fact_id'] : null, item: typeof item === 'string' ? item : null });
    }
    if (items.length < PAGE) break;
  }
  return out;
}

/** An item as SCF's ProposalIn: the statement is the fact's value, the item's own fields ride in its qualifiers. */
function proposalOf(row: ItemRow, evidence: EvidenceRow[], rationale: string, statement: string): Record<string, unknown> {
  const anchors = (JSON.parse(row.anchors_json) as Anchor[]).map((a) => ({ path: a.path, ...(a.symbol === undefined ? {} : { symbol: a.symbol }) }));
  return {
    subject: row.scope_key,
    phrase: row.type,
    value: statement,
    layer: 'memory',
    rationale,
    qualifiers: {
      memory_item_id: row.id,
      type: row.type,
      scope: row.scope,
      origin_trust: row.origin_trust,
      anchors,
      evidence: evidence.map((e) => ({ source_ref: redact(e.source_ref).text, author_role: e.author_role, captured_at: e.captured_at })),
    },
  };
}

export interface ExportResult {
  posted: number;
  /** Already sent by an earlier run, here or from another machine. */
  already: number;
  /** Text redaction would change: a stored item should never hold such text, so it is not sent. */
  withheld: number;
  /** Set when SCF stopped answering part-way; what was sent before is recorded, the rest waits for the next run. */
  stoppedBy?: string;
}

/**
 * Posts this tenant's proposed items, none twice: an item with a link is skipped, and SCF's own list is read first so
 * a proposal a crashed run sent but could not record is linked, not sent again. Nothing is written locally until SCF has
 * answered, so an unreachable SCF leaves the store as it was.
 */
export async function exportToScf(db: DatabaseSync, tenant: string, client: ScfClient, repository?: string): Promise<ExportResult> {
  const linked = new Set((db.prepare('SELECT item_id FROM scf_links').all() as { item_id: string }[]).map((r) => r.item_id));
  const all = read(db, tenant, repository).filter(
    ({ row }) => row.status === 'proposed' && row.quarantine === null && row.statement !== '' && (row.scope === 'repository' || row.scope === 'organisation') && row.scope_key !== '',
  );
  const todo = all.filter(({ row }) => !linked.has(row.id));
  const result: ExportResult = { posted: 0, already: all.length - todo.length, withheld: 0 };
  if (todo.length === 0) return result;
  const remote = new Map((await remoteProposals(client)).flatMap((p) => (p.item === null ? [] : [[p.item, p] as const])));
  const link = db.prepare('INSERT OR IGNORE INTO scf_links (item_id, proposal_id, exported_at) VALUES (?, ?, ?)');
  const record = (id: string, proposal: string): void => {
    inTransaction(db, () => {
      link.run(id, proposal, new Date().toISOString());
      recordAudit(db, 'scf_exported', { type: 'item', id }, { proposal });
    });
  };
  for (const { row, evidence } of todo) {
    const known = remote.get(row.id);
    if (known !== undefined) {
      record(row.id, known.id);
      result.already++;
      continue;
    }
    const statement = redact(row.statement);
    const rationale = redact(row.rationale ?? '');
    if (Object.keys(statement.counts).length > 0 || Object.keys(rationale.counts).length > 0) {
      result.withheld++;
      continue;
    }
    try {
      const answer = obj(await client.post('/world/proposals', proposalOf(row, evidence, rationale.text, statement.text)));
      if (typeof answer['id'] !== 'string') throw new ScfError('SCF answered a proposal without an id');
      record(row.id, answer['id']);
      result.posted++;
    } catch (error) {
      if (!(error instanceof ScfError)) throw error;
      if (result.posted === 0 && result.already === all.length - todo.length) throw error;
      return { ...result, stoppedBy: error.message };
    }
  }
  return result;
}

export interface FeedbackResult {
  approved: number;
  rejected: number;
  helped: number;
  wrong: number;
}

/** A run outcome list SCF sent, or throws when it is not one: an unknown outcome is never counted as either. */
async function outcomes(client: ScfClient, fact: string): Promise<{ run: string; outcome: 'reinforced' | 'weakened' }[]> {
  const items = obj(await client.get(`/world/facts/${encodeURIComponent(fact)}/feedback`))['items'];
  if (!Array.isArray(items)) throw new ScfError('SCF sent feedback in a shape memory does not know');
  return items.map((raw) => {
    const f = obj(raw);
    if (typeof f['run_id'] !== 'string' || (f['outcome'] !== 'reinforced' && f['outcome'] !== 'weakened')) throw new ScfError('SCF sent feedback in a shape memory does not know');
    return { run: f['run_id'], outcome: f['outcome'] };
  });
}

/**
 * Brings SCF's side back: an accepted proposal makes its item active, a rejected one rejects it (the owner decided it
 * in SCF's inbox), and each run outcome on the accepted fact counts once as helped or wrong. Only items this store linked
 * are touched, whatever SCF answers.
 */
export async function importFromScf(db: DatabaseSync, tenant: string, client: ScfClient): Promise<FeedbackResult> {
  const result: FeedbackResult = { approved: 0, rejected: 0, helped: 0, wrong: 0 };
  const links = db.prepare('SELECT item_id, proposal_id, fact_id FROM scf_links ORDER BY item_id').all() as { item_id: string; proposal_id: string; fact_id: string | null }[];
  if (links.length === 0) return result;
  const remote = new Map((await remoteProposals(client)).map((p) => [p.id, p]));
  const seen = db.prepare('SELECT 1 FROM scf_feedback WHERE item_id = ? AND run_id = ?');
  for (const { item_id: id, proposal_id, fact_id } of links) {
    const p = remote.get(proposal_id);
    if (p === undefined) continue;
    const open = p.status === 'accepted' || p.status === 'rejected' ? proposals(db, tenant, id).find((q) => q.status === 'proposed') : undefined;
    if (open !== undefined) {
      if (p.status === 'accepted') decide(db, open, 'approve', { scope: open.scope, scopeKey: open.scope_key });
      else decide(db, open, 'reject', { reason: 'rejected in SCF' });
      result[p.status === 'accepted' ? 'approved' : 'rejected']++;
    }
    const fact = fact_id ?? p.fact_id;
    if (p.status !== 'accepted' || fact === null) continue;
    if (fact_id === null) db.prepare('UPDATE scf_links SET fact_id = ? WHERE item_id = ?').run(fact, id);
    const fresh = (await outcomes(client, fact)).filter((o) => seen.get(id, o.run) === undefined);
    if (fresh.length === 0) continue;
    inTransaction(db, () => {
      const add = db.prepare('INSERT OR IGNORE INTO scf_feedback (item_id, run_id, outcome) VALUES (?, ?, ?)');
      let helped = 0;
      let wrong = 0;
      for (const o of fresh) {
        if (add.run(id, o.run, o.outcome).changes === 1) o.outcome === 'reinforced' ? helped++ : wrong++;
      }
      db.prepare('UPDATE items SET helped = helped + ?, wrong = wrong + ?, reinforced_at = CASE WHEN ? > 0 THEN ? ELSE reinforced_at END WHERE id = ?').run(helped, wrong, helped, new Date().toISOString(), id);
      recordAudit(db, 'scf_feedback', { type: 'item', id }, { helped, wrong });
      result.helped += helped;
      result.wrong += wrong;
    });
  }
  return result;
}
