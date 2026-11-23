import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { SILOS, organisationTerms, type Config } from '../config.ts';
import { matchingTenants, resolveContext } from '../context.ts';
import { namesOrganisation, refusal } from '../gate.ts';
import { addItem } from '../consolidate.ts';
import { insertItem, knownItem, quarantineOf, reduceTombstones, type Anchor, type NewItem } from '../items.ts';
import { openStore } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import { personFile, tenantFile } from '../store/paths.ts';
import { inside, markdown, notes, policy, rejections, symbolPath, type Parsed } from './silos.ts';

export interface ImportReport {
  dryRun: boolean;
  files: { path: string; statements: number }[];
  danglingLinks: { file: string; link: string }[];
  skippedFiles: { path: string; reason: string }[];
  /** By source and reason only: a reason never repeats the refused text. */
  refused: { source: string; reason: string }[];
  skippedNotes: number;
  proposed?: number;
  tombstones?: number;
  alreadyKnown?: number;
  /** Repeats of an item or proposal, attached to it as evidence. */
  merged?: number;
  /** Proposals stored as the replacement of an active item, for the owner to decide. */
  supersessions?: number;
  rejectedBefore?: number;
  /** Proposals stored quarantined: text from a non-owner source that reads as an instruction. */
  quarantined?: number;
}

type Candidate = NewItem & { status: 'proposed' | 'rejected' };

/**
 * The file at `path`, read only when it is a regular file whose real path
 * stays inside `root`; otherwise why not. A link inside its folder is read.
 */
function readInside(path: string, root: string): { text: string } | { reason: string } {
  try {
    if (!existsSync(path)) return { reason: 'not there' };
    const link = lstatSync(path).isSymbolicLink();
    const real = realpathSync(path);
    const top = realpathSync(root);
    if (!real.startsWith(top + sep)) return { reason: link ? 'a symbolic link outside its folder' : 'outside its folder' };
    if (!statSync(real).isFile()) return { reason: 'not a file' };
    return { text: readFileSync(real, 'utf8') };
  } catch (error) {
    return { reason: `cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

/** Repositories `text` names as owner/repo, each matching exactly one tenant. */
function namedRepositories(config: Config, text: string): Map<string, string> {
  const named = new Map<string, string>();
  const plain = text.replace(/https?:\/\/github\.com\//gi, ' ');
  for (const m of plain.matchAll(/(?<![\w./-])([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]*[a-z0-9_-])/gi)) {
    const [owner, repo] = [m[1]!.toLowerCase(), m[2]!.toLowerCase().replace(/\.git$/, '')];
    const tenants = matchingTenants(config, owner, repo);
    if (tenants.length === 1) named.set(`${owner}/${repo}`, tenants[0]!);
  }
  return named;
}

/**
 * Reads every silo and, unless `dryRun`, stores each statement it may store
 * as a proposal (a rejection as a tombstone). Nothing imported is active.
 */
export function importSilos(config: Config, data: string, configDir: string, dryRun: boolean): ImportReport {
  const report: ImportReport = { dryRun, files: [], danglingLinks: [], skippedFiles: [], refused: [], skippedNotes: 0 };
  const candidates: Candidate[] = [];
  const terms = organisationTerms(config, null);

  const read = (path: string, root: string, parse: (text: string) => Parsed): Parsed | null => {
    const file = readInside(path, root);
    if ('reason' in file) {
      report.skippedFiles.push({ path, reason: file.reason });
      return null;
    }
    const parsed = parse(file.text);
    report.files.push({ path, statements: parsed.statements.length });
    report.skippedNotes += parsed.skippedNotes;
    for (const line of parsed.unreadable) report.refused.push({ source: `${path}:${line}`, reason: 'the line is not what this file format holds' });
    return parsed;
  };
  /** The statement's refusal, reported, or null when it may be stored. */
  const refused = (source: string, why: string | null): boolean => {
    if (why !== null) report.refused.push({ source, reason: why });
    return why !== null;
  };

  // Auto memory: written by a model with no approval step, so agent trust.
  for (const dir of Object.keys(config.configs).sort()) {
    const projects = join(dir, 'projects');
    if (!existsSync(projects)) continue;
    for (const project of readdirSync(projects).sort()) {
      const folder = join(projects, project, 'memory');
      if (!existsSync(folder) || !statSync(folder).isDirectory()) continue;
      for (const name of readdirSync(folder).filter((f) => f.endsWith('.md')).sort()) {
        const path = join(folder, name);
        const parsed = read(path, folder, markdown);
        if (parsed === null) continue;
        for (const link of parsed.links) if (!existsSync(join(folder, link))) report.danglingLinks.push({ file: path, link });
        for (const { line, text } of parsed.statements) {
          const source = `${path}:${line}`;
          // Stored without the folder, whose name is another checkout's path: it may name an organisation.
          const stored = `auto memory ${name}:${line}`;
          if (refused(source, refusal(text))) continue;
          const named = namedRepositories(config, text);
          const base = { statement: text, rationale: null, anchors: [], status: 'proposed' as const, trust: 'agent' as const };
          if (named.size > 1) {
            refused(source, 'it names more than one repository');
          } else if (named.size === 1) {
            const [repository, tenant] = [...named][0]!;
            if (refused(source, (config.configs[dir] ?? []).includes(tenant) ? null : `it names a repository of tenant ${tenant}, and the config it came from is not bound to it`)) continue;
            const own = new Set((config.tenants[tenant] ?? []).map((p) => p.split('/')[0]!.toLowerCase()));
            const others = Object.entries(config.tenants)
              .filter(([t]) => t !== tenant)
              .flatMap(([, patterns]) => patterns.map((p) => p.split('/')[0]!.toLowerCase()))
              .filter((o) => !own.has(o));
            if (refused(source, namesOrganisation(text, others) ? 'it also names an owner of another tenant' : null)) continue;
            candidates.push({ ...base, tenant, scope: 'repository', scopeKey: repository, type: 'convention', source: stored });
          } else {
            // A person item follows the owner into every organisation: its source must name none either.
            if (refused(source, refusal(text, terms))) continue;
            if (refused(source, namesOrganisation(name, terms) ? 'its file name names an organisation' : null)) continue;
            candidates.push({ ...base, tenant: '', scope: 'person', scopeKey: '', type: 'preference', source: stored });
          }
        }
      }
    }
  }

  // Repository silos, in the tenant the checkout resolves to. Standards, rejections and policies
  // carry owner trust; a notes file carries agent trust, because tools write it.
  const parsers = { rejections, standards: markdown, policy, notes } as const;
  for (const [checkout, silos] of Object.entries(config.imports ?? {}).sort()) {
    const context = resolveContext(checkout, config, configDir);
    for (const silo of SILOS) {
      const rel = silos[silo];
      if (rel === undefined) continue;
      const path = join(checkout, rel);
      if (!inside(rel)) {
        report.skippedFiles.push({ path, reason: 'not a path inside the repository' });
        continue;
      }
      if (context.tenant === null || context.repository === null) {
        report.skippedFiles.push({ path, reason: context.reason });
        continue;
      }
      const parsed = read(path, checkout, parsers[silo]);
      for (const { line, text, type, symbol, at } of parsed?.statements ?? []) {
        const source = `${path}:${line}`;
        if (refused(source, refusal(text)) || (symbol !== undefined && refused(source, refusal(symbol)))) continue;
        const anchors: Anchor[] = symbol === undefined ? [] : [{ path: symbolPath(symbol), symbol }];
        candidates.push({
          tenant: context.tenant, scope: 'repository', scopeKey: context.repository, type: type ?? 'convention', statement: text,
          rationale: null, anchors, source, trust: silo === 'notes' ? 'agent' : 'owner',
          ...(silo === 'notes' && at !== undefined ? { evidenceAt: at } : {}),
          ...(silo === 'rejections'
            ? { status: 'rejected', validTo: at ?? new Date().toISOString(), statusReason: 'rejected in the retro record' }
            : { status: 'proposed' }),
        });
      }
    }
  }

  if (dryRun) return report;
  const counts = { proposed: 0, tombstones: 0, alreadyKnown: 0, rejectedBefore: 0, quarantined: 0, merged: 0, supersessions: 0 };
  // Tombstones first, so a statement rejected in one silo is not proposed from another.
  candidates.sort((a, b) => Number(b.status === 'rejected') - Number(a.status === 'rejected'));
  const byFile = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const file = c.tenant === '' ? personFile(data) : tenantFile(data, c.tenant);
    byFile.set(file, [...(byFile.get(file) ?? []), c]);
  }
  for (const [file, list] of byFile) {
    const db = openStore(file, true)!;
    try {
      const reject = db.prepare("UPDATE items SET status = 'rejected', valid_to = ?, status_reason = ? WHERE id = ? AND status = 'proposed'");
      const added = { proposed: 0, tombstones: 0 };
      for (const c of list) {
        const was = knownItem(db, c);
        if (c.status === 'rejected') {
          if (was !== undefined && was.status === 'proposed') {
            // Rejected in the retro after it was proposed here: the owner's no stands.
            reject.run(c.validTo ?? new Date().toISOString(), c.statusReason ?? null, was.id);
            added.tombstones++;
          } else if (was !== undefined) counts[was.status === 'rejected' ? 'rejectedBefore' : 'alreadyKnown']++;
          else {
            insertItem(db, c);
            added.tombstones++;
          }
          continue;
        }
        const stored = addItem(db, c);
        if (stored.kind === 'rejected') counts.rejectedBefore++;
        else if (stored.kind === 'known') counts.alreadyKnown++;
        else if (stored.kind === 'merged') counts.merged++;
        else {
          if (stored.kind === 'inserted') added.proposed++;
          if (stored.kind === 'inserted' && stored.supersedes !== undefined) counts.supersessions++;
          if (quarantineOf(c) !== null) counts.quarantined++;
        }
      }
      counts.proposed += added.proposed;
      counts.tombstones += added.tombstones;
      recordAudit(db, 'import', null, added);
      // A rejection imported from long ago is reduced now, not at the next open.
      reduceTombstones(db);
    } finally {
      db.close();
    }
  }
  Object.assign(report, counts);
  return report;
}
