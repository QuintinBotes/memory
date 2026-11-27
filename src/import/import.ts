import type { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { SILOS, organisationTerms, type Config } from '../config.ts';
import { git, matchingTenants, resolveContext } from '../context.ts';
import { namesOrganisation, refusal } from '../gate.ts';
import { addItem } from '../consolidate.ts';
import { inTransaction } from '../store/transaction.ts';
import { insertItem, knownItem, quarantineOf, reduceTombstones, type Anchor, type NewItem } from '../items.ts';
import { openStore } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import { personFile, tenantFile } from '../store/paths.ts';
import { covers } from '../consent/plan.ts';
import { reviewVoiceDecisions } from './review-voice.ts';
import { orbitFindings, type OrbitFinding } from './orbit.ts';
import { inside, markdown, notes, policy, rejections, symbolPath, type Parsed } from './silos.ts';
import { SHARED_FILE } from '../export/shared.ts';
import { sharedCandidates, sharedSource } from './shared.ts';

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

/** Where Orbit keeps a repository's lessons, relative to the checkout. */
const ORBIT_STORE = '.orbit/knowledge.sqlite';

type Candidate = NewItem & { status: 'proposed' | 'rejected'; orbit?: OrbitFinding; sharedSupersedes?: string };

/** The checkout `memory import --shared` reads `.memory/shared.jsonl` from, and the tenant and repository it resolved to. */
export interface SharedCheckout {
  top: string;
  tenant: string;
  repository: string;
}

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
 * as a proposal (a rejection as a tombstone). Nothing imported is active. With `orbit`, only each listed checkout's Orbit
 * knowledge store is read; without it, that store is not.
 */
/**
 * The checkout a Claude Code project folder name stands for, or null. Claude Code writes the path with every '/' and '.'
 * as '-', so the name is read back against the filesystem: each directory is the first run of parts, joined by '-' or '.',
 * that exists. A part left empty by '--' starts a dot name (`.claude`).
 */
export function checkoutOf(project: string, root = sep): string | null {
  const parts = project.split('-').slice(1);
  const walk = (dir: string, rest: string[]): string | null => {
    if (rest.length === 0) return existsSync(join(dir, '.git')) ? dir : null;
    for (let n = 1; n <= Math.min(rest.length, 8); n++) {
      for (const name of joins(rest.slice(0, n))) {
        const path = join(dir, name);
        if (!existsSync(path) || !statSync(path).isDirectory()) continue;
        const found = walk(path, rest.slice(n));
        if (found !== null) return found;
      }
    }
    return null;
  };
  return parts.length === 0 ? null : walk(root, parts);
}

/** Every name `parts` can spell with '-' or '.' between them. A leading empty part is a dot name: ['', 'claude'] is '.claude'. */
function joins(parts: string[]): string[] {
  if (parts[0] === '') return parts.length < 2 ? [] : joins(parts.slice(1)).map((n) => `.${n}`);
  if (parts.includes('')) return [];
  return parts.slice(1).reduce((names, part) => names.flatMap((n) => [`${n}-${part}`, `${n}.${part}`]), [parts[0]!]);
}

export function importSilos(config: Config, data: string, configDir: string, dryRun: boolean, orbit = false, shared?: SharedCheckout): ImportReport {
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
  for (const dir of orbit || shared !== undefined ? [] : Object.keys(config.configs).sort()) {
    const projects = join(dir, 'projects');
    if (!existsSync(projects)) continue;
    for (const project of readdirSync(projects).sort()) {
      const folder = join(projects, project, 'memory');
      if (!existsSync(folder) || !statSync(folder).isDirectory()) continue;
      const checkout = checkoutOf(project);
      const context = checkout === null ? null : resolveContext(checkout, config, dir);
      const home = context?.tenant != null && context.repository !== null ? { repository: context.repository, tenant: context.tenant } : null;
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
          } else if (named.size === 1 || home !== null) {
            // A named repository wins; otherwise the checkout whose auto memory this is (#134).
            const [repository, tenant] = named.size === 1 ? [...named][0]! : [home!.repository, home!.tenant];
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

  /** Orbit's validated lessons, contradictions and run-end observations for this checkout's repository, as proposals. */
  const readOrbit = (checkout: string, rel: string, context: ReturnType<typeof resolveContext>): void => {
    const path = join(checkout, rel);
    if (!inside(rel)) {
      report.skippedFiles.push({ path: rel, reason: 'not a path inside the repository' });
      return;
    }
    if (context.tenant === null || context.repository === null) {
      report.skippedFiles.push({ path, reason: context.reason });
      return;
    }
    if (!covers(config, 'orbit')) {
      report.skippedFiles.push({ path, reason: "your consent does not cover reading an Orbit knowledge store yet; run memory init and confirm" });
      return;
    }
    if (!existsSync(path)) {
      report.skippedFiles.push({ path, reason: 'not there' });
      return;
    }
    const found = orbitFindings(path);
    if ('reason' in found) {
      report.skippedFiles.push({ path, reason: found.reason });
      return;
    }
    report.files.push({ path, statements: found.findings.length });
    for (const reason of found.unreadable) report.refused.push({ source: path, reason });
    for (const f of found.findings) {
      const source = f.evidence ?? `orbit run ${f.run}`;
      if (refused(source, refusal(f.statement))) continue;
      candidates.push({
        tenant: context.tenant, scope: 'repository', scopeKey: context.repository, type: f.type, statement: f.statement, rationale: null,
        anchors: f.anchorPath === null ? [] : [{ path: f.anchorPath }], source, trust: 'agent', status: 'proposed', evidenceAt: f.at, orbit: f, ...(f.kind !== 'lesson' ? { exactOnly: true } : {}),
      });
    }
  };

  // Repository silos, in the tenant the checkout resolves to. Standards, rejections and policies
  // carry owner trust; a notes file carries agent trust, because tools write it.
  const parsers = { rejections, standards: markdown, policy, notes } as const;
  for (const [checkout, silos] of Object.entries(shared !== undefined ? {} : (config.imports ?? {})).sort()) {
    const context = resolveContext(checkout, config, configDir);
    if (orbit) {
      readOrbit(checkout, silos.orbit ?? ORBIT_STORE, context);
      continue;
    }
    for (const silo of SILOS) {
      const rel = silos[silo];
      if (rel === undefined || silo === 'orbit') continue;
      const path = silo === 'decisions' && isAbsolute(rel) ? rel : join(checkout, rel);
      // Review Voice's store lives in its own data directory, so only the text silos must stay inside the checkout.
      if (silo !== 'decisions' && !inside(rel)) {
        report.skippedFiles.push({ path, reason: 'not a path inside the repository' });
        continue;
      }
      if (context.tenant === null || context.repository === null) {
        report.skippedFiles.push({ path, reason: context.reason });
        continue;
      }
      if (silo === 'decisions') {
        if (!covers(config, 'decisions')) {
          report.skippedFiles.push({ path, reason: 'your consent does not cover reading a Review Voice store yet; run memory init and confirm' });
          continue;
        }
        const found = reviewVoiceDecisions(path);
        if ('reason' in found) {
          report.skippedFiles.push({ path, reason: found.reason });
          continue;
        }
        // The store holds every repository's runs; this checkout's repository gets its own.
        const mine = found.decisions.filter((d) => d.repository === context.repository);
        report.files.push({ path, statements: mine.length });
        for (const reason of found.unreadable) report.refused.push({ source: path, reason });
        for (const d of mine) {
          if (refused(d.source, refusal(d.statement))) continue;
          candidates.push({
            tenant: context.tenant, scope: 'repository', scopeKey: context.repository, type: 'precedent', statement: d.statement,
            rationale: null, anchors: [{ path: d.anchorPath }], source: d.source, trust: d.trust, status: 'proposed',
          });
        }
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

  // The file as committed at HEAD, never the working copy: an uncommitted edit is not read (#137).
  if (shared !== undefined) {
    const path = `${SHARED_FILE} at HEAD`;
    const text = covers(config, 'shared') ? git(shared.top, 'show', `HEAD:${SHARED_FILE}`) : undefined;
    if (text === undefined) report.skippedFiles.push({ path, reason: 'your consent does not cover reading .memory/shared.jsonl yet; run memory init and confirm' });
    else if (text === null) report.skippedFiles.push({ path, reason: 'not committed at HEAD' });
    else {
      const found = sharedCandidates(text, shared.tenant, shared.repository);
      report.files.push({ path, statements: found.statements });
      report.refused.push(...found.refused);
      candidates.push(...found.candidates);
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
        if (c.status === 'rejected') {
          // Looked up and written under one lock, so what another writer proposed meanwhile is rejected, not duplicated.
          inTransaction(db, () => {
            const was = knownItem(db, c);
            if (was !== undefined && was.status === 'proposed') {
              // Rejected in the retro after it was proposed here: the owner's no stands.
              reject.run(c.validTo ?? new Date().toISOString(), c.statusReason ?? null, was.id);
              added.tombstones++;
            } else if (was !== undefined) counts[was.status === 'rejected' ? 'rejectedBefore' : 'alreadyKnown']++;
            else {
              insertItem(db, c);
              added.tombstones++;
            }
          });
          continue;
        }
        if (c.sharedSupersedes !== undefined) {
          // The file names the item it replaces by its id on the sharing machine; here it is the item that line became.
          const older = db.prepare("SELECT i.id FROM items i JOIN evidence e ON e.item_id = i.id WHERE e.source_ref = ? AND i.tenant = ? AND i.status = 'active'").get(sharedSource(c.sharedSupersedes), c.tenant) as { id: string } | undefined;
          if (older !== undefined) c.supersedes = older.id;
        }
        const stored = addItem(db, c);
        if (c.orbit !== undefined && stored.kind !== 'rejected') keepOrbit(db, stored.id, c.orbit);
        if (stored.kind === 'rejected') counts.rejectedBefore++;
        else if (stored.kind === 'known') counts.alreadyKnown++;
        else if (stored.kind === 'merged') counts.merged++;
        else {
          if (stored.kind === 'inserted') added.proposed++;
          if (stored.kind === 'inserted' && (stored.supersedes ?? c.supersedes) !== undefined) counts.supersessions++;
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

/** The failure fingerprints and check ids a finding applies to, kept with its item, and the contradictions Orbit counted, which only ever rise. */
function keepOrbit(db: DatabaseSync, id: string, f: OrbitFinding): void {
  const key = db.prepare('INSERT OR IGNORE INTO item_keys (item_id, kind, key) VALUES (?, ?, ?)');
  for (const k of f.fingerprints) key.run(id, 'fingerprint', k);
  for (const k of f.checks) key.run(id, 'check', k);
  db.prepare('UPDATE items SET contradictions = ? WHERE id = ? AND contradictions < ?').run(f.contradictions, id, f.contradictions);
}
