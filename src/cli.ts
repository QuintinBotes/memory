import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { parseArgs } from 'node:util';
import { suppressSqliteExperimentalWarning } from './warnings.ts';
import { pluginVersion } from './version.ts';
import {
  ConfigError,
  DEFAULT_SESSION_BUDGET,
  TENANT_NAME,
  TENANT_PATTERN,
  consented,
  currentConfigDir,
  emptyConfig,
  loadConfig,
  planHash,
  saveConfig,
  type Config,
} from './config.ts';
import { git, matchingTenants, resolveContext, type Context } from './context.ts';
import { refusal } from './gate.ts';
import { SCOPES, TYPES, insertItem, personItems, sha256, tenantItems, type Anchor, type Scope, type Visible } from './items.ts';
import { renderAll, renderSlice } from './slice.ts';
import { buildConsentPlan } from './consent/plan.ts';
import { executePurge, previewPurge, type PurgeScope } from './consent/purge.ts';
import { openStore } from './store/db.ts';
import { recordAudit } from './store/audit.ts';
import { dataDirectory, personFile, tenantFile } from './store/paths.ts';

suppressSqliteExperimentalWarning();

const USAGE = `usage: memory <command>

  init [--tenant <name>=<owner/*|owner/repo>[,...]]... [--bind <tenant>[,...]] [--confirm]
      show the consent plan; with --confirm, save it. --bind binds this Claude Code config.
  remember [--scope repository|organisation|person|global] [--type <type>]
           [--anchor <path>[:<start>[-<end>]]] [--rationale <text>] [--source <ref>] -- <statement>
      remember one statement, active at once
  list
      every item visible here
  session-start
      the SessionStart hook: the slice for this repository and config, within budget
  purge (--tenant <name> | --repo <owner/repo> | --older-than <days> | --all) [--confirm]
      preview, or with --confirm delete
  --version`;

/** Exit 1: refused, nothing was written. Exit 2: the command cannot run as given. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly code: 1 | 2 = 1,
  ) {
    super(message);
  }
}

const NOT_SET_UP = 'memory is not set up, or its configuration changed since you agreed to it; run memory init and confirm the plan';

function setUp(data: string): Config {
  const config = loadConfig(data);
  if (!consented(config)) throw new Refusal(NOT_SET_UP);
  return config;
}

/** Every tenant, owner and repository name: a person or global item must carry none of them. */
function organisationTerms(config: Config, context: Context): string[] {
  const terms = new Set<string>(Object.keys(config.tenants));
  for (const patterns of Object.values(config.tenants)) {
    for (const p of patterns) for (const part of p.split('/')) if (part !== '*') terms.add(part);
  }
  if (context.repository !== null) for (const part of context.repository.split('/')) terms.add(part);
  return [...terms];
}

/** Active items this process may show here: the bound tenant's, then the person file's. */
function visibleItems(data: string, config: Config, context: Context): Visible[] {
  const out: Visible[] = [];
  if (context.tenant !== null && context.repository !== null && context.owner !== null) {
    const db = openStore(tenantFile(data, context.tenant), false);
    if (db !== null) {
      out.push(...tenantItems(db, context.tenant, context.repository, context.owner));
      db.close();
    }
  }
  const person = openStore(personFile(data), false);
  if (person !== null) {
    out.push(...personItems(person));
    person.close();
  }
  return out;
}

function init(args: string[], data: string): void {
  const { values } = parseArgs({
    args,
    options: { tenant: { type: 'string', multiple: true }, bind: { type: 'string' }, confirm: { type: 'boolean' } },
  });
  const config = loadConfig(data) ?? emptyConfig();
  for (const spec of values.tenant ?? []) {
    const [name = '', patterns = ''] = spec.split('=', 2);
    if (!TENANT_NAME.test(name) || name === 'person') {
      throw new Refusal(`tenant name "${name}" must be lower-case letters, digits and dashes, and not "person"`, 2);
    }
    const list = patterns.split(',').map((p) => p.trim());
    const bad = list.find((p) => !TENANT_PATTERN.test(p));
    if (bad !== undefined) throw new Refusal(`"${bad}" is not an owner/* or owner/repo pattern`, 2);
    config.tenants[name] = list;
  }
  if (values.bind !== undefined) {
    const tenants = values.bind.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    const unknown = tenants.find((t) => !(t in config.tenants));
    if (unknown !== undefined) throw new Refusal(`no tenant named "${unknown}"; add it with --tenant first`, 2);
    config.configs[currentConfigDir()] = tenants;
  }
  const plan = buildConsentPlan(config, data);
  console.log(JSON.stringify(plan, null, 2));
  if (values.confirm !== true) {
    console.error('Nothing was saved. Run the same command with --confirm to agree to this plan.');
    return;
  }
  config.consent = { planHash: planHash(config), grantedAt: new Date().toISOString() };
  saveConfig(data, config);
  const db = openStore(personFile(data), true)!;
  recordAudit(db, 'consent_granted', null, { planHash: config.consent.planHash });
  db.close();
  console.error('Consent recorded. Memory is on for the tenants this config is bound to.');
}

/** `path[:start[-end]]`, relative to the repository root, read at HEAD. */
function anchorAt(cwd: string, spec: string): Anchor {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(spec);
  const path = m?.[1] ?? '';
  const clean = normalize(path);
  if (!m || isAbsolute(path) || clean.startsWith('..') || clean.split(/[\\/]/).includes('..')) {
    throw new Refusal('an anchor is a path inside the repository, as path or path:start-end');
  }
  const top = git(cwd, 'rev-parse', '--show-toplevel')?.trim();
  const commit = top === undefined ? undefined : git(top, 'rev-parse', 'HEAD')?.trim();
  const text = top === undefined ? null : git(top, 'cat-file', 'blob', `HEAD:${clean}`);
  if (top === undefined || commit === undefined || text === null) throw new Refusal(`${clean} is not in this repository at HEAD`);
  if (m[2] === undefined) return { path: clean, commit, citedHash: sha256(text) };
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  if (start < 1 || end < start || end > lines.length) throw new Refusal(`${clean} has ${lines.length} lines; ${start}-${end} is outside it`);
  return { path: clean, start, end, commit, citedHash: sha256(lines.slice(start - 1, end).join('\n')) };
}

function remember(args: string[], data: string, cwd: string): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      scope: { type: 'string', default: 'repository' },
      type: { type: 'string', default: 'preference' },
      anchor: { type: 'string' },
      rationale: { type: 'string' },
      source: { type: 'string' },
    },
  });
  const scope = values.scope as Scope;
  if (!SCOPES.includes(scope)) throw new Refusal(`--scope is one of ${SCOPES.join(', ')}`, 2);
  if (!(TYPES as readonly string[]).includes(values.type)) throw new Refusal(`--type is one of ${TYPES.join(', ')}`, 2);
  if (positionals.length !== 1) throw new Refusal('give exactly one statement, after --', 2);
  const statement = positionals[0]!.trim();

  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  const personal = scope === 'person' || scope === 'global';
  if (!personal && context.tenant === null) {
    throw new Refusal(`a ${scope} item needs a tenant, and ${context.reason}; only person and global items can be remembered here`);
  }
  if (values.anchor !== undefined && scope !== 'repository') throw new Refusal('only a repository item can have an anchor');

  const terms = personal ? organisationTerms(config, context) : undefined;
  for (const [what, text] of [
    ['the statement', statement],
    ['the rationale', values.rationale],
    ['the source', values.source],
  ] as const) {
    if (text === undefined) continue;
    const why = refusal(text, what === 'the source' ? undefined : terms);
    if (why !== null) throw new Refusal(`not remembered: ${what} is refused because ${why}`);
  }

  const anchors = values.anchor === undefined ? [] : [anchorAt(cwd, values.anchor)];
  const tenant = personal ? '' : context.tenant!;
  const scopeKey = scope === 'repository' ? context.repository! : scope === 'organisation' ? context.owner! : '';
  const db = openStore(personal ? personFile(data) : tenantFile(data, tenant), true)!;
  try {
    const id = insertItem(db, {
      tenant,
      scope,
      scopeKey,
      type: values.type,
      statement,
      rationale: values.rationale?.trim() ?? null,
      anchors,
      source: values.source?.trim() || 'remember',
    });
    recordAudit(db, 'item_remembered', { type: 'item', id }, { scope });
    console.log(`remembered ${id} (${scope}${scopeKey ? ` ${scopeKey}` : ''}${tenant ? `, tenant ${tenant}` : ''})`);
  } finally {
    db.close();
  }
}

function list(data: string, cwd: string): void {
  const config = setUp(data);
  process.stdout.write(renderAll(visibleItems(data, config, resolveContext(cwd, config, currentConfigDir()))));
}

/**
 * The SessionStart hook. It never fails the session: anything that goes wrong
 * prints nothing, so a broken store costs no tokens and no error.
 */
function sessionStart(data: string): void {
  try {
    let cwd = process.cwd();
    try {
      const input = JSON.parse(readFileSync(0, 'utf8')) as { cwd?: unknown };
      if (typeof input.cwd === 'string' && input.cwd.length > 0) cwd = input.cwd;
    } catch {
      // No input or not JSON: the working directory decides.
    }
    const config = loadConfig(data);
    if (!consented(config)) return;
    const items = visibleItems(data, config, resolveContext(cwd, config, currentConfigDir()));
    process.stdout.write(renderSlice(items, config.sessionBudget ?? DEFAULT_SESSION_BUDGET));
  } catch {
    // Silent by design; see above.
  }
}

function purge(args: string[], data: string): void {
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: 'string' },
      repo: { type: 'string' },
      'older-than': { type: 'string' },
      all: { type: 'boolean' },
      confirm: { type: 'boolean' },
    },
  });
  const chosen = [values.tenant, values.repo, values['older-than'], values.all].filter((v) => v !== undefined);
  if (chosen.length !== 1) throw new Refusal('give exactly one of --tenant, --repo, --older-than or --all', 2);
  const days = values['older-than'];
  if (days !== undefined && !/^\d+$/.test(days)) throw new Refusal('--older-than takes a whole number of days', 2);
  if (values.tenant !== undefined && !TENANT_NAME.test(values.tenant)) throw new Refusal(`no tenant named "${values.tenant}"`, 2);
  const repository = values.repo?.toLowerCase();
  if (repository !== undefined && !/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/.test(repository)) {
    throw new Refusal('--repo takes owner/repo', 2);
  }
  const scope: PurgeScope = {
    tenant: values.tenant,
    repository,
    olderThanDays: days === undefined ? undefined : Number(days),
    all: values.all,
  };

  const config = loadConfig(data) ?? emptyConfig();
  const tenantsDir = join(data, 'tenants');
  const allTenants = existsSync(tenantsDir)
    ? readdirSync(tenantsDir).filter((f) => f.endsWith('.sqlite')).map((f) => f.slice(0, -'.sqlite'.length))
    : [];
  let tenants: string[];
  if (values.tenant !== undefined) tenants = [values.tenant];
  else if (repository !== undefined) {
    const [owner = '', repo = ''] = repository.split('/');
    tenants = matchingTenants(config, owner, repo);
  } else tenants = allTenants;
  const files = tenants.filter((t) => TENANT_NAME.test(t)).map((t) => tenantFile(data, t));
  if (values.all === true || days !== undefined) files.push(personFile(data));

  const report: Record<string, ReturnType<typeof previewPurge>> = {};
  const total = { items: 0, evidence: 0, returnedToProposed: 0 };
  for (const file of files) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      const r = values.confirm === true ? executePurge(db, scope) : previewPurge(db, scope);
      report[file.slice(data.length + 1)] = r;
      total.items += r.items;
      total.evidence += r.evidence;
      total.returnedToProposed += r.returnedToProposed;
    } finally {
      db.close();
    }
  }
  console.log(JSON.stringify({ ...total, files: report }, null, 2));
  if (values.confirm !== true) console.error('Nothing was deleted. Run the same command with --confirm to delete.');
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const data = dataDirectory();
  switch (command) {
    case '--version':
      console.log(pluginVersion());
      return;
    case 'init':
      return init(rest, data);
    case 'remember':
      return remember(rest, data, process.cwd());
    case 'list':
      return list(data, process.cwd());
    case 'session-start':
      return sessionStart(data);
    case 'purge':
      return purge(rest, data);
    case undefined:
    case '--help':
    case 'help':
      console.log(USAGE);
      return;
    default:
      throw new Refusal(`unknown command ${command}\n\n${USAGE}`, 2);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Refusal) {
    console.error(error.message);
    process.exitCode = error.code;
  } else if (error instanceof ConfigError || String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')) {
    console.error((error as Error).message);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
