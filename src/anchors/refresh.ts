import type { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkAnchor, fileLines, headReader, isManaged, rangeHash } from '../anchors.ts';
import { consented, loadConfig } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { sha256, type Anchor } from '../items.ts';
import { recordAudit } from '../store/audit.ts';
import { ProviderError, Refused, changesSince, resolveKey, type Changes, type Provider, type ProviderSymbol } from './provider.ts';

/** Why an item is stale because of its symbol anchor; only these are the refresh's to restore. */
const REASONS = ['path gone', 'cited text gone', 'signature changed', 'key gone', 'snapshot not at HEAD'];

/** A body smaller than this many tokens is never moved onto: the same few tokens sit under many names (ProofMesh's `too_small`). */
export const MIN_MOVE_TOKENS = 10;
const tokenCount = (text: string): number => (text.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) ?? []).length;

/** Anchors resolved in one run; the rest wait for the next. */
export const ANCHORS_PER_RUN = 50;

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

const flags = (data: string): Record<string, boolean> => {
  try {
    return JSON.parse(readFileSync(stateFile(data), 'utf8')) as Record<string, boolean>;
  } catch {
    return {};
  }
};

/**
 * Whether the hooks' path check leaves `repository`'s provider-managed anchors to the refresh job: a provider is configured
 * and its last run for this repository succeeded. With no run yet, after a failure of any kind, or with no provider, every
 * anchor is checked by path and hash.
 */
export function managedBy(data: string, repository: string | null): boolean {
  try {
    return repository !== null && providerConfig(data) !== undefined && flags(data)[repository] === false;
  } catch {
    return false;
  }
}

/** Records whether the last run for `repository` failed; other repositories' flags are never touched. */
export function setProviderFailed(data: string, repository: string, failed: boolean): void {
  writeFileSync(stateFile(data), JSON.stringify({ ...flags(data), [repository]: failed }), { mode: 0o600 });
}

/** Runs `work` under a lock file naming this process; undefined when another live process holds it. A dead holder's lock is taken over. */
export async function withJobLock<T>(lock: string, work: () => Promise<T>): Promise<T | undefined> {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch {
      const pid = Number(readFileSync(lock, 'utf8'));
      let alive = true;
      try {
        // An empty file is a lock being written: held.
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive || attempt >= 3) return undefined;
      try {
        unlinkSync(lock);
      } catch {
        // taken over by someone else: loop and look again
      }
    }
  }
  try {
    return await work();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

export function logAnchors(data: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(anchorLog(data)), { recursive: true, mode: 0o700 });
  appendFileSync(anchorLog(data), `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, { mode: 0o600 });
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
    ...(symbol.signature === undefined ? {} : { signature: symbol.signature }),
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
  /** Items with a provider-managed anchor looked at this run. */
  examined: number;
  checked: number;
  current: number;
  moved: number;
  stale: number;
  restored: number;
  skipped: number;
  /** Items not looked at because the run reached its limit. */
  left: number;
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

/** The added symbols of one answer, indexed once by kind and hash and by name, not filtered per anchor. */
const indexes = new WeakMap<Changes, { byHash: Map<string, ProviderSymbol[]>; byName: Map<string, ProviderSymbol[]> }>();
function indexOf(c: Changes) {
  let i = indexes.get(c);
  if (i === undefined) {
    i = { byHash: new Map(), byName: new Map() };
    const push = (m: Map<string, ProviderSymbol[]>, k: string, s: ProviderSymbol): void => void m.set(k, [...(m.get(k) ?? []), s]);
    for (const s of c.added) {
      push(i.byHash, `${parts(s.key).kind}\0${s.hash}`, s);
      push(i.byName, parts(s.key).name, s);
    }
    indexes.set(c, i);
  }
  return i;
}

/** A snapshot is at HEAD when it names the commit and the commit is HEAD's. */
export const atHead = (head: string, commit: string | undefined): boolean => commit !== undefined && commit.length >= 7 && head.startsWith(commit);

/**
 * Follows the symbol anchors of `repository` in `tenant` to the code at HEAD of the checkout at `cwd`, asking `provider`.
 * For each snapshot the anchors were last made at, it asks what changed since and re-resolves only anchors in the files
 * named (all of them when the provider no longer holds that snapshot). Each item is written as it resolves, under `lock`,
 * so progress accumulates; a run resolves at most `limit` anchors and says what it left. The provider is asked first and
 * the store written after, so a slow provider never holds the store. A request the provider refuses skips that anchor
 * (`log`); any other provider failure ends the run, having changed nothing further, and is thrown.
 */
export async function refreshAnchors(
  db: DatabaseSync,
  tenant: string,
  repository: string,
  cwd: string,
  provider: Provider,
  lock: <T>(work: () => T) => T | undefined,
  { limit = ANCHORS_PER_RUN, log = () => undefined }: { limit?: number; log?: (event: Record<string, unknown>) => void } = {},
): Promise<Refresh> {
  const result: Refresh = { examined: 0, checked: 0, current: 0, moved: 0, stale: 0, restored: 0, skipped: 0, left: 0 };
  const rows = (
    db
      .prepare(
        `SELECT id, status, status_reason, anchors_json FROM items
         WHERE tenant = ? AND scope = 'repository' AND scope_key = ? AND anchors_json != '[]' AND status IN ('active', 'stale') ORDER BY id`,
      )
      .all(tenant, repository) as unknown as Row[]
  ).filter((r) => (r.status === 'active' || REASONS.includes(r.status_reason ?? '')) && (JSON.parse(r.anchors_json) as Anchor[]).some(isManaged));
  result.examined = rows.length;
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

  async function resolve(a: Anchor, c: Changes, undone: Set<string>): Promise<Outcome> {
    // The same snapshot, or a file nothing changed in, is what it was.
    if (c.sinceFound && (c.snapshot === a.snapshot || !c.files.includes(a.path))) return { kind: 'keep' };
    const { symbol, snapshot, commit: at } = await resolveKey(provider, a.symbol!);
    if (symbol !== null) {
      if (a.signature !== undefined && symbol.signature !== undefined && symbol.signature !== a.signature) return { kind: 'stale', reason: 'signature changed', candidates: [] };
      // Hashes are computed from HEAD's file, so only a snapshot of HEAD may supply the lines.
      if (!atHead(commit, at)) return { kind: 'keep' };
      const text = read.text(parts(symbol.key).path);
      if (text === undefined) return { kind: 'keep' };
      const held = checkAnchor({ path: parts(symbol.key).path, start: symbol.start, end: symbol.end, ...(a.citedHash === undefined ? {} : { citedHash: a.citedHash }) }, text, 0);
      const now = held.ok ? symbolAnchor(symbol, snapshot, text, a.commit) : null;
      return now === null ? { kind: 'stale', reason: text === null ? 'path gone' : 'cited text gone', candidates: [] } : { kind: 'current', anchor: { ...now, commit: a.commit ?? commit } };
    }
    // The key is gone: a symbol added since that is the same declaration under another name or path is the same code.
    const kind = parts(a.symbol!).kind;
    const idx = indexOf(c);
    const same = c.sinceFound ? idx.byHash.get(`${kind}\0${a.contentHash}`) ?? [] : [];
    const named = c.sinceFound ? (idx.byName.get(parts(a.symbol!).name) ?? []).filter((x) => !same.includes(x)) : [];
    const candidates = (same.length > 0 ? same : named).map((x) => x.key);
    if (same.length === 1 && !undone.has(a.symbol!)) {
      if (!atHead(commit, c.commit)) return { kind: 'stale', reason: 'snapshot not at HEAD', candidates };
      const text = read.text(parts(same[0]!.key).path);
      const small = typeof text === 'string' && tokenCount(fileLines(text).slice(same[0]!.start - 1, same[0]!.end).join('\n')) < MIN_MOVE_TOKENS;
      const to = small ? null : symbolAnchor(same[0]!, c.snapshot, text, commit);
      if (to !== null) return { kind: 'move', anchor: to };
    }
    return { kind: 'stale', reason: 'key gone', candidates };
  }

  const touch = db.prepare('UPDATE items SET anchors_json = ? WHERE id = ? AND anchors_json = ?');
  let attempts = 0;
  for (const row of rows) {
    const anchors = JSON.parse(row.anchors_json) as Anchor[];
    if (attempts >= limit) {
      result.left++;
      continue;
    }
    const undone = undoneFrom(db, row.id);
    const outcomes: Outcome[] = [];
    let skipped = false;
    for (const a of anchors) {
      if (!isManaged(a)) {
        outcomes.push({ kind: 'keep' });
        continue;
      }
      const c = await since(a.snapshot);
      try {
        const o = await resolve(a, c, undone);
        if (o.kind !== 'keep') attempts++;
        outcomes.push(o);
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        log({ event: 'anchor_skipped', item: row.id, reason: error.message });
        skipped = true;
        outcomes.push({ kind: 'keep' });
      }
    }
    if (skipped) result.skipped++;
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
        } else if (row.status === 'stale' && !managedKept && moves.length === 0) {
          // A move is a new anchor, not the owner's yes: only a citation that holds again brings an item back.
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
  if (result.left > 0) log({ event: 'capped', done: attempts, left: result.left });
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
 * that key as the provider describes it now, compared and set against the anchor that was read, under the refresh lock;
 * the move is logged and can be undone. The item comes back only when no other anchor on it is stale.
 */
export async function adoptCandidate(
  db: DatabaseSync,
  id: string,
  key: string,
  cwd: string,
  provider: Provider,
  lock: <T>(work: () => T) => T | undefined,
): Promise<string> {
  const row = db.prepare("SELECT status, status_reason, anchors_json FROM items WHERE id = ? AND status IN ('active', 'stale')").get(id) as Row | undefined;
  const anchors = row === undefined ? [] : (JSON.parse(row.anchors_json) as Anchor[]);
  const at = anchors.findIndex((a) => a.candidates?.includes(key) === true);
  if (row === undefined || at < 0) throw new ProviderError(`${id} has no re-anchor proposal naming ${key}`);
  const read = headReader(cwd);
  const head = read.head();
  const { symbol, snapshot, commit } = await resolveKey(provider, key);
  if (head === null || !atHead(head, commit)) throw new ProviderError("the provider's snapshot is not at HEAD, so its lines cannot be anchored; try again after it indexes HEAD");
  const to = symbol === null ? null : symbolAnchor(symbol, snapshot, read.text(parts(key).path), anchors[at]!.commit);
  if (to === null) throw new ProviderError(`the provider no longer finds ${key}`);
  const from = anchors[at]!;
  const { candidates: _drop, ...old } = from;
  const next = anchors.map((a, i) => (i === at ? to : a));
  const blocked = anchors.some((a, i) => i !== at && ((a.candidates?.length ?? 0) > 0 || (!isManaged(a) && !checkAnchor(a, read.text(a.path) ?? null).ok)));
  const done = lock(() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Compare and set: an item that changed while the provider was answering is not touched.
      if (db.prepare('UPDATE items SET anchors_json = ? WHERE id = ? AND anchors_json = ?').run(JSON.stringify(next), id, row.anchors_json).changes !== 1) {
        db.exec('ROLLBACK');
        return false;
      }
      if (row.status === 'stale' && !blocked) db.prepare("UPDATE items SET status = 'active', status_reason = NULL WHERE id = ? AND status = 'stale'").run(id);
      recordAudit(db, 'anchor_moved', { type: 'item', id }, { symbol: true, from: old, to, adopted: true });
      db.exec('COMMIT');
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  if (done === undefined) throw new ProviderError('a refresh is running; try again in a moment');
  if (done === false) throw new ProviderError(`${id} changed while the provider was answering; nothing was changed`);
  return `${id} is anchored to ${key}${blocked ? '; another of its anchors is still stale, so it stays stale' : ''}`;
}
