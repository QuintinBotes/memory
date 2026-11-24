import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { git, matchingTenants, parseGitHubRemote } from '../context.ts';
import { safe } from '../render/rows.ts';
import { taintList, type Anchor } from '../items.ts';

/**
 * A read-only Markdown export of one tenant's store and the person file (#27). Nothing reads it back. Every
 * string from a store goes out as a code span, so no viewer turns it into a link, an image or HTML, and the
 * text of a quarantined item or a tombstone is never written. Deterministic: sorted, no clock, no random.
 */

interface ItemRow {
  id: string;
  scope: string;
  scope_key: string;
  type: string;
  statement: string;
  statement_key: string | null;
  rationale: string | null;
  status: string;
  status_reason: string | null;
  origin_trust: string;
  quarantine: string | null;
  anchors_json: string;
  support: number;
  helped: number;
  wrong: number;
  contradictions: number;
  stale_reports: number;
  valid_from: string;
  valid_to: string | null;
  supersedes: string | null;
  promoted_to: string | null;
}

interface EvidenceRow {
  source_ref: string;
  author_role: string;
  captured_at: string;
  taint: string | null;
}

const STATUS_ORDER = ['active', 'proposed', 'stale', 'superseded', 'promoted', 'closed', 'rejected', 'expired'];
const COLUMNS = `id, scope, scope_key, type, statement, statement_key, rationale, status, status_reason, origin_trust, quarantine,
  anchors_json, support, helped, wrong, contradictions, stale_reports, valid_from, valid_to, supersedes, promoted_to`;

/** Text as a code span: literal in every Markdown viewer, whatever it holds. */
export function span(text: string): string {
  const s = safe(text);
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks} ${s} ${ticks}`;
}

const anchorLine = (a: Anchor): string => {
  const where = a.symbol !== undefined ? a.symbol : a.start === undefined ? a.path : `${a.path}:${a.start}${a.end === undefined || a.end === a.start ? '' : `-${a.end}`}`;
  return `- ${span(where)}${a.commit === undefined ? '' : ` at ${span(a.commit)}`}${a.citedHash === undefined ? '' : `, cited hash ${span(a.citedHash)}`}`;
};

const link = (id: string): string => {
  const clean = id.replace(/[^\w-]/g, '_');
  return `[${clean}](${clean}.md)`;
};
const where = (r: ItemRow): string => (r.scope_key === '' ? r.scope : `${r.scope} ${r.scope_key}`);

function itemFile(r: ItemRow, evidence: EvidenceRow[], supersededBy: string[]): string {
  const tombstone = r.statement === '';
  const quarantined = r.quarantine !== null;
  const lines = [`# ${r.id}`, '', `- type: ${span(r.type)}`, `- scope: ${span(where(r))}`, `- status: ${span(r.status)}`];
  if (r.status_reason !== null) lines.push(`- why: ${span(r.status_reason)}`);
  lines.push(`- trust: ${span(r.origin_trust)}`);
  if (quarantined) lines.push(`- quarantined: ${span(r.quarantine!)}`);
  lines.push(`- valid from: ${span(r.valid_from)}`);
  if (r.valid_to !== null) lines.push(`- valid to: ${span(r.valid_to)}`);
  if (r.supersedes !== null) lines.push(`- supersedes: ${link(r.supersedes)}`);
  if (supersededBy.length > 0) lines.push(`- superseded by: ${supersededBy.map(link).join(', ')}`);
  if (r.promoted_to !== null) lines.push(`- promoted to: ${span(r.promoted_to)}`);
  lines.push(`- support: ${r.support}, helped ${r.helped}, wrong ${r.wrong}, contradictions ${r.contradictions}, stale reports ${r.stale_reports}`, '');
  if (tombstone) {
    lines.push('Tombstone: the text was removed.', '', `- statement hash: ${span(r.statement_key ?? '')}`);
    return `${lines.join('\n')}\n`;
  }
  if (quarantined) {
    lines.push('Statement withheld: quarantined as text that reads as an instruction.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('## Statement', '', span(r.statement), '');
  if (r.rationale !== null) lines.push('## Rationale', '', span(r.rationale), '');
  const anchors = JSON.parse(r.anchors_json) as Anchor[];
  if (anchors.length > 0) lines.push('## Anchors', '', ...anchors.map(anchorLine), '');
  lines.push('## Evidence', '');
  for (const e of evidence) {
    lines.push(`- ${span(e.source_ref)}, ${span(e.author_role)}, captured ${span(e.captured_at)}${e.taint === null ? '' : `, tainted by ${span(taintList(e.taint))}`}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Items of `tenant` ('' for the person file) in id order, each with its evidence: two queries, not one per item. */
function read(db: DatabaseSync, tenant: string): { row: ItemRow; evidence: EvidenceRow[] }[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM items WHERE tenant = ? ORDER BY id`).all(tenant) as unknown as ItemRow[];
  const evidence = db
    .prepare('SELECT item_id, source_ref, author_role, captured_at, taint FROM evidence WHERE item_id IN (SELECT id FROM items WHERE tenant = ?) ORDER BY item_id, captured_at, source_ref, author_role, taint, id')
    .all(tenant) as unknown as (EvidenceRow & { item_id: string })[];
  const byItem = new Map<string, EvidenceRow[]>();
  for (const e of evidence) byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), e]);
  return rows.map((row) => ({ row, evidence: byItem.get(row.id) ?? [] }));
}

/** Writes only when the content differs, so an unchanged export touches no file. */
function writeIfChanged(path: string, content: string, mayExist: boolean): void {
  if (mayExist) {
    try {
      if (readFileSync(path, 'utf8') === content) return;
    } catch {
      // unreadable: write it
    }
  }
  writeFileSync(path, content);
}

/** Writes `index.md` and `items/<id>.md` under `dir`, replacing a previous export there; returns the number of items. */
export function exportMarkdown(stores: { db: DatabaseSync; tenant: string }[], dir: string): number {
  const all = stores.flatMap(({ db, tenant }) => read(db, tenant)).sort((a, b) => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  const successors = new Map<string, string[]>();
  for (const { row } of all) if (row.supersedes !== null) successors.set(row.supersedes, [...(successors.get(row.supersedes) ?? []), row.id]);

  const items = join(dir, 'items');
  mkdirSync(items, { recursive: true });
  // Only files the previous export listed in its index are ours to remove; anything else in items/ belongs to the user.
  const current = new Set(all.map((a) => a.row.id));
  let previous = '';
  try {
    previous = readFileSync(join(dir, 'index.md'), 'utf8');
  } catch {
    // no previous export
  }
  const listed = new Set([...previous.matchAll(/\]\(items\/([^/\\)]+)\.md\)/g)].map((m) => m[1]!));
  for (const id of listed) if (!current.has(id)) rmSync(join(items, `${id}.md`), { force: true });
  // A file the previous export did not list may still exist (a user's, or one the index no longer names), so it is compared too.
  for (const { row, evidence } of all) writeIfChanged(join(items, `${row.id}.md`), itemFile(row, evidence, successors.get(row.id) ?? []), listed.size > 0);

  const index = ['# Memory export', '', 'Read only: editing these files changes nothing in memory.', ''];
  const statuses = [...new Set(all.map((a) => a.row.status))].sort((a, b) => (STATUS_ORDER.indexOf(a) + 1 || 99) - (STATUS_ORDER.indexOf(b) + 1 || 99) || (a < b ? -1 : 1));
  for (const status of statuses) {
    const group = all.filter((a) => a.row.status === status);
    index.push(`## ${status} (${group.length})`, '');
    for (const { row } of group) index.push(`- [${row.id}](items/${row.id}.md) ${span(row.type)} ${span(where(row))}`);
    index.push('');
  }
  writeIfChanged(join(dir, 'index.md'), `${index.join('\n')}\n`, previous !== '');
  return all.length;
}

/** Why `dir` may not receive this tenant's export: it lies inside a git repository that belongs to another tenant, or null. */
export function foreignRepository(dir: string, config: Config, tenant: string): string | null {
  let at = resolve(dir);
  while (!existsSync(at)) at = dirname(at);
  const top = git(at, 'rev-parse', '--show-toplevel')?.trim();
  if (top === undefined) return null;
  const url = git(top, 'config', '--get', 'remote.origin.url');
  const parsed = url === null ? null : parseGitHubRemote(url);
  if (parsed === null) return null;
  const other = matchingTenants(config, parsed.owner, parsed.repo).filter((t) => t !== tenant);
  return other.length === 0 ? null : `${top} is a repository of tenant ${other[0]}`;
}
