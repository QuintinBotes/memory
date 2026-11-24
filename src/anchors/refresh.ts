import type { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkAnchor, fileLines, headReader, isManaged, rangeHash } from '../anchors.ts';
import { consented, loadConfig } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { sha256, type Anchor } from '../items.ts';
import { recordAudit } from '../store/audit.ts';
import { ProviderError, changesSince, resolveKey, type Changes, type Provider, type ProviderSymbol } from './provider.ts';

/** Why an item is stale because of its symbol anchor; only these are the refresh's to restore. */
const REASONS = ['path gone', 'cited text gone', 'signature changed', 'key gone'];

/** `path#qualified_name#kind` as its three parts. */
const parts = (key: string): { path: string; name: string; kind: string } => {
  const [path = '', name = '', kind = ''] = key.split('#');
  return { path, name, kind };
};

const stateFile = (data: string): string => join(data, 'anchors-state.json');
export const anchorLog = (data: string): string => join(data, 'logs', 'anchors.jsonl');

/** The configured provider, when the owner has agreed to the plan that lists it. */
export function providerConfig(data: string): { command: string[] } | undefined {
  const config = loadConfig(data);
  return consented(config) && covers(config, 'symbols') ? config.impactProvider : undefined;
}

/**
 * Whether the hooks' path check leaves provider-managed anchors to the refresh job: a provider is configured and its last
 * run did not fail. After a failure, or with no provider, every anchor is checked by path and hash.
 */
export function managedBy(data: string): boolean {
  try {
    if (providerConfig(data) === undefined) return false;
    return !existsSync(stateFile(data)) || (JSON.parse(readFileSync(stateFile(data), 'utf8')) as { providerFailed?: boolean }).providerFailed !== true;
  } catch {
    return false;
  }
}

export function logAnchors(data: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(anchorLog(data)), { recursive: true, mode: 0o700 });
  appendFileSync(anchorLog(data), `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}
export function setProviderFailed(data: string, failed: boolean): void {
  writeFileSync(stateFile(data), JSON.stringify({ providerFailed: failed }), { mode: 0o600 });
}

/** The anchor for `symbol` as the file at HEAD holds it, or null when the file or the lines are not there. */
export function symbolAnchor(symbol: ProviderSymbol, snapshot: string, text: string | null | undefined, commit: string | undefined): Anchor | null {
  if (text === null || text === undefined) return null;
  const lines = fileLines(text);
  if (symbol.end > lines.length) return null;
  return {
    path: parts(symbol.key).path,
    start: symbol.start,
    end: symbol.end,
    ...(commit === undefined ? {} : { commit }),
    citedHash: rangeHash(lines, symbol.start, symbol.end),
    symbol: symbol.key,
    signature: symbol.signature,
    contentHash: symbol.hash,
    fileHash: sha256(text),
    snapshot,
  };
}

type Outcome =
  | { kind: 'keep' }
  | { kind: 'current'; anchor: Anchor }
  | { kind: 'move'; anchor: Anchor }
  | { kind: 'stale'; reason: string; candidates: string[] };

export interface Refresh {
  checked: number;
  current: number;
  moved: number;
  stale: number;
  restored: number;
}

interface Row {
  id: string;
  status: string;
  status_reason: string | null;
  anchors_json: string;
}

/** Keys of moves the owner undid for an item: memory never makes the same move again. */
function undoneFrom(db: DatabaseSync, id: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT m.metadata_json FROM audit_events u JOIN audit_events m ON m.audit_id = u.subject_id
       WHERE u.action = 'undone' AND m.action = 'anchor_moved' AND m.subject_id = ?`,
    )
    .all(id) as { metadata_json: string }[];
  return new Set(rows.flatMap((r) => ((JSON.parse(r.metadata_json) as { from?: Anchor }).from?.symbol ?? [])));
}

/**
 * Follows the symbol anchors of `repository` in `tenant` to the code at HEAD of the checkout at `cwd`, asking `provider`.
 * For each snapshot the anchors were last made at, it asks what changed since and re-resolves only anchors in the files
 * named (all of them when the provider no longer holds that snapshot). The provider is asked first and the store written
 * after, under `lock`, so a slow provider never holds the store. Throws ProviderError, having changed nothing, when the
 * provider fails; an answer about another repository is dropped by the provider client before it is read.
 */
export async function refreshAnchors(
  db: DatabaseSync,
  tenant: string,
  repository: string,
  cwd: string,
  provider: Provider,
  lock: <T>(work: () => T) => T | undefined,
): Promise<Refresh> {
  const result: Refresh = { checked: 0, current: 0, moved: 0, stale: 0, restored: 0 };
  const rows = (
    db
      .prepare(
        `SELECT id, status, status_reason, anchors_json FROM items
         WHERE tenant = ? AND scope = 'repository' AND scope_key = ? AND anchors_json != '[]' AND status IN ('active', 'stale') ORDER BY id`,
      )
      .all(tenant, repository) as unknown as Row[]
  ).filter((r) => (r.status === 'active' || REASONS.includes(r.status_reason ?? '')) && (JSON.parse(r.anchors_json) as Anchor[]).some(isManaged));
  if (rows.length === 0) return result;
  const read = headReader(cwd);
  const head = read.head();
  if (head === null) return result;
  const commit: string = head;

  const changes = new Map<string, Changes>();
  const since = async (snapshot: string): Promise<Changes> => {
    if (!changes.has(snapshot)) changes.set(snapshot, await changesSince(provider, snapshot));
    return changes.get(snapshot)!;
  };

  const plans: { row: Row; outcomes: Outcome[]; undone: Set<string> }[] = [];
  for (const row of rows) {
    const anchors = JSON.parse(row.anchors_json) as Anchor[];
    const undone = undoneFrom(db, row.id);
    const outcomes: Outcome[] = [];
    for (const a of anchors) outcomes.push(isManaged(a) ? await resolve(a, await since(a.snapshot!), undone) : { kind: 'keep' });
    plans.push({ row, outcomes, undone });
  }

  async function resolve(a: Anchor, c: Changes, undone: Set<string>): Promise<Outcome> {
    // The same snapshot, or a file nothing changed in, is what it was.
    if (c.sinceFound && (c.snapshot === a.snapshot || !c.files.includes(a.path))) return { kind: 'keep' };
    const { symbol, snapshot } = await resolveKey(provider, a.symbol!);
    if (symbol !== null) {
      if (symbol.signature !== a.signature) return { kind: 'stale', reason: 'signature changed', candidates: [] };
      const text = read.text(parts(symbol.key).path);
      if (text === undefined) return { kind: 'keep' };
      const held = checkAnchor({ path: parts(symbol.key).path, start: symbol.start, end: symbol.end, ...(a.citedHash === undefined ? {} : { citedHash: a.citedHash }) }, text, 0);
      const now = held.ok ? symbolAnchor(symbol, snapshot, text, a.commit) : null;
      return now === null ? { kind: 'stale', reason: text === null ? 'path gone' : 'cited text gone', candidates: [] } : { kind: 'current', anchor: { ...now, commit: a.commit ?? commit! } };
    }
    // The key is gone: a symbol added since that is the same declaration under another name or path is the same code.
    const kind = parts(a.symbol!).kind;
    const added = c.sinceFound ? c.added.filter((x) => x.kind === kind) : [];
    const same = added.filter((x) => x.hash === a.contentHash);
    const named = (c.sinceFound ? c.added : []).filter((x) => parts(x.key).name === parts(a.symbol!).name && !same.includes(x));
    if (same.length === 1 && !undone.has(a.symbol!)) {
      const to = symbolAnchor(same[0]!, c.snapshot, read.text(parts(same[0]!.key).path), commit);
      if (to !== null) return { kind: 'move', anchor: to };
    }
    const candidates = (same.length > 0 ? same : named).map((x) => x.key);
    return { kind: 'stale', reason: 'key gone', candidates };
  }

  const touch = db.prepare('UPDATE items SET anchors_json = ? WHERE id = ? AND anchors_json = ?');
  for (const { row, outcomes } of plans) {
    const anchors = JSON.parse(row.anchors_json) as Anchor[];
    // Anchors the provider does not own are checked by path, as the hooks do.
    const rest = anchors.map((a) => (isManaged(a) ? null : checkAnchor(a, read.text(a.path) ?? null)));
    if (outcomes.every((o) => o.kind === 'keep') && rest.every((r) => r === null)) continue;
    result.checked++;
    const managedKept = anchors.some((a, i) => outcomes[i]!.kind === 'keep' && isManaged(a));
    const failed = outcomes.findIndex((o) => o.kind === 'stale');
    const restFailed = rest.findIndex((r) => r !== null && !r.ok);
    const next = anchors.map((a, i): Anchor => {
      const o = outcomes[i]!;
      const { candidates: _drop, ...clean } = a;
      if (o.kind === 'current' || o.kind === 'move') return o.anchor;
      if (o.kind === 'stale') return o.candidates.length === 0 ? clean : { ...clean, candidates: o.candidates };
      const r = rest[i];
      return r?.ok === true ? r.anchor : isManaged(a) ? a : clean;
    });
    const reason = failed >= 0 ? (outcomes[failed] as Extract<Outcome, { kind: 'stale' }>).reason : restFailed >= 0 ? (rest[restFailed] as { ok: false; reason: string }).reason : null;
    const moves = outcomes.flatMap((o, i) => (o.kind === 'move' ? [{ from: anchors[i]!, to: o.anchor }] : []));
    const written = JSON.stringify(next);
    const done = lock(() => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const now = db.prepare('SELECT status, status_reason FROM items WHERE id = ?').get(row.id) as { status: string; status_reason: string | null } | undefined;
        // Skipped, not forced, when the item changed since it was read: the next refresh looks again.
        const same = now !== undefined && now.status === row.status && touch.run(written, row.id, row.anchors_json).changes === 1;
        if (!same) return db.exec('ROLLBACK');
        for (const m of moves) recordAudit(db, 'anchor_moved', { type: 'item', id: row.id }, { symbol: true, from: m.from, to: m.to });
        if (reason !== null) {
          if (row.status === 'active') {
            db.prepare("UPDATE items SET status = 'stale', status_reason = ? WHERE id = ? AND status = 'active'").run(reason, row.id);
            recordAudit(db, 'item_stale', { type: 'item', id: row.id }, { reason });
          } else if (row.status_reason !== reason) {
            db.prepare("UPDATE items SET status_reason = ? WHERE id = ? AND status = 'stale'").run(reason, row.id);
          }
        } else if (row.status === 'stale' && !managedKept) {
          db.prepare("UPDATE items SET status = 'active', status_reason = NULL WHERE id = ? AND status = 'stale'").run(row.id);
          recordAudit(db, 'item_restored', { type: 'item', id: row.id });
          result.restored++;
        }
        db.exec('COMMIT');
        return true;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    if (done !== true) continue;
    if (reason !== null) result.stale++;
    else result.current++;
    result.moved += moves.length;
  }
  return result;
}

/**
 * `memory anchors undo <move-id>`: puts the anchor an automatic move replaced back, exactly, and logs the undo. Returns a
 * line for the owner, or false when the id is not a symbol move here, was already undone, or its item no longer holds the
 * moved anchor.
 */
export function undoMove(db: DatabaseSync, moveId: string): string | false {
  const e = db.prepare("SELECT subject_id, metadata_json FROM audit_events WHERE audit_id = ? AND action = 'anchor_moved'").get(moveId) as { subject_id: string; metadata_json: string } | undefined;
  const m = e === undefined ? undefined : (JSON.parse(e.metadata_json) as { symbol?: boolean; from?: Anchor; to?: Anchor });
  if (e === undefined || m?.symbol !== true || m.from === undefined || m.to === undefined) return false;
  if (db.prepare("SELECT 1 FROM audit_events WHERE action = 'undone' AND subject_id = ?").get(moveId) !== undefined) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = db.prepare("SELECT anchors_json FROM items WHERE id = ? AND status IN ('active', 'stale')").get(e.subject_id) as { anchors_json: string } | undefined;
    const anchors = item === undefined ? [] : (JSON.parse(item.anchors_json) as Anchor[]);
    const at = anchors.findIndex((a) => a.symbol === m.to!.symbol);
    if (at < 0) {
      db.exec('ROLLBACK');
      return false;
    }
    anchors[at] = m.from;
    db.prepare('UPDATE items SET anchors_json = ? WHERE id = ?').run(JSON.stringify(anchors), e.subject_id);
    recordAudit(db, 'undone', { type: 'audit', id: moveId }, { action: 'anchor_moved', item: e.subject_id });
    db.exec('COMMIT');
    return `${e.subject_id} is anchored to ${m.from.symbol} again`;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * `memory anchors adopt <item-id> <key>`: the owner's yes to one candidate of a re-anchor proposal. The anchor moves to
 * that key as the provider describes it now, the move is logged and can be undone, and the item is current again.
 */
export async function adoptCandidate(db: DatabaseSync, id: string, key: string, cwd: string, provider: Provider): Promise<string> {
  const row = db.prepare("SELECT status, anchors_json FROM items WHERE id = ? AND status IN ('active', 'stale')").get(id) as { status: string; anchors_json: string } | undefined;
  const anchors = row === undefined ? [] : (JSON.parse(row.anchors_json) as Anchor[]);
  const at = anchors.findIndex((a) => a.candidates?.includes(key) === true);
  if (row === undefined || at < 0) throw new ProviderError(`${id} has no re-anchor proposal naming ${key}`);
  const read = headReader(cwd);
  const { symbol, snapshot } = await resolveKey(provider, key);
  const to = symbol === null ? null : symbolAnchor(symbol, snapshot, read.text(parts(key).path), anchors[at]!.commit);
  if (to === null) throw new ProviderError(`the provider no longer finds ${key}`);
  const from = anchors[at]!;
  const { candidates: _drop, ...old } = from;
  anchors[at] = to;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE items SET anchors_json = ?, status = 'active', status_reason = NULL WHERE id = ?").run(JSON.stringify(anchors), id);
    recordAudit(db, 'anchor_moved', { type: 'item', id }, { symbol: true, from: old, to, adopted: true });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return `${id} is anchored to ${key}`;
}
