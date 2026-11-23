import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import type { DatabaseSync } from 'node:sqlite';
import { SCOPES, TYPES, sha256, type Anchor, type Scope } from './items.ts';
import { chooseSlice, estimate, renderAll, row } from './slice.ts';
import { fileLines, rangeHash, recheck } from './anchors.ts';
import { serve } from './mcp/server.ts';
import { EmbedError, WRITE_TIMEOUT_MS, providerFor } from './embed/provider.ts';
import { embedPending } from './embed/vectors.ts';
import { visibleItems } from './recall/visible.ts';
import { PROPOSALS_LABEL, fence } from './render/rows.ts';
import { PLAN_VERSION, buildConsentPlan, covers, uncovered } from './consent/plan.ts';
import { executePurge, previewPurge, type PurgeScope } from './consent/purge.ts';
import { importSilos } from './import/import.ts';
import { declineSupersession, decide, isPendingSupersession, proposals, renderProposals, type Proposal } from './review/review.ts';
import { addItem, supersedeNow, sweep, sweepIfDue, undo } from './consolidate.ts';
import { capture, captureWanted } from './capture/capture.ts';
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
           [--anchor <path>[:<start>[-<end>]]] [--rationale <text>] [--source <ref>] [--supersedes <id>] -- <statement>
      remember one statement, active at once. A repeat of an item is merged into it as evidence; a statement that
      conflicts with one queues a supersession in review; --supersedes replaces that item at once
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
  undo <audit-id>
      reverse one merge or supersession, by the audit id its command printed
  sweep
      the daily sweep, run now: of two active items that repeat each other, queue the newer as a supersession of the
      older in review. Applies nothing. The session start runs it at most once a day
  embed --backfill
      embed every active item here that has no vector from the configured provider (voyage-4 unless config.json says
      otherwise; needs VOYAGE_API_KEY). Remember and approve embed the item they make active
  recheck [<id>]
      check anchored items against HEAD, searching the whole file: a gone citation makes an item stale,
      one that holds again restores it
  mcp
      the MCP server over stdio: memory_search, memory_get, memory_propose, memory_feedback
  session-start
      the SessionStart hook, at startup and after a compaction: the slice for this repository and config, within budget
  subagent-start
      the SubagentStart hook: the same slice for an allowed subagent type, within 300 tokens, logged by item id
  capture [--foreground]
      the Stop and SessionEnd hook: a filter model reads the redacted session transcript and keeps lessons and decisions
      as active items, merging repeats as evidence. Detaches at once so the hook returns; --foreground waits and reports
  purge (--tenant <name> | --repo <owner/repo> | --item <id> | --source <ref> [--with-derived] | --older-than <days> | --all) [--confirm]
      preview, or with --confirm delete, leaving no recoverable bytes. --source reaches this repository's tenant and the
      person file: an item left without evidence returns to proposed, or with --with-derived is deleted
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

/**
 * After a write: embeds what is now active here and has no vector. A failure never undoes the write; it is said, and
 * `memory embed --backfill` fills the gap. No key is the normal state of a machine that does not use embeddings, so it is not said.
 */
async function embedAfterWrite(db: DatabaseSync, config: Config): Promise<void> {
  if (!covers(config, 'embeddings')) return;
  try {
    await embedPending(db, providerFor(config, WRITE_TIMEOUT_MS));
  } catch (error) {
    if (!(error instanceof EmbedError)) throw error;
    if (!error.noKey) console.error(`memory: not embedded (${error.message}); memory embed --backfill fills it later`);
  }
}

/** `memory embed --backfill`: the stores this repository's tenant and the person file hold. */
async function embedCommand(args: string[], data: string, cwd: string): Promise<void> {
  const { values } = parseArgs({ args, options: { backfill: { type: 'boolean' } } });
  if (values.backfill !== true) throw new Refusal('memory embed needs --backfill', 2);
  const config = setUp(data);
  if (!covers(config, 'embeddings')) throw new Refusal('your consent does not cover embeddings yet; run memory init and confirm');
  const provider = providerFor(config, WRITE_TIMEOUT_MS);
  let total = 0;
  for (const { file } of proposalStores(data, resolveContext(cwd, config, currentConfigDir()))) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      total += await embedPending(db, provider);
    } catch (error) {
      if (error instanceof EmbedError) throw new Refusal(`not embedded: ${error.message}`);
      throw error;
    } finally {
      db.close();
    }
  }
  console.log(`embedded ${total} item${total === 1 ? '' : 's'} with ${provider.model}`);
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

async function remember(args: string[], data: string, cwd: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      scope: { type: 'string', default: 'repository' },
      type: { type: 'string', default: 'preference' },
      anchor: { type: 'string' },
      rationale: { type: 'string' },
      source: { type: 'string' },
      supersedes: { type: 'string' },
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
    const candidate = {
      tenant,
      scope,
      scopeKey,
      type: values.type,
      statement,
      rationale: values.rationale?.trim() ?? null,
      anchors,
      source: values.source?.trim() || 'remember',
    };
    const where = `${scope}${scopeKey ? ` ${scopeKey}` : ''}${tenant ? `, tenant ${tenant}` : ''}`;
    if (values.supersedes !== undefined) {
      const done = supersedeNow(db, candidate, values.supersedes);
      if (done === null) throw new Refusal(`no active item ${values.supersedes} here to supersede`);
      recordAudit(db, 'item_remembered', { type: 'item', id: done.id }, { scope });
      console.log(`remembered ${done.id} (${where}); it supersedes ${values.supersedes}, which stays on record; undo with memory undo ${done.audit}`);
      await embedAfterWrite(db, config);
      return;
    }
    const stored = addItem(db, { ...candidate, status: 'active' });
    if (stored.kind === 'merged') {
      console.log(`merged into ${stored.id} as evidence (support ${stored.support}); undo with memory undo ${stored.audit}`);
    } else if (stored.kind === 'known') {
      console.log(`${stored.id} already holds this statement from this source`);
    } else if (stored.kind === 'inserted') {
      recordAudit(db, 'item_remembered', { type: 'item', id: stored.id }, { scope });
      console.log(`remembered ${stored.id} (${where})${stored.supersedes === undefined ? '' : `; it conflicts with ${stored.supersedes}, and the supersession waits in memory review`}`);
    } else {
      throw new Refusal('this statement was already placed as superseded');
    }
    await embedAfterWrite(db, config);
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
async function decideCommand(args: string[], data: string, cwd: string, decision: 'approve' | 'reject'): Promise<void> {
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
        if (isPendingSupersession(p)) {
          declineSupersession(db, p);
          console.log(`declined: ${id} stays active and ${p.older!.id} stays active`);
          return;
        }
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
      const superseded = decide(db, p, 'approve', { scope: to, scopeKey });
      const flag = p.quarantine === null ? '' : `; it was quarantined (${p.quarantine}) as text that reads as an instruction`;
      const replaced = superseded === null ? '' : `; it supersedes ${p.older!.id}, which stays on record; undo with memory undo ${superseded}`;
      console.log(`approved ${id} (${to}${scopeKey ? ` ${scopeKey}` : ''}${tenant ? `, tenant ${tenant}` : ''})${flag}${replaced}`);
      await embedAfterWrite(db, config);
      return;
    } finally {
      db.close();
    }
  }
  throw new Refusal(`no proposal ${id} here; memory review lists the proposals this repository and config may see`);
}

/** `memory undo <audit-id>`: reverses a merge or a supersession in whichever store holds the event. */
function undoCommand(args: string[], data: string, cwd: string): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length !== 1) throw new Refusal('give one audit id', 2);
  for (const { file } of proposalStores(data, resolveContext(cwd, setUp(data), currentConfigDir()))) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      const done = undo(db, positionals[0]!);
      if (done !== false) return void console.log(`undone: ${done}`);
    } finally {
      db.close();
    }
  }
  throw new Refusal(`nothing to undo for ${positionals[0]}: it is not a merge or supersession here, or it was already undone`);
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

/** `memory sweep`, or with `due` the session start's: each store this repository may see, once a day. */
function sweepCommand(data: string, cwd: string, due: boolean): void {
  const context = resolveContext(cwd, setUp(data), currentConfigDir());
  let proposed = 0;
  for (const { file } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      proposed += (due ? sweepIfDue(db) : sweep(db)) ?? 0;
    } finally {
      db.close();
    }
  }
  if (!due) console.log(`proposed ${proposed} merge${proposed === 1 ? '' : 's'}; they wait in memory review`);
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
    // After the slice, in its own try: a slow or failing sweep never costs the session its slice.
    try {
      sweepCommand(data, typeof input['cwd'] === 'string' && input['cwd'] !== '' ? input['cwd'] : process.cwd(), true);
    } catch {
      // The sweep is housekeeping; `memory sweep` shows its errors.
    }
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
        `${JSON.stringify({ event: 'injected', session: id(input['session_id']), agent: id(input['agent_id']), item: item.id, via: 'subagent-start', anchors: item.anchors.map((a) => a.path), tokens: estimate(row(item)), at: new Date().toISOString() })}\n`,
    );
    const file = injectionLog(data);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // One write per slice, so lines from parallel subagents do not interleave.
    appendFileSync(file, lines.join(''), { mode: 0o600 });
  } catch {
    // Silent by design; see above.
  }
}

/** The Stop and SessionEnd hook. Never fails the session: it hands the work to a detached process and returns. */
async function captureCommand(args: string[], data: string): Promise<void> {
  const { values } = parseArgs({ args, options: { foreground: { type: 'boolean' } } });
  const input = hookInput();
  if (values.foreground === true) {
    try {
      console.error(`memory capture: ${await capture(data, input)}`);
    } catch (error) {
      console.error(`memory capture failed: ${(error as Error).message}`);
    }
    return;
  }
  try {
    if (!captureWanted(loadConfig(data))) return;
    const child = spawn(process.execPath, [process.argv[1]!, 'capture', '--foreground'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => undefined);
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
    child.unref();
  } catch {
    // Silent by design: a failed capture never costs the session anything.
  }
}

/**
 * The injection log after a purge: no line of an item that no store holds any more, and with a cut-off no line older
 * than it, or of unknown age. Rewritten whole, so no purged line is left in the file.
 * shortcut: a subagent line appended while the log is rewritten can be lost; fine for a log, revisit with #24.
 */
function pruneLog(data: string, files: string[], before: string | undefined): void {
  const file = injectionLog(data);
  if (!existsSync(file)) return;
  const held = new Set<string>();
  for (const f of files) {
    const db = openStore(f, false);
    if (db === null) continue;
    try {
      for (const r of db.prepare('SELECT id FROM items').all() as { id: string }[]) held.add(r.id);
    } finally {
      db.close();
    }
  }
  const kept = readFileSync(file, 'utf8').split('\n').filter((line) => {
    if (line.trim() === '') return false;
    try {
      const e = JSON.parse(line) as { item?: unknown; at?: unknown };
      if (typeof e.item === 'string' && !held.has(e.item)) return false;
      return before === undefined || (typeof e.at === 'string' && e.at >= before);
    } catch {
      return false;
    }
  });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.map((l) => `${l}\n`).join(''), { mode: 0o600 });
  renameSync(tmp, file);
}

function purge(args: string[], data: string, cwd: string): void {
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: 'string' },
      repo: { type: 'string' },
      item: { type: 'string' },
      source: { type: 'string' },
      'with-derived': { type: 'boolean' },
      'older-than': { type: 'string' },
      all: { type: 'boolean' },
      confirm: { type: 'boolean' },
    },
  });
  const chosen = [values.tenant, values.repo, values.item, values.source, values['older-than'], values.all].filter((v) => v !== undefined);
  if (chosen.length !== 1) throw new Refusal('give exactly one of --tenant, --repo, --item, --source, --older-than or --all', 2);
  if (values['with-derived'] === true && values.source === undefined) throw new Refusal('--with-derived goes with --source', 2);
  const days = values['older-than'];
  if (days !== undefined && !/^\d+$/.test(days)) throw new Refusal('--older-than takes a whole number of days', 2);
  if (values.tenant !== undefined && !TENANT_NAME.test(values.tenant)) throw new Refusal(`no tenant named "${values.tenant}"`, 2);
  if (values.item !== undefined && !/^m-[0-9a-f]+$/.test(values.item)) throw new Refusal(`"${values.item}" is not an item id`, 2);
  if (values.source !== undefined && values.source.trim() === '') throw new Refusal('--source takes a source reference', 2);
  const repository = values.repo?.toLowerCase();
  if (repository !== undefined && !/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/.test(repository)) {
    throw new Refusal('--repo takes owner/repo', 2);
  }
  const scope: PurgeScope = {
    tenant: values.tenant,
    repository,
    item: values.item,
    source: values.source?.trim(),
    withDerived: values['with-derived'],
    before: days === undefined ? undefined : new Date(Date.now() - Number(days) * 86_400_000).toISOString(),
    all: values.all,
  };

  // Every tenant file, not only those the allowlist matches now: an item stored
  // under an earlier allowlist must still be purgeable.
  const tenantsDir = join(data, 'tenants');
  const every = existsSync(tenantsDir)
    ? readdirSync(tenantsDir).filter((f) => f.endsWith('.sqlite')).map((f) => f.slice(0, -'.sqlite'.length)).filter((t) => TENANT_NAME.test(t))
    : [];
  let tenants = values.tenant !== undefined ? [values.tenant] : every;
  if (values.source !== undefined) {
    // A source reaches only this repository's tenant, never another tenant's file holding the same reference.
    const config = loadConfig(data);
    const context = config === null ? null : resolveContext(cwd, config, currentConfigDir());
    tenants = context?.tenant == null ? [] : [context.tenant];
    if (tenants.length === 0) console.error(`--source reaches only the person file here: ${context?.reason ?? 'memory is not set up'}`);
  }
  const files = tenants.map((t) => tenantFile(data, t));
  if (values.all === true || days !== undefined || values.item !== undefined || values.source !== undefined) files.push(personFile(data));

  const report: Record<string, ReturnType<typeof previewPurge>> = {};
  const total = { items: 0, evidence: 0, returnedToProposed: 0, returnedToProposedIds: [] as string[], checks: [] as string[] };
  for (const file of files) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      const r = values.confirm === true ? executePurge(db, scope) : previewPurge(db, scope);
      report[file.slice(data.length + 1)] = r;
      total.items += r.items;
      total.evidence += r.evidence;
      total.returnedToProposed += r.returnedToProposed;
      total.returnedToProposedIds.push(...r.returnedToProposedIds);
      total.checks.push(...r.checks);
    } finally {
      db.close();
    }
  }
  if (values.confirm === true) {
    if (values.all === true) rmSync(injectionLog(data), { force: true });
    else pruneLog(data, [...every.map((t) => tenantFile(data, t)), personFile(data)], scope.before);
  }
  console.log(JSON.stringify({ ...total, files: report }, null, 2));
  if (values.confirm !== true) console.error('Nothing was deleted. Run the same command with --confirm to delete.');
  else if (total.checks.length > 0) console.error('Review the promoted checks listed under "checks"; memory does not edit them.');
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

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const data = dataDirectory();
  switch (command) {
    case '--version':
      console.log(pluginVersion());
      return;
    case 'init':
      return init(rest, data);
    case 'embed':
      return embedCommand(rest, data, process.cwd());
    case 'remember':
      return remember(rest, data, process.cwd());
    case 'list':
      return list(data, process.cwd());
    case 'import':
      return importCommand(rest, data);
    case 'review':
      return review(data, process.cwd());
    case 'undo':
      return undoCommand(rest, data, process.cwd());
    case 'approve':
    case 'reject':
      return decideCommand(rest, data, process.cwd(), command);
    case 'sweep':
      return sweepCommand(data, process.cwd(), false);
    case 'recheck':
      return recheckCommand(rest, data, process.cwd());
    case 'mcp':
      return serve(data, process.cwd(), pluginVersion());
    case 'session-start':
      return sessionStart(data);
    case 'subagent-start':
      return subagentStart(data);
    case 'capture':
      return captureCommand(rest, data);
    case 'purge':
      return purge(rest, data, process.cwd());
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
  await main(process.argv.slice(2));
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
