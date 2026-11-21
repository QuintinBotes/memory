import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { parseArgs } from 'node:util';
import { suppressSqliteExperimentalWarning } from './warnings.ts';
import { pluginVersion } from './version.ts';
import {
  ConfigError,
  DEFAULT_SESSION_BUDGET,
  SUBAGENT_BUDGET,
  TENANT_NAME,
  TENANT_PATTERN,
  consented,
  currentConfigDir,
  emptyConfig,
  loadConfig,
  organisationTerms,
  planHash,
  neverSubagent,
  saveConfig,
  subagentAllowed,
  type Config,
} from './config.ts';
import { git, resolveContext, type Context } from './context.ts';
import { refusal } from './gate.ts';
import { SCOPES, TYPES, insertItem, sha256, type Anchor, type Scope } from './items.ts';
import { chooseSlice, estimate, renderAll, row } from './slice.ts';
import { fileLines, rangeHash, recheck } from './anchors.ts';
import { serve } from './mcp/server.ts';
import { visibleItems } from './recall/visible.ts';
import { PROPOSALS_LABEL, fence } from './render/rows.ts';
import { PLAN_VERSION, buildConsentPlan, covers, uncovered } from './consent/plan.ts';
import { executePurge, previewPurge, type PurgeScope } from './consent/purge.ts';
import { importSilos } from './import/import.ts';
import { decide, proposals, renderProposals, type Proposal } from './review/review.ts';
import { openStore } from './store/db.ts';
import { recordAudit } from './store/audit.ts';
import { dataDirectory, injectionLog, personFile, tenantFile } from './store/paths.ts';
import { FALSE_RECALL, falseRecall, parseLog } from './eval/false-recall.ts';
import { REPLAY, parsePulls, replay } from './eval/replay.ts';
import { notRun, orbitArm, seededRecall, type Row } from './eval/scorecard.ts';
import { LAB, lab, labTasks, parseRows, verdict } from './eval/lab.ts';

suppressSqliteExperimentalWarning();

const USAGE = `usage: memory <command>

  init [--tenant <name>=<owner/*|owner/repo>[,...]]... [--bind <tenant>[,...]] [--confirm]
      show the consent plan; with --confirm, save it. --bind binds this Claude Code config.
  remember [--scope repository|organisation|person|global] [--type <type>]
           [--anchor <path>[:<start>[-<end>]]] [--rationale <text>] [--source <ref>] -- <statement>
      remember one statement, active at once
  list
      every item visible here
  import [--dry-run]
      read the silos (each bound config's auto memory, and the files under "imports" in config.json)
      and store each statement as a proposal; with --dry-run, list the files and write nothing
  review
      the proposals this repository's tenant and the person file hold, with evidence and the shadow gate
  approve <id> [--scope repository|organisation|person|global]
      make a proposal active
  reject <id> [--reason <text>]
      keep a proposal as a tombstone, so the same statement is never proposed again
  recheck [<id>]
      check anchored items against HEAD, searching the whole file: a gone citation makes an item stale,
      one that holds again restores it
  mcp
      the MCP server over stdio: memory_search, memory_get, memory_propose, memory_feedback
  session-start
      the SessionStart hook, at startup and after a compaction: the slice for this repository and config, within budget
  subagent-start
      the SubagentStart hook: the same slice for an allowed subagent type, within 300 tokens, logged by item id
  purge (--tenant <name> | --repo <owner/repo> | --older-than <days> | --all) [--confirm]
      preview, or with --confirm delete
  eval [replay | false-recall | orbit | lab] [--since <date> --pulls <file>] [--log <file>]
       [--agent <command> --model <name> [--task <name>]]
      scorecard rows, memory off and on, one JSON object per line; no measure named means all four.
      replay: memory built only from the pull requests reviewed before --since, restated owner-declined
      findings counted after it. false-recall: recalled items later marked wrong or stale, or anchored
      where nothing was touched, from the injection log. orbit: Orbit's benchmark arm, not run until it
      has a memory switch. lab: the session lab's fixture tasks, three runs per arm, each run by the agent
      command you name in a temporary copy and graded by hidden tests. Calls no model itself, posts nothing and
      never opens the memory store
  eval verdict --scorecard <file> --lab <file>
      whether auto memory may be switched off: only when both files of rows show memory no worse
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
  if (uncovered(config).length > 0) console.error('memory: this release keeps a kind of data you have not agreed to; it stays off until you run memory init and confirm');
  return config;
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
  const added = config.consent === undefined ? [] : uncovered(config);
  const when = values.confirm === true ? 'are on from now' : 'stay off until you confirm';
  if (added.length > 0) console.error(`These kinds of data are new since you agreed, and ${when}:\n${added.map((c) => `  - ${c.text}\n`).join('')}`);
  if (values.confirm !== true) {
    console.error('Nothing was saved. Run the same command with --confirm to agree to this plan.');
    return;
  }
  config.consent = { planHash: planHash(config), grantedAt: new Date().toISOString(), version: PLAN_VERSION };
  saveConfig(data, config);
  const db = openStore(personFile(data), true)!;
  recordAudit(db, 'consent_granted', null, { planHash: config.consent.planHash, version: PLAN_VERSION });
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
  const lines = fileLines(text);
  if (start < 1 || end < start || end > lines.length) throw new Refusal(`${clean} has ${lines.length} lines; ${start}-${end} is outside it`);
  return { path: clean, start, end, commit, citedHash: rangeHash(lines, start, end) };
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

  const terms = personal ? organisationTerms(config, context.repository) : undefined;
  for (const [what, text] of [
    ['the statement', statement],
    ['the rationale', values.rationale],
    ['the source', values.source],
    ['the anchor', values.anchor],
  ] as const) {
    if (text === undefined) continue;
    const why = refusal(text, terms);
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
  process.stdout.write(renderAll(visibleItems(data, resolveContext(cwd, config, currentConfigDir()), cwd)));
}

function importCommand(args: string[], data: string): void {
  const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' } } });
  const dryRun = values['dry-run'] === true;
  console.log(JSON.stringify(importSilos(setUp(data), data, currentConfigDir(), dryRun), null, 2));
  if (dryRun) console.error('Nothing was written. Run memory import without --dry-run to store these as proposals.');
}

/** The stores whose proposals may be reviewed here: this repository's tenant, then the person file. */
function proposalStores(data: string, context: Context): { file: string; tenant: string }[] {
  return [...(context.tenant === null ? [] : [{ file: tenantFile(data, context.tenant), tenant: context.tenant }]), { file: personFile(data), tenant: '' }];
}

function review(data: string, cwd: string): void {
  const all: Proposal[] = [];
  for (const { file, tenant } of proposalStores(data, resolveContext(cwd, setUp(data), currentConfigDir()))) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      all.push(...proposals(db, tenant));
    } finally {
      db.close();
    }
  }
  if (all.length === 0) return void console.error('No proposals to review here.');
  const quarantined = all.filter((p) => p.quarantine !== null).length;
  const stale = all.filter((p) => p.status !== 'proposed').length;
  process.stdout.write(
    `Memory proposals: ${all.length}, ${quarantined} quarantined as text that reads as an instruction, ${stale} reported stale by an agent. ` +
      'Decide with memory approve <id> (approving a reported item clears its reports) or memory reject <id>.\n' +
      fence(PROPOSALS_LABEL, renderProposals(all)),
  );
}

/** `memory approve <id> [--scope]` and `memory reject <id> [--reason]`: the owner's decision on one proposal. */
function decideCommand(args: string[], data: string, cwd: string, decision: 'approve' | 'reject'): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: decision === 'approve' ? { scope: { type: 'string' } } : { reason: { type: 'string' } },
  });
  if (positionals.length !== 1) throw new Refusal('give one proposal id', 2);
  const id = positionals[0]!;
  const scope = values.scope as Scope | undefined;
  if (scope !== undefined && !SCOPES.includes(scope)) throw new Refusal(`--scope is one of ${SCOPES.join(', ')}`, 2);
  const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());

  for (const { file, tenant } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      const [p] = proposals(db, tenant, id);
      if (p === undefined) continue;
      if (decision === 'reject') {
        // A reason kept in the person file follows the owner into every organisation, as the statement does.
        const why = reason === '' ? null : refusal(reason, tenant === '' ? organisationTerms(config, context.repository) : undefined);
        if (why !== null) throw new Refusal(`not rejected: the reason is refused because ${why}`);
        decide(db, p, 'reject', { reason: reason === '' ? null : reason });
        console.log(`rejected ${id}; the same statement will not be proposed again`);
        return;
      }
      // A proposal keeps to its file: moving between the person file and a tenant is a new item.
      const allowed = tenant === '' ? ['person', 'global'] : p.scope === 'repository' ? ['repository', 'organisation'] : [p.scope];
      const to = scope ?? p.scope;
      if (!allowed.includes(to)) throw new Refusal(`this ${p.scope} proposal can be approved as ${allowed.join(' or ')} only`);
      if (to === 'organisation' && p.anchors_json !== '[]') throw new Refusal('only a repository item can have an anchor');
      const scopeKey = to === 'organisation' && p.scope === 'repository' ? p.scope_key.split('/')[0]! : p.scope_key;
      decide(db, p, 'approve', { scope: to, scopeKey });
      const flag = p.quarantine === null ? '' : `; it was quarantined (${p.quarantine}) as text that reads as an instruction`;
      console.log(`approved ${id} (${to}${scopeKey ? ` ${scopeKey}` : ''}${tenant ? `, tenant ${tenant}` : ''})${flag}`);
      return;
    } finally {
      db.close();
    }
  }
  throw new Refusal(`no proposal ${id} here; memory review lists the proposals this repository and config may see`);
}

/** `memory recheck [<id>]`: check this repository's anchored items, stale ones included, and restore what holds. */
function recheckCommand(args: string[], data: string, cwd: string): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 1) throw new Refusal('give at most one item id', 2);
  const id = positionals[0];
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null) throw new Refusal(`recheck needs a tenant, and ${context.reason}`);
  const db = openStore(tenantFile(data, context.tenant), false);
  if (db === null) throw new Refusal(`no anchored item to check in ${context.repository}`);
  try {
    const result = recheck(db, context.tenant, context.repository, cwd, { id, window: Infinity });
    if (id !== undefined && result.checked === 0) throw new Refusal(`no anchored item ${id} in ${context.repository}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

/** The JSON a hook is given on stdin, or nothing when there is none or it is not an object. */
function hookInput(): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(0, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The slice for the hook's working directory: the subagent's own, for a subagent, so its tenant is resolved there. */
function hookSlice(data: string, config: Config, input: Record<string, unknown>, budget: number) {
  const cwd = typeof input['cwd'] === 'string' && input['cwd'] !== '' ? input['cwd'] : process.cwd();
  return chooseSlice(visibleItems(data, resolveContext(cwd, config, currentConfigDir()), cwd), budget);
}

/**
 * The SessionStart hook, at startup and again after a compaction, with the same
 * bytes for the same store. It never fails the session: anything that goes
 * wrong prints nothing, so a broken store costs no tokens and no error.
 */
function sessionStart(data: string): void {
  try {
    const input = hookInput();
    // A session started with --agent names its agent; one that may never get the slice gets none here either.
    if (typeof input['agent_type'] === 'string' && neverSubagent(input['agent_type'])) return;
    const config = loadConfig(data);
    if (!consented(config)) return;
    process.stdout.write(hookSlice(data, config, input, config.sessionBudget ?? DEFAULT_SESSION_BUDGET).text);
  } catch {
    // Silent by design; see above.
  }
}

/**
 * The SubagentStart hook: the session slice for an allowed agent type, as additional context, within the subagent
 * budget, so it is byte-identical to the startup slice whenever the session budget is no larger. Each item shown is
 * logged with the agent's id and its row's tokens. Silent on any failure, as the SessionStart hook is.
 */
function subagentStart(data: string): void {
  try {
    const input = hookInput();
    const type = input['agent_type'];
    const config = loadConfig(data);
    if (!consented(config) || typeof type !== 'string' || !subagentAllowed(config, type)) return;
    const { text, shown } = hookSlice(data, config, input, Math.min(config.sessionBudget ?? DEFAULT_SESSION_BUDGET, SUBAGENT_BUDGET));
    if (text === '') return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } }));
    if (!covers(config, 'injections')) return;
    const id = (v: unknown) => (typeof v === 'string' && v !== '' ? v : 'unknown');
    const lines = shown.map(
      (item) =>
        `${JSON.stringify({ event: 'injected', session: id(input['session_id']), agent: id(input['agent_id']), item: item.id, via: 'subagent-start', anchors: item.anchors.map((a) => a.path), tokens: estimate(row(item)) })}\n`,
    );
    const file = injectionLog(data);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // One write per slice, so lines from parallel subagents do not interleave.
    // shortcut: the log only grows; rotate or purge it with the store when gap 4 (#24) lands.
    appendFileSync(file, lines.join(''), { mode: 0o600 });
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
    before: days === undefined ? undefined : new Date(Date.now() - Number(days) * 86_400_000).toISOString(),
    all: values.all,
  };

  // Every tenant file, not only those the allowlist matches now: an item stored
  // under an earlier allowlist must still be purgeable.
  const tenantsDir = join(data, 'tenants');
  const tenants =
    values.tenant !== undefined
      ? [values.tenant]
      : existsSync(tenantsDir)
        ? readdirSync(tenantsDir).filter((f) => f.endsWith('.sqlite')).map((f) => f.slice(0, -'.sqlite'.length))
        : [];
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

const MEASURES = ['replay', 'false-recall', 'orbit', 'lab'] as const;

/** Reads and parses one input file, or refuses with the file and the reason. */
function input<T>(file: string, parse: (text: string) => T): T {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Refusal(`${file}: ${(error as Error).message}`, 2);
  }
}

/** `memory eval`: one named measure needs its inputs; with none named, a measure without them reports not run. */
function evalCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: 'string' }, pulls: { type: 'string' }, log: { type: 'string' },
      agent: { type: 'string' }, model: { type: 'string' }, task: { type: 'string' },
      scorecard: { type: 'string' }, lab: { type: 'string' },
    },
  });
  const only = positionals[0];
  if (only === 'verdict' && positionals.length === 1) {
    if (values.scorecard === undefined || values.lab === undefined) throw new Refusal('verdict needs --scorecard <file> and --lab <file>', 2);
    return void console.log(verdict(input(values.scorecard, parseRows), input(values.lab, parseRows), currentConfigDir()));
  }
  if (positionals.length > 1 || (only !== undefined && !(MEASURES as readonly string[]).includes(only))) {
    throw new Refusal(`unknown measure ${positionals.join(' ')}; give one of ${MEASURES.join(', ')}, or none for all`, 2);
  }
  const want = (m: (typeof MEASURES)[number]): boolean => only === undefined || only === m;
  const version = pluginVersion();
  const rows: Row[] = [];
  if (want('replay')) {
    const { since, pulls } = values;
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new Refusal(`--since takes a date, such as 2026-03-01, not "${since}"`, 2);
    if (since !== undefined && pulls !== undefined) rows.push(...replay(version, input(pulls, parsePulls), since));
    else if (only !== undefined || since !== undefined || pulls !== undefined) throw new Refusal('replay needs --since <date> and --pulls <file>', 2);
    else rows.push(...notRun(version, REPLAY, 'no --since and --pulls given', ['repeats']));
    rows.push(...seededRecall(version));
  }
  if (want('false-recall')) {
    if (values.log !== undefined) rows.push(...falseRecall(version, input(values.log, parseLog)));
    else if (only !== undefined) throw new Refusal('false-recall needs --log <file>', 2);
    else rows.push(...notRun(version, FALSE_RECALL, 'no --log given', ['false_recall']));
  }
  if (want('orbit')) rows.push(...orbitArm(version));
  if (want('lab')) {
    const { agent, model, task } = values;
    if (agent !== undefined && model !== undefined) {
      if (task !== undefined && !labTasks().includes(task)) throw new Refusal(`no lab task ${task}; the tasks are ${labTasks().join(', ')}`, 2);
      rows.push(...lab(version, agent, model, task));
    } else if (only !== undefined || agent !== undefined || model !== undefined) throw new Refusal('lab needs --agent <command> and --model <name>', 2);
    else rows.push(...notRun(version, LAB, 'no --agent and --model given; the lab runs only the agent command you name', ['pass_rate', 'input_tokens', 'cache_read_tokens', 'turns', 'hook_ms', 'injected']));
  }
  process.stdout.write(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
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
    case 'import':
      return importCommand(rest, data);
    case 'review':
      return review(data, process.cwd());
    case 'approve':
    case 'reject':
      return decideCommand(rest, data, process.cwd(), command);
    case 'recheck':
      return recheckCommand(rest, data, process.cwd());
    case 'mcp':
      return serve(data, process.cwd(), pluginVersion());
    case 'session-start':
      return sessionStart(data);
    case 'subagent-start':
      return subagentStart(data);
    case 'purge':
      return purge(rest, data);
    case 'eval':
      return evalCommand(rest);
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
