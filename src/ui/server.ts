import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { consented, currentConfigDir, loadConfig, organisationTerms, type Config } from '../config.ts';
import { supersedeNow } from '../consolidate.ts';
import { resolveContext, type Context } from '../context.ts';
import { embedAfterWrite } from '../embed/vectors.ts';
import { Refusal, refusal } from '../gate.ts';
import { applyEdit, displayPath, edits, loadInstructions, rejectEdit } from '../instructions.ts';
import { SCOPES, type Anchor, type NewItem, type Scope } from '../items.ts';
import { itemDetail, searchHits, stores } from '../mcp/server.ts';
import { visibleItems } from '../recall/visible.ts';
import { safeJson } from '../render/rows.ts';
import { decideById, proposalStores, proposals, shadow } from '../review/review.ts';
import { recordAudit } from '../store/audit.ts';
import { openStore } from '../store/db.ts';
import { PAGE } from './page.ts';

/**
 * `memory ui`: one local page over the same store code the CLI and the MCP server use. It listens on 127.0.0.1 only and
 * answers only a loopback peer that names 127.0.0.1:<port> as its Host (no DNS rebinding) and carries this run's token,
 * printed once to the owner's terminal. A write also needs this page's own Origin and a JSON body (no cross-site form).
 */

export const UI_HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const loopback = (address: string | undefined): boolean => address !== undefined && (/^127\./.test(address) || address === '::1' || /^::ffff:127\./.test(address));

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new HttpError(413, 'the request is too large'));
      else chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'the body is a JSON object'));
      }
    });
  });
}

function text(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, `${key} is a non-empty string`);
  return v.trim();
}

/** Each version of `id`'s supersession chain, oldest first, with who or what made it (evidence, audit) and why it ended. */
function history(store: ReturnType<typeof stores>[number], id: string) {
  const db = openStore(store.file, false)!;
  try {
    const one = db.prepare(`SELECT id, statement, rationale, status, status_reason, valid_from, valid_to FROM items WHERE id = ? AND ${store.where}`);
    const olderOf = db.prepare(`SELECT id FROM items WHERE status = 'superseded' AND status_reason = ? AND ${store.where} ORDER BY created_at, id`);
    type Version = { id: string; statement: string; rationale: string | null; status: string; status_reason: string | null; valid_from: string; valid_to: string | null };
    const get = (key: string): Version | undefined => one.get(key, ...store.params) as Version | undefined;
    const seen = new Set([id]);
    let top = get(id)!;
    for (;;) {
      const next = top.status === 'superseded' && top.status_reason?.startsWith('superseded by ') ? top.status_reason.slice('superseded by '.length) : null;
      const newer = next === null || seen.has(next) ? undefined : get(next);
      if (newer === undefined) break;
      seen.add(newer.id);
      top = newer;
    }
    const chain = [top];
    for (;;) {
      const older = olderOf.get(`superseded by ${chain[0]!.id}`, ...store.params) as { id: string } | undefined;
      if (older === undefined || chain.some((v) => v.id === older.id)) break;
      chain.unshift(get(older.id)!);
    }
    const evidence = db.prepare('SELECT source_ref AS source, author_role AS role, captured_at AS capturedAt FROM evidence WHERE item_id = ? ORDER BY captured_at, id');
    const audit = db.prepare('SELECT action, created_at AS at, metadata_json FROM audit_events WHERE subject_id = ? ORDER BY created_at, audit_id');
    return chain.map((v) => ({
      id: v.id, statement: v.statement, rationale: v.rationale, status: v.status, statusReason: v.status_reason, validFrom: v.valid_from, validTo: v.valid_to,
      evidence: evidence.all(v.id),
      audit: (audit.all(v.id) as { action: string; at: string; metadata_json: string }[]).map((a) => ({ action: a.action, at: a.at, metadata: JSON.parse(a.metadata_json) as unknown })),
    }));
  } finally {
    db.close();
  }
}

/** An edit is `memory remember --supersedes`: a new active item in the same store and scope, the prior one kept as superseded. */
async function edit(input: Record<string, unknown>, data: string, config: Config, context: Context): Promise<unknown> {
  const id = text(input, 'id');
  const statement = text(input, 'statement');
  for (const store of stores(data, context)) {
    const db = openStore(store.file, false);
    if (db === null) continue;
    try {
      const row = db.prepare(`SELECT * FROM items WHERE id = ? AND ${store.where} AND status = 'active'`).get(id, ...store.params) as
        | { scope: Scope; scope_key: string; type: string; rationale: string | null; anchors_json: string; origin_repository: string | null }
        | undefined;
      if (row === undefined) continue;
      const why = refusal(statement, store.tenant === '' ? organisationTerms(config, context.repository) : undefined, true);
      if (why !== null) throw new Refusal(`not saved: the statement is refused because ${why}`);
      const candidate: NewItem = {
        tenant: store.tenant, scope: row.scope, scopeKey: row.scope_key, type: row.type, statement, rationale: row.rationale,
        anchors: JSON.parse(row.anchors_json) as Anchor[], source: 'memory ui', originRepository: row.origin_repository,
      };
      const done = supersedeNow(db, candidate, id);
      if (done === null) continue;
      recordAudit(db, 'item_remembered', { type: 'item', id: done.id }, { scope: row.scope });
      await embedAfterWrite(db, config, store.tenant);
      return { id: done.id, message: `saved ${done.id}; it supersedes ${id}, which stays on record; undo with memory undo ${done.audit}` };
    } finally {
      db.close();
    }
  }
  throw new HttpError(404, `no active item ${id} here`);
}

/** The proposals and open instruction-file edits this repository may review: the page's data and memory review --json's (#104). */
export function reviewData(data: string, context: Context, cwd: string): { proposals: unknown[]; edits: unknown[] } {
  const ins = loadInstructions(cwd, currentConfigDir());
  const out = { proposals: [] as unknown[], edits: [] as unknown[] };
  for (const { file, tenant } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      out.proposals.push(...proposals(db, tenant).map((p) => ({ ...p, shadow: shadow(p).decision })));
      out.edits.push(...edits(db).filter((e) => e.status === 'open').map((e) => ({ ...e, file: displayPath(ins, e.file) })));
    } finally {
      db.close();
    }
  }
  return out;
}

/** `memory conflicts apply <id> --confirm` or `reject <id>`, the owner's click standing for the terminal confirmation. */
function conflict(input: Record<string, unknown>, data: string, context: Context, cwd: string): unknown {
  const id = text(input, 'id');
  const decision = input['decision'];
  if (decision !== 'apply' && decision !== 'reject') throw new HttpError(400, 'decision is apply or reject');
  for (const { file } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      const [e] = edits(db, id);
      if (e === undefined) continue;
      try {
        if (decision === 'reject') {
          rejectEdit(db, e);
          return { message: `resolved ${e.id}; no file was written` };
        }
        if (e.status !== 'open') throw new Error(`${e.id} is already ${e.status}`);
        return { message: applyEdit(db, loadInstructions(cwd, currentConfigDir()), e) };
      } catch (error) {
        throw new Refusal((error as Error).message);
      }
    } finally {
      db.close();
    }
  }
  throw new HttpError(404, `no edit ${id} here`);
}

async function answer(req: IncomingMessage, url: URL, data: string, cwd: string): Promise<unknown> {
  const config = loadConfig(data);
  if (!consented(config)) throw new HttpError(503, 'memory is not set up, or its configuration changed since you agreed to it; run memory init and confirm');
  // Per request, as the MCP server does: only the tenant this config binds for this repository, and the person file.
  const context = resolveContext(cwd, config, currentConfigDir());
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/items': {
      const query = url.searchParams.get('q')?.trim() ?? '';
      const row = (i: { id: string; type: string; scope: string; statement: string; source: string; taint?: string }, why = '') => ({ id: i.id, type: i.type, scope: i.scope, statement: i.statement, source: i.source, taint: i.taint ?? null, why });
      if (query === '') return { note: '', items: visibleItems(data, context, cwd, [], undefined, null).map((i) => row(i)) };
      const found = await searchHits(query, [], data, config, context, cwd, 'ui');
      return { note: found.note.trim(), items: found.hits.map((h) => row(h.item, h.why)) };
    }
    case 'GET /api/item': {
      const found = itemDetail(data, context, cwd, url.searchParams.get('id') ?? '');
      if (found === undefined) throw new HttpError(404, 'no such item here');
      // The stored statement as it is, for the edit field (the page sets it as a value, never as markup): a defanged one saved back would change it.
      return { raw: { statement: found.row.statement }, ...found.view, staleReports: (found.row as unknown as { stale_reports: number }).stale_reports, history: history(found.store, found.row.id) };
    }
    case 'GET /api/review':
      return reviewData(data, context, cwd);
    case 'POST /api/edit':
      return edit(await body(req), data, config, context);
    case 'POST /api/decide': {
      const input = await body(req);
      const id = text(input, 'id');
      const decision = input['decision'];
      if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'decision is approve or reject');
      const scope = input['scope'];
      if (scope !== undefined && !(SCOPES as readonly unknown[]).includes(scope)) throw new HttpError(400, `scope is one of ${SCOPES.join(', ')}`);
      const reason = input['reason'];
      if (reason !== undefined && typeof reason !== 'string') throw new HttpError(400, 'reason is a string');
      const done = await decideById(data, config, context, id, decision, { scope: scope as Scope | undefined, reason });
      if (done === null) throw new HttpError(404, `no proposal ${id} here`);
      return { message: done };
    }
    case 'POST /api/conflict':
      return conflict(await body(req), data, context, cwd);
    default:
      throw new HttpError(404, 'not found');
  }
}

/** Serves until the process is stopped. `port` 0 takes a free one; the URL with the token is printed once. */
export function serveUi(data: string, cwd: string, port: number): void {
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(16).toString('base64');
  // Only the test harness may stand in for a peer address no test can connect from.
  const peerOverride = process.env['MEMORY_TEST_HARNESS'] === '1' ? process.env['MEMORY_UI_PEER'] : undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, type: string, payload: string): void => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(payload);
    };
    // Every string is defanged as memory_get's are, except `raw`, which only an input's value takes.
    const json = (status: number, value: unknown): void => {
      const { raw, ...rest } = value as { raw?: unknown };
      send(status, 'application/json; charset=utf-8', raw === undefined ? safeJson(rest) : JSON.stringify({ ...(JSON.parse(safeJson(rest)) as object), raw }));
    };
    const origin = `http://${UI_HOST}:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? '/', origin);
    if (!loopback(peerOverride ?? req.socket.remoteAddress)) return json(403, { error: 'loopback only' });
    if (req.headers.host !== origin.slice('http://'.length)) return json(403, { error: `the Host must be ${origin.slice('http://'.length)}` });
    if (req.method === 'GET' && url.pathname === '/') {
      if (!sameToken(url.searchParams.get('t'), token)) return json(403, { error: 'open the address memory ui printed' });
      return send(200, 'text/html; charset=utf-8', PAGE(token, nonce));
    }
    if (!sameToken(req.headers['x-memory-token'], token)) return json(403, { error: 'no valid token' });
    if (req.method === 'POST' && (req.headers.origin !== origin || !/^application\/json\b/.test(req.headers['content-type'] ?? ''))) {
      return json(403, { error: 'a write comes from this page only' });
    }
    answer(req, url, data, cwd).then(
      (value) => json(200, value),
      (error: unknown) => {
        if (error instanceof HttpError) return json(error.status, { error: error.message });
        if (error instanceof Refusal) return json(409, { error: error.message });
        console.error(`memory ui: ${(error as Error).message}`);
        json(500, { error: 'memory could not answer this request' });
      },
    );
  });
  server.on('error', (error) => {
    console.error(`memory ui: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, UI_HOST, () => {
    console.log(`memory ui: http://${UI_HOST}:${(server.address() as AddressInfo).port}/?t=${token}`);
    console.error('Open that address in your browser; anyone with it can read and change this memory. Ctrl-C stops the server.');
  });
}
