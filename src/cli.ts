import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { suppressSqliteExperimentalWarning } from './warnings.ts';
import { pluginVersion } from './version.ts';
import {
  ConfigError,
  DEFAULT_SESSION_BUDGET,
  SUBAGENT_BUDGET,
  TENANT_NAME,
  TENANT_PATTERN,
  scfUrl,
  scfEndpoint,
  consented,
  recallOn,
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
import { filterRepository, git, resolveContext, type Context, type Reach } from './context.ts';
import { Refusal, refusal } from './gate.ts';
import type { DatabaseSync } from 'node:sqlite';
import { SCOPES, TYPES, closeQuestion, sha256, type Anchor, type Scope } from './items.ts';
import { chooseSlice, estimate, renderAll, row } from './slice.ts';
import { fileLines, headReader, rangeHash, recheck } from './anchors.ts';
import { ForeignAnswer, ProviderError, impactOf, openProvider, resolveKey, symbolAt, testsFor } from './anchors/provider.ts';
import { adoptCandidate, atHead, logAnchors, managedBy, providerConfig, refreshAnchors, setProviderFailed, symbolAnchor, undoMove, withJobLock } from './anchors/refresh.ts';
import { networkFilesystem } from './store/filesystem.ts';
import { withFileLock, withRefreshLock } from './store/refresh-lock.ts';
import { serve } from './mcp/server.ts';
import { UI_HOST, serveUi } from './ui/server.ts';
import { EmbedError, WRITE_TIMEOUT_MS, notOnThisMachine, providerFor } from './embed/provider.ts';
import { embedAfterWrite, embedPending } from './embed/vectors.ts';
import { visibleItems } from './recall/visible.ts';
import { DEFAULT_STANDARDS, applyPromotion, insidePath, promotions, propose as proposePromotions, rejectPromotion, renderPromotion } from './promote/promote.ts';
import { applyEdit, edits, loadInstructions, rejectEdit, renderEdit, type Withheld } from './instructions.ts';
import { appendInjections, injectionLock, logWithheld } from './store/injections.ts';
import { PROPOSALS_LABEL, fence } from './render/rows.ts';
import { PLAN_VERSION, buildConsentPlan, covers, uncovered } from './consent/plan.ts';
import { executePurge, previewPurge, PurgeResidueError, type PurgeScope } from './consent/purge.ts';
import { importSilos } from './import/import.ts';
import { SYMBOL_KEY } from './import/silos.ts';
import { renderReport, tenantReport, testCoverage } from './report/report.ts';
import { exportMarkdown, foreignRepository } from './export/markdown.ts';
import { ScfError, exportToScf, heldInScf, importFromScf, remoteProposals, scfClient, type Remote, type ScfClient } from './export/scf.ts';
import { withFileLockAsync } from './store/refresh-lock.ts';
import { diffRecall } from './recall/diff.ts';
import { orbitRecall } from './recall/orbit.ts';
import { related, relatedTarget } from './recall/related.ts';
import { OUTCOMES, recordOutcome, routeToolsets, type Outcome } from './recall/toolsets.ts';
import { decideById, proposalStores, proposals, renderProposals, type Proposal } from './review/review.ts';
import { MODEL_DEFAULTS, expireTranscripts, modelIsLocal, modelTranscripts, ollamaClient, parseCorrections, processTranscripts, recordTranscript, transcriptsOn, type Ask } from './capture/transcripts.ts';
import { modelTimeoutMs, runProvider } from './provider/run.ts';
import { addItem, supersedeNow, sweep, sweepIfDue, undo } from './consolidate.ts';
import { captureCi } from './capture/ci.ts';
import { commandPassed, expireEpisodes, recordEpisode, revertMessage } from './capture/failures.ts';
import { scanReverts } from './capture/reverts.ts';
import { failureRecall, weakSignature } from './hooks/failure.ts';
import { afterCompaction, pointOfAction, preCompact } from './hooks/point-of-action.ts';
import { capture, captureWanted } from './capture/capture.ts';
import { HOOK_BUSY_MS, openStore } from './store/db.ts';
import { recordAudit } from './store/audit.ts';
import { dataDirectory, injectionLog, personFile, tenantFile } from './store/paths.ts';
import { FALSE_RECALL, falseRecall, parseLog } from './eval/false-recall.ts';
import { REPLAY, parsePulls, replay } from './eval/replay.ts';
import { notRun, orbitArm, seededRecall, type Row } from './eval/scorecard.ts';
import { poison } from './eval/poison.ts';
import { LAB, lab, labTasks, parseRows, verdict } from './eval/lab.ts';
import { buildReplaySet, parseHistory } from './eval/head-to-head/replay-set.ts';
import { headToHead, headToHeadDir, parseArms } from './eval/head-to-head/scorecard.ts';

suppressSqliteExperimentalWarning();

const USAGE = `usage: memory <command>

  init [--tenant <name>=<owner/*|owner/repo>[,...]]... [--bind <tenant>[,...]] [--automation on|off]
       [--failing-commands on|off] [--transcripts on|off] [--recall on] [--scf <tenant>=<url|off>]... [--confirm]
      show the consent plan; with --confirm, save it. --bind binds this Claude Code config. --automation on lets
      sessions started by automation (headless runs, CI jobs) capture and propose; off is the default.
      --failing-commands on keeps failed Bash commands as scrubbed episodes, 30 days, so the same command passing
      later becomes a repair proposal; off is the default. --transcripts on records each session's transcript path
      at its end and turns your corrections in it into quoted proposals at the next session start or sweep; off is
      the default. --recall on turns recall back on after memory turned it
      off itself, when two memory-linked reverts came within seven days
  remember [--scope repository|organisation|person|global] [--type <type>]
           [--anchor <path>[:<start>[-<end>]]] [--rationale <text>] [--source <ref>] [--supersedes <id>] -- <statement>
      remember one statement, active at once. A repeat of an item is merged into it as evidence; a statement that
      conflicts with one queues a supersession in review; --supersedes replaces that item at once
  list [--repo <owner/repo> | --all-repos]
      every item visible here. --repo: that repository's items, its owner's organisation items, and the person and
      global items learned in it. --all-repos: every item of the tenant bound here and the person file. --repo reaches
      only a repository of the tenant bound here; any other is refused and nothing of another tenant is read
  export --to scf [--repo <owner/repo> | --all-repos]
      send this repository's tenant's proposed repository and organisation items to the SCF set for it with memory init
      --scf <tenant>=<url> (key in SCF_API_KEY), as world proposals of layer memory with their evidence; nothing in
      the person file, no other tenant, nothing redaction would change. Run twice, it sends nothing new. An SCF that does
      not answer leaves memory as it was. memory import --scf then brings back SCF's approvals and rejections and the
      outcomes of runs that used the items, counted once each as helped or wrong
  export --markdown <dir> [--repo <owner/repo> | --all-repos]
      write this repository's tenant and the person file as Markdown, one file per item and an index, the same bytes
      for the same store; read only, nothing reads the folder back. Refuses a folder inside another tenant's repository.
      --repo limits it as list --repo does; --all-repos is what it writes without either
  report [--tenant <name>]
      rank each bound tenant's active items by helped minus wrong minus stale, then confidence, then id; items with
      no feedback are listed apart. Each tenant is read from its own store only; read only
  import [--dry-run] [--orbit]
      read the silos (each bound config's auto memory, and the files under "imports" in config.json)
      and store each statement as a proposal; with --dry-run, list the files and write nothing. With --orbit,
      read only each listed checkout's Orbit knowledge store (.orbit/knowledge.sqlite, or imports' "orbit" path),
      read-only: validated lessons, their contradictions and run-end failure fingerprints, as proposals
  review
      the proposals this repository's tenant and the person file hold, with evidence and the shadow gate
  approve <id> [--scope repository|organisation|person|global]
      make a proposal active
  reject <id> [--reason <text>]
      keep a proposal as a tombstone, so the same statement is never proposed again
  conflicts [apply <id> [--confirm [--yes-non-interactive]] | reject <id>]
      the edits memory proposes to instruction files (CLAUDE.md, AGENTS.md): a loaded line an item contradicts (the file
      wins and the item is not recalled) and an item proven enough to be promoted into the file. Nothing is written until
      apply --confirm, which writes exactly the diff shown; reject resolves it. review lists the open ones
  promote [--propose | --apply <id> [--yes-non-interactive] | --reject <id>]
      turn an item that has proved itself into a check: a line of the review-standards file (imports' "standards" path,
      docs/review-standards.md by default), or, for an item on a symbol no test executes, a test to write. --propose
      stores the proposals and lists them; --apply, from a terminal, writes exactly the line shown, marks the item
      promoted and takes it out of recall; --reject keeps the proposal as a tombstone. Nothing is committed or pushed
  undo <audit-id>
      reverse one merge or supersession, by the audit id its command printed
  sweep
      the daily sweep, run now: of two active items that repeat each other, queue the newer as a supersession of the
      older in review. Applies nothing. The session start runs it at most once a day
  corrections
      the model pass over recorded transcripts (transcriptModel in config.json; a local Ollama with inkling-2-mini by
      default, which you install): quotes of your corrections the rules missed, kept only when verbatim, as proposals.
      A tenant's messages go only to a model on this machine. Never run by a hook; stops at the first failure
  embed --backfill
      embed every active item here that has no vector from the provider embeddings in config.json names (none by
      default; a local Ollama, or voyage-4 with VOYAGE_API_KEY). A tenant's items go only to a provider on this machine.
      Remember and approve embed the item they make active
  recheck [<id>]
      check anchored items against HEAD, searching the whole file: a gone citation makes an item stale,
      one that holds again restores it
  anchors refresh
      follow symbol anchors to the code as it is now, through the code anchor provider in config.json (docs/provider.md): an anchor whose key
      moved or was renamed with the same content hash moves with it, and the move is logged; a changed signature or lost
      citation makes the item stale. The session start runs it as a detached job
  anchors undo <move-id>
      put back the anchor an automatic move replaced, exactly, by the audit id logged with the move
  anchors adopt <item-id> <key>
      the owner's yes to one candidate of a re-anchor proposal in memory review
  anchors at <path:line> | impact <key>... | tests <key>
      what the provider answers for the symbol enclosing a line, the symbols that depend on keys, and the tests that prove one
  related <path-or-symbol> [--depth <n>]
      the active items anchored at or under that path (or symbol key, path#name#kind) in this repository, as the session
      slice prints them, within its budget: whole rows only. --depth limits the path segments matched below it
  route -- <task>
      the toolsets (items of type toolset, global) ranked against the task by the search's own points, equal points going
      to more accepted outcomes; each row carries its accepted and rejected counts and total cost. Read only
  outcome <id> accepted|rejected [--cost <n>] [--source <run>]
      record one run's outcome with a toolset as evidence on it: its accepted or rejected count rises by one and the cost
      is added; an accepted one reinforces it
  close <id>
      close an open question, an owner action: it leaves recall at once and stays on record as closed. Only an approved
      (active) open_question can be closed; an agent proposes one with memory_propose and it waits for memory approve
  recall --diff <base>..<head>
      the precedents and hazards for the paths that range changes, within 600 estimated tokens, for any reviewer to
      read before it reports findings. Exits 2 when the range does not resolve
  recall --orbit [--path <p>]... [--fingerprint <f>]... [--check <id>]... [--max-tokens <n>]
      for Orbit's retrieval: at most three lean rows for a run's context, one per line, within --max-tokens, and
      nothing unless the repository's .orbit/config.yaml has knowledge.lessons_in_prompts true. Exits 2 without a context
  mcp
      the MCP server over stdio: memory_search, memory_get, memory_related, memory_propose, memory_feedback
  ui [--port <n>] [--yes-non-interactive]
      a local page to browse, search (ranked as memory_search), edit (as a supersession) and review what review lists,
      on 127.0.0.1 only; any other --host is refused. Prints the address with this run's token; stop it with Ctrl-C.
      It can apply instruction-file edits, so it starts only from a terminal, as conflicts apply does, unless
      --yes-non-interactive is given (put an ask rule on it)
  session-start
      the SessionStart hook, at startup and after a compaction: the slice for this repository and config, within budget
  subagent-start
      the SubagentStart hook: the same slice for an allowed subagent type, within 300 tokens, logged by item id
  point-of-action
      the PreToolUse hook on Read, Edit, Write, MultiEdit and NotebookEdit: items anchored where the call lands, once per
      agent per session, within 120 tokens each time and 600 per agent. Off unless pointOfAction is true in config.json
  failure-recall
      the PostToolUseFailure hook on Bash: the failure patterns and repair recipes whose signature (the statement up to ' => ') the error carries, once
      per agent and fingerprint, within 120 tokens. A repeat after that counts as a contradiction. Needs no opt-in; stores no error text
  command-passed
      the PostToolUse hook on Bash: a command that passes after failing earlier in the session (with --failing-commands on)
      becomes a repair proposal; a git commit is linked to the items shown in the session; a git revert of such a commit
      counts as a contradiction of them, and two within seven days turn recall off. Any other command does nothing
  ci
      read this repository's CI runs with gh: a failed run followed by a passing run on another commit becomes a repair
      proposal with the fingerprint, the fix commit and both runs as evidence
  reverts
      count the reverts of commits memory linked items to, as the hook does after a git revert
  pre-compact
      the PreCompact hook: at most 1,000 characters of the items shown at the point of action this session
  transcript
      the SessionEnd and PostCompact hook, with the transcripts opt-in on: records the transcript's path (never its text),
      or a compaction's redacted summary as an episode; the next session start or sweep reads the corrections
  capture [--foreground]
      the Stop and SessionEnd hook: a filter model reads the redacted session transcript and keeps lessons and decisions
      as active items, merging repeats as evidence. Detaches at once so the hook returns; --foreground waits and reports
  purge (--tenant <name> | --repo <owner/repo> | --item <id> | --source <ref> [--with-derived] | --older-than <days> | --all) [--confirm]
      preview, or with --confirm delete, leaving no recoverable bytes. --repo also takes the person and global items
      learned in that repository. --source reaches this repository's tenant and the person file: an item left without
      evidence returns to proposed, or with --with-derived is deleted
  eval [replay | false-recall | orbit | lab] [--since <date> --pulls <file>] [--log <file>]
       [--agent <command> --model <name> [--task <name>]]
      scorecard rows, memory off and on, one JSON object per line; no measure named means all four.
      replay: memory built only from the pull requests reviewed before --since, restated owner-declined
      findings counted after it. false-recall: recalled items later marked wrong or stale, or anchored
      where nothing was touched, from the injection log. orbit: Orbit's benchmark arm, not run until it
      has a memory switch. lab: the session lab's fixture tasks, three runs per arm, each run by the agent
      command you name in a temporary copy and graded by hidden tests. Calls no model itself, posts nothing and
      never opens the memory store
  eval poison
      the red-team suite (#22), offline: each published memory-poisoning attack replayed against memory's gates in a
      throwaway store, one JSON line per family with attacks attempted, reached active, rendered outside the fence and
      raised support, then the owner's 50 benign items accepted and recalled, then a summary. Exit 1 when any attack got
      through. Not part of the no-measure run
  eval head-to-head --since <date> --history <file> [--arms <file>] [--checked <file>]
      the head-to-head replay (#25): questions built from the history's corrections, decisions and failures after
      --since, in seven categories, answered by this plugin, memory off, Claude Code auto memory, the whole history in
      context and each alternative --arms names (Mem0, Graphiti, Basic Memory, a community plugin; README, Head to head),
      all from the evidence before --since. Prints the bars, then per arm and category recall at 1 and 5, abstention,
      stale recall, tokens and latency, then the verdict and the vocabulary-miss share. The replay set, every
      per-question result and 30 grades to check by hand (pass them back as --checked) stay in the data directory
  eval verdict --scorecard <file> --lab <file>
      whether auto memory may be switched off: only when both files of rows show memory no worse
  --version`;

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
    options: { tenant: { type: 'string', multiple: true }, bind: { type: 'string' }, automation: { type: 'string' }, 'failing-commands': { type: 'string' }, transcripts: { type: 'string' }, recall: { type: 'string' }, scf: { type: 'string', multiple: true }, confirm: { type: 'boolean' } },
  });
  const network = networkFilesystem(data);
  if (network !== undefined) {
    throw new Refusal(`the data directory ${data} is on a network file system (${network}), where SQLite's locking is not reliable; set MEMORY_DATA_DIR to a local disk`, 2);
  }
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
  for (const spec of values.scf ?? []) {
    const [name = '', address = ''] = [spec.slice(0, Math.max(0, spec.indexOf('='))), spec.slice(spec.indexOf('=') + 1)];
    if (!(name in config.tenants)) throw new Refusal(`--scf: no tenant named "${name}"; add it with --tenant first`, 2);
    if (address === 'off') delete config.scf?.[name];
    else {
      const url = scfUrl(address);
      if (typeof url === 'string') throw new Refusal(`--scf ${name}: ${url}`, 2);
      config.scf = { ...config.scf, [name]: { url: url.href } };
    }
  }
  if (config.scf !== undefined && Object.keys(config.scf).length === 0) delete config.scf;
  if (values.automation !== undefined) {
    if (values.automation !== 'on' && values.automation !== 'off') throw new Refusal('--automation is on or off', 2);
    if (values.automation === 'on') config.automation = true;
    else delete config.automation;
  }
  if (values['failing-commands'] !== undefined) {
    if (values['failing-commands'] !== 'on' && values['failing-commands'] !== 'off') throw new Refusal('--failing-commands is on or off', 2);
    config.optIns.failingCommands = values['failing-commands'] === 'on';
  }
  if (values.transcripts !== undefined) {
    if (values.transcripts !== 'on' && values.transcripts !== 'off') throw new Refusal('--transcripts is on or off', 2);
    config.optIns.transcripts = values.transcripts === 'on';
  }
  if (values.recall !== undefined) {
    if (values.recall !== 'on') throw new Refusal('--recall can only be on: memory turns it off itself', 2);
    delete config.recallOff;
  }
  if (config.recallOff !== undefined) console.error(`Recall is off: ${config.recallOff.reason}. Run memory init --recall on to turn it on.`);
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

/** `memory embed --backfill`: the stores this repository's tenant and the person file hold. */
async function embedCommand(args: string[], data: string, cwd: string): Promise<void> {
  const { values } = parseArgs({ args, options: { backfill: { type: 'boolean' } } });
  if (values.backfill !== true) throw new Refusal('memory embed needs --backfill', 2);
  const config = setUp(data);
  if (!covers(config, 'embeddings')) throw new Refusal('your consent does not cover embeddings yet; run memory init and confirm');
  const provider = providerFor(config, WRITE_TIMEOUT_MS);
  if (provider === null) throw new Refusal('no embedder is configured: embeddings in config.json names one (README, Semantic search)');
  let total = 0;
  for (const { file, tenant } of proposalStores(data, resolveContext(cwd, config, currentConfigDir()))) {
    if (tenant !== '' && !provider.local) {
      console.error(`not embedded: ${notOnThisMachine(provider, tenant)}`);
      continue;
    }
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

/**
 * `--anchor` as given: `path[:start[-end]]`, or a symbol key `path#qualified_name#kind`. A key is resolved by the code anchor
 * provider (docs/provider.md); with none configured, or one that fails, the item is anchored to the file and memory says so.
 */
async function anchorFor(cwd: string, data: string, repository: string | null, spec: string): Promise<Anchor> {
  if (!SYMBOL_KEY.test(spec)) return anchorAt(cwd, spec);
  const key = SYMBOL_KEY.exec(spec)!;
  const file = anchorAt(cwd, key[1]!);
  const config = providerConfig(data);
  const fallback = (why: string): Anchor => {
    console.error(`memory: ${why}; anchored to ${file.path} instead, which is checked by path anchors`);
    return file;
  };
  if (config === undefined || repository === null) return fallback('no code anchor provider is configured');
  const provider = openProvider(config, repository, cwd);
  try {
    const { symbol, snapshot, commit } = await resolveKey(provider, spec);
    if (symbol === null) throw new Refusal(`the code anchor provider does not know ${spec}`);
    const head = headReader(cwd).head();
    if (head === null || !atHead(head, commit)) return fallback("the provider's snapshot is not at HEAD");
    return symbolAnchor(symbol, snapshot, headReader(cwd).text(file.path), file.commit) ?? fallback(`the provider's lines for ${spec} are not in ${file.path} at HEAD`);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return fallback(`the code anchor provider failed (${error.message})`);
  }
}

/** `memory anchors refresh|undo|adopt|at|impact|tests`: symbol anchors that follow the code. */
async function anchorsCommand(args: string[], data: string, cwd: string): Promise<void> {
  const [sub, ...rest] = args;
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null) throw new Refusal(`anchors needs a tenant, and ${context.reason}`);
  const [tenant, repository] = [context.tenant, context.repository];
  const file = tenantFile(data, tenant);
  const provider = providerConfig(data);
  const noProvider = 'memory: no code anchor provider is configured (or you have not agreed to the plan that lists it); anchors are checked by path and hash';
  const withStore = async <T>(work: (db: NonNullable<ReturnType<typeof openStore>>) => Promise<T> | T): Promise<T> => {
    const db = openStore(file, false);
    if (db === null) throw new Refusal(`no anchored item in ${repository}`);
    try {
      return await work(db);
    } finally {
      db.close();
    }
  };
  if (sub === 'undo') {
    if (rest.length !== 1) throw new Refusal('give one move id', 2);
    const done = await withStore((db) => undoMove(db, rest[0]!));
    if (done === false) throw new Refusal(`nothing to undo for ${rest[0]}: it is not an automatic anchor move here, or it was already undone`);
    return void console.log(`undone: ${done}`);
  }
  if (sub !== 'refresh' && sub !== 'adopt' && sub !== 'at' && sub !== 'impact' && sub !== 'tests') throw new Refusal('anchors takes refresh, undo <move-id>, adopt <item-id> <key>, at <path:line>, impact <key>... or tests <key>', 2);
  if (provider === undefined) {
    if (sub === 'refresh') return void console.error(noProvider);
    throw new Refusal(noProvider);
  }
  const open = openProvider(provider, repository, cwd);
  {
    if (sub === 'refresh') {
      const limit = Number(process.env['MEMORY_ANCHORS_PER_RUN']);
      const testLimit = Number(process.env['MEMORY_TESTS_PER_RUN']);
      const ran = await withJobLock(`${file}.anchors.lock`, async () => {
        try {
          const result = await withStore((db) =>
            refreshAnchors(db, tenant, repository, cwd, open, (work) => withRefreshLock(file, work), {
              ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
              ...(Number.isInteger(testLimit) && testLimit > 0 ? { testLimit } : {}),
              log: (event) => logAnchors(data, { repository, ...event }),
            }),
          );
          // Only a run that had this repository's anchors to look at says anything about it.
          if (result.examined > 0) setProviderFailed(data, repository, false);
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          if (error instanceof ForeignAnswer) {
            logAnchors(data, { repository, event: 'answer_dropped', reason: error.message });
            console.error(`memory: ${error.message}; no anchor was changed`);
            return true;
          }
          // Any other failure counts, so the hooks check by path until a run succeeds.
          const reason = (error as Error).message;
          logAnchors(data, { repository, event: 'provider_failed', reason });
          setProviderFailed(data, repository, true);
          console.error(`memory: the code anchor provider failed (${reason}); anchors keep their last state and are checked by path anchors until it answers`);
        }
        return true;
      });
      if (ran === undefined) console.error('memory: an anchor refresh is already running; this one did nothing');
      return;
    }
    const ask = async (): Promise<unknown> => {
      if (sub === 'adopt') {
        if (rest.length !== 2) throw new Refusal('give an item id and one candidate key', 2);
        return await withStore((db) => adoptCandidate(db, rest[0]!, rest[1]!, cwd, open, (work) => withRefreshLock(file, work)));
      }
      if (sub === 'at') {
        const m = /^(.+):([1-9]\d*)$/.exec(rest[0] ?? '');
        if (rest.length !== 1 || m === null) throw new Refusal('give one path:line', 2);
        return await symbolAt(open, m[1]!, Number(m[2]));
      }
      if (rest.length === 0 || (sub === 'tests' && rest.length !== 1)) throw new Refusal(sub === 'tests' ? 'give one symbol key' : 'give at least one symbol key', 2);
      return sub === 'impact' ? await impactOf(open, repository, rest) : await testsFor(open, rest[0]!);
    };
    try {
      const answer = await ask();
      console.log(typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2));
    } catch (error) {
      if (error instanceof ProviderError) throw new Refusal(`memory: ${error.message}`);
      throw error;
    }
  }
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
  if (values.type === 'toolset' && scope !== 'global') throw new Refusal('a toolset is global and names no repository: give --scope global', 2);
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
    const why = refusal(text, terms, true);
    if (why !== null) throw new Refusal(`not remembered: ${what} is refused because ${why}`);
  }

  if ((values.type === 'failure-pattern' || values.type === 'repair-recipe') && weakSignature(statement)) {
    console.error("memory: this will never be recalled at a failing command: its signature (the statement up to ' => ') has fewer than two words other than error, failed, fail, warning, exit, code and placeholders such as paths and numbers");
  }
  const anchors = values.anchor === undefined ? [] : [await anchorFor(cwd, data, context.repository, values.anchor)];
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
      originRepository: values.type === 'toolset' ? null : context.repository,
    };
    const where = `${scope}${scopeKey ? ` ${scopeKey}` : ''}${tenant ? `, tenant ${tenant}` : ''}`;
    if (values.supersedes !== undefined) {
      const done = supersedeNow(db, candidate, values.supersedes);
      if (done === null) throw new Refusal(`no active item ${values.supersedes} here to supersede`);
      recordAudit(db, 'item_remembered', { type: 'item', id: done.id }, { scope });
      console.log(`remembered ${done.id} (${where}); it supersedes ${values.supersedes}, which stays on record; undo with memory undo ${done.audit}`);
      await embedAfterWrite(db, config, tenant);
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
    await embedAfterWrite(db, config, tenant);
  } finally {
    db.close();
  }
}

/**
 * `--repo <owner/repo>` or `--all-repos`, as the read they name, or undefined for neither. A `--repo` of any tenant but the one
 * bound here is refused before any store is opened.
 */
function reachOf(values: { repo?: string | undefined; 'all-repos'?: boolean | undefined }, config: Config, context: Context): Reach | undefined {
  if (values.repo !== undefined && values['all-repos'] === true) throw new Refusal('give --repo or --all-repos, not both', 2);
  if (values['all-repos'] === true) return 'all';
  if (values.repo === undefined) return undefined;
  const found = filterRepository(config, context, values.repo);
  if ('reason' in found) throw new Refusal(`--repo: ${found.reason}`, found.malformed ? 2 : 1);
  return found;
}

const REACH_OPTIONS = { repo: { type: 'string' }, 'all-repos': { type: 'boolean' } } as const;

function list(args: string[], data: string, cwd: string): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: REACH_OPTIONS });
  if (positionals.length > 0) throw new Refusal('usage: memory list [--repo <owner/repo> | --all-repos]', 2);
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  process.stdout.write(renderAll(visibleItems(data, context, cwd, [], undefined, null, reachOf(values, config, context))));
}

/** `memory export --markdown <dir>`: every item of this repository's tenant and of the person file, as text a person reads and diffs. */
async function exportCommand(args: string[], data: string, cwd: string): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { markdown: { type: 'string' }, to: { type: 'string' }, ...REACH_OPTIONS } });
  if (values.to !== undefined) {
    if (values.to !== 'scf' || values.markdown !== undefined || positionals.length > 0) throw new Refusal('usage: memory export --to scf [--repo <owner/repo> | --all-repos]', 2);
    const config = setUp(data);
    return scfExport(config, data, cwd, reachOf(values, config, resolveContext(cwd, config, currentConfigDir())));
  }
  if (values.markdown === undefined || positionals.length > 0) throw new Refusal('memory export needs --markdown <dir> or --to scf', 2);
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  const reach = reachOf(values, config, context);
  const tenant = context.tenant;
  if (tenant === null) throw new Refusal(`there is no tenant to export here: ${context.reason}`);
  const why = foreignRepository(values.markdown, config, tenant);
  if (why !== null) throw new Refusal(`not exported: ${why}`);
  const stores: { db: DatabaseSync; tenant: string }[] = [];
  for (const { file, tenant: t } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db !== null) stores.push({ db, tenant: t });
  }
  try {
    console.log(`exported ${exportMarkdown(stores, values.markdown, reach === undefined || reach === 'all' ? undefined : reach.repository)} items of tenant ${tenant} and the person file to ${values.markdown}`);
  } finally {
    for (const { db } of stores) db.close();
  }
}

/** What `export --to scf` and `import --scf` need: the tenant, its SCF client and endpoint, its store file; refuses unless the owner set all of it up. */
function scfSetUp(config: Config, data: string, cwd: string): { tenant: string; client: ScfClient; endpoint: string; file: string } {
  if (!covers(config, 'scf')) throw new Refusal('SCF is a kind of data you have not agreed to; run memory init and confirm');
  const context = resolveContext(cwd, config, currentConfigDir());
  const tenant = context.tenant;
  if (tenant === null) throw new Refusal(`there is no tenant here: ${context.reason}`);
  const address = config.scf?.[tenant];
  if (address === undefined) throw new Refusal(`tenant ${tenant} has no SCF address; memory init --scf ${tenant}=<url> sets one`);
  const key = process.env['SCF_API_KEY'];
  if (key === undefined || key === '') throw new Refusal('SCF_API_KEY is not set');
  const file = tenantFile(data, tenant);
  if (!existsSync(file)) throw new Refusal(`tenant ${tenant} has no items yet`);
  const url = scfUrl(address.url) as URL;
  return { tenant, client: scfClient(url, key), endpoint: scfEndpoint(url), file };
}

const unreachable = (error: unknown): never => {
  if (error instanceof ScfError) throw new Refusal(`${error.message}; nothing was changed`);
  throw error;
};

/**
 * One SCF run, in order: lock (two runs never post the same item), ask SCF what it holds (so an SCF that does not answer
 * costs no write, not even a migration), then open the store. A run that cannot take the lock says so.
 */
async function scfRun<T>(set: { client: ScfClient; file: string }, work: (db: DatabaseSync, remote: Remote[]) => Promise<T>): Promise<T> {
  const done = await withFileLockAsync(`${set.file}.scf.lock`, async () => {
    const remote = await remoteProposals(set.client).catch(unreachable);
    const db = openStore(set.file, false)!;
    try {
      return { value: await work(db, remote).catch(unreachable) };
    } finally {
      db.close();
    }
  }, 60_000);
  if (done === undefined) throw new Refusal('another SCF export or import of this tenant is running; try again when it finishes');
  return done.value;
}

/** `memory export --to scf`: this tenant's proposals to the SCF set for it; the person file is never read. */
async function scfExport(config: Config, data: string, cwd: string, reach: Reach | undefined): Promise<void> {
  const set = scfSetUp(config, data, cwd);
  const r = await scfRun(set, (db, remote) => exportToScf(db, set.tenant, set.client, remote, set.endpoint, reach === undefined || reach === 'all' ? undefined : reach.repository));
  console.log(`sent ${r.posted} proposals of tenant ${set.tenant} to SCF; ${r.already} already there${r.withheld > 0 ? `; ${r.withheld} not sent because they hold text redaction removes` : ''}`);
}

/** `memory import --scf`: SCF's decisions and run outcomes, applied to the items this tenant sent. */
async function scfImport(config: Config, data: string, cwd: string): Promise<void> {
  const set = scfSetUp(config, data, cwd);
  const r = await scfRun(set, (db, remote) => importFromScf(db, set.tenant, set.client, remote, set.endpoint));
  console.log(`from SCF for tenant ${set.tenant}: ${r.approved} approved, ${r.rejected} rejected, ${r.held} held, ${r.helped} helped, ${r.wrong} wrong`);
}

/** `memory report [--tenant <name>]`: the owner's view of which items help and which mislead, one section per tenant bound to this config. */
function reportCommand(args: string[], data: string): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { tenant: { type: 'string' } } });
  if (positionals.length > 0) throw new Refusal('usage: memory report [--tenant <name>]', 2);
  const bound = setUp(data).configs[currentConfigDir()] ?? [];
  if (values.tenant !== undefined && !bound.includes(values.tenant)) throw new Refusal(`tenant ${values.tenant} is not bound to this Claude Code config`);
  const out: string[] = [];
  for (const tenant of values.tenant === undefined ? [...bound].sort() : [values.tenant]) {
    const db = openStore(tenantFile(data, tenant), false);
    if (db === null) continue;
    try {
      const { code, named } = testCoverage(db, tenant);
      const line = providerConfig(data) === undefined ? 'none, no code anchor provider is configured' : `${named} of ${code}`;
      out.push(renderReport(tenant, tenantReport(db, tenant), `Code items naming an executing test: ${line}`));
    } finally {
      db.close();
    }
  }
  if (out.length === 0) console.error('No items to report here.');
  else process.stdout.write(out.join(''));
}

async function importCommand(args: string[], data: string): Promise<void> {
  const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' }, orbit: { type: 'boolean' }, scf: { type: 'boolean' } } });
  if (values.scf === true) {
    if (values['dry-run'] === true || values.orbit === true) throw new Refusal('usage: memory import --scf', 2);
    return scfImport(setUp(data), data, process.cwd());
  }
  const dryRun = values['dry-run'] === true;
  console.log(JSON.stringify(importSilos(setUp(data), data, currentConfigDir(), dryRun, values.orbit === true), null, 2));
  if (dryRun) console.error('Nothing was written. Run memory import without --dry-run to store these as proposals.');
}

/** The edits to instruction files that wait for the owner, in the stores this repository may see. */
function openEdits(data: string, context: Context): ReturnType<typeof edits> {
  const out: ReturnType<typeof edits> = [];
  for (const { file } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      out.push(...edits(db).filter((e) => e.status === 'open'));
    } finally {
      db.close();
    }
  }
  return out;
}

function review(data: string, cwd: string): void {
  const all: Proposal[] = [];
  const held: string[] = [];
  const context = resolveContext(cwd, setUp(data), currentConfigDir());
  for (const { file, tenant } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      all.push(...proposals(db, tenant));
      held.push(...heldInScf(db, tenant));
    } finally {
      db.close();
    }
  }
  const waiting = openEdits(data, context);
  if (waiting.length > 0) {
    const ins = loadInstructions(cwd, currentConfigDir());
    process.stdout.write(
      `Edits to instruction files: ${waiting.length}. The file wins over memory, and memory never writes it: only you, with memory conflicts apply <id> --confirm in a terminal, or memory conflicts reject <id>.\n` +
        fence(PROPOSALS_LABEL, waiting.map((e) => renderEdit(ins, e)).join('')),
    );
  }
  if (held.length > 0) {
    process.stdout.write(`Accepted in SCF, but the evidence was purged here, so they stay proposed until you decide (memory purge --item <id> removes one): ${held.length}.\n${fence(PROPOSALS_LABEL, held.join(''))}`);
  }
  if (all.length === 0) return waiting.length > 0 || held.length > 0 ? undefined : void console.error('No proposals to review here.');
  const quarantined = all.filter((p) => p.quarantine !== null).length;
  const stale = all.filter((p) => p.status !== 'proposed').length;
  process.stdout.write(
    `Memory proposals: ${all.length}, ${quarantined} quarantined as text that reads as an instruction, ${stale} reported stale by an agent. ` +
      'Decide with memory approve <id> (approving a reported item clears its reports) or memory reject <id>.\n' +
      fence(PROPOSALS_LABEL, renderProposals(all)),
  );
}

/**
 * `memory conflicts [apply <id> [--confirm [--yes-non-interactive]] | reject <id>]`: the edits memory proposes to instruction files, for the owner.
 * Apply without --confirm shows the diff and writes nothing; with it, writes exactly that edit, from a terminal (stdin
 * a TTY) or with --yes-non-interactive. No MCP tool does this, but an agent with a shell can run it: put an ask rule on it.
 */
function conflictsCommand(args: string[], data: string, cwd: string): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { confirm: { type: 'boolean' }, 'yes-non-interactive': { type: 'boolean' } } });
  const [verb, id, ...extra] = positionals;
  if (verb !== undefined && ((verb !== 'apply' && verb !== 'reject') || id === undefined || extra.length > 0)) {
    throw new Refusal('usage: memory conflicts [apply <id> [--confirm [--yes-non-interactive]] | reject <id>]', 2);
  }
  if ((values.confirm === true || values['yes-non-interactive'] === true) && verb !== 'apply') throw new Refusal('--confirm and --yes-non-interactive go with apply', 2);
  const context = resolveContext(cwd, setUp(data), currentConfigDir());
  const ins = loadInstructions(cwd, currentConfigDir());
  let listed = 0;
  for (const { file } of proposalStores(data, context)) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      const found = edits(db, id);
      if (verb === undefined) {
        listed += found.length;
        if (found.length > 0) process.stdout.write(found.map((e) => renderEdit(ins, e)).join(''));
        continue;
      }
      const [e] = found;
      if (e === undefined) continue;
      if (verb === 'reject') {
        try {
          rejectEdit(db, e);
        } catch (error) {
          throw new Refusal((error as Error).message);
        }
        return void console.log(`resolved ${e.id}; no file was written${e.kind === 'conflict' ? ', and the item stays out of recall because the file still wins' : ''}`);
      }
      process.stdout.write(renderEdit(ins, e));
      if (values.confirm !== true) return void console.error('Nothing was written. Run the same command with --confirm to write this edit.');
      ownerTerminal(values['yes-non-interactive'], 'nothing was written: apply is');
      try {
        return void console.log(applyEdit(db, ins, e));
      } catch (error) {
        throw new Refusal((error as Error).message);
      }
    } finally {
      db.close();
    }
  }
  if (verb === undefined) {
    if (listed === 0) console.error('No instruction-file edits here.');
    return;
  }
  throw new Refusal(`no edit ${id} here; memory conflicts lists them`);
}

/** What lets a command write an instruction file: the owner's terminal (stdin a TTY), or --yes-non-interactive under an ask rule. */
function ownerTerminal(yes: boolean | undefined, refused: string): void {
  if (!process.stdin.isTTY && yes !== true) {
    throw new Refusal(`${refused} run by the owner in a terminal. From a script or an agent shell, pass --yes-non-interactive, and have an ask rule on this command`, 2);
  }
}

/**
 * `memory promote [--propose | --apply <id> [--yes-non-interactive] | --reject <id>]`: proposals to turn proven items into
 * checks, for the owner. Only apply writes a file, from a terminal, and it never commits.
 */
function promoteCommand(args: string[], data: string, cwd: string): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { propose: { type: 'boolean' }, apply: { type: 'string' }, reject: { type: 'string' }, 'yes-non-interactive': { type: 'boolean' } } });
  const modes = [values.propose === true, values.apply !== undefined, values.reject !== undefined].filter(Boolean).length;
  if (positionals.length > 0 || modes > 1 || (values['yes-non-interactive'] === true && values.apply === undefined)) {
    throw new Refusal('usage: memory promote [--propose | --apply <id> [--yes-non-interactive] | --reject <id>]', 2);
  }
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  const top = git(cwd, 'rev-parse', '--show-toplevel')?.trim();
  if (context.tenant === null || context.repository === null || context.owner === null || top === undefined) throw new Refusal(`no tenant applies here: ${context.reason}`);
  const db = openStore(tenantFile(data, context.tenant), values.propose === true);
  if (db === null) return void console.error('No promotions here.');
  try {
    if (values.propose === true) {
      const configured = Object.entries(config.imports ?? {}).find(([checkout]) => realpathOrSelf(checkout) === realpathOrSelf(top))?.[1].standards;
      const rel = insidePath(configured ?? DEFAULT_STANDARDS);
      if (rel === null) console.error(`The review-standards path ${configured} is not a path inside the repository for a standards file (not absolute, not under .git, .claude or .github/workflows, not an instruction file); no line is proposed for it.`);
      const made = proposePromotions(db, context.tenant, context.repository, top, rel);
      console.error(`${made} new promotion proposal${made === 1 ? '' : 's'}.`);
    }
    const id = values.apply ?? values.reject;
    const found = promotions(db, id);
    if (id === undefined) {
      const open = found.filter((p) => p.status === 'open');
      if (open.length === 0) console.error('No open promotions here.');
      else process.stdout.write(fence(PROPOSALS_LABEL, open.map(renderPromotion).join('')));
      return;
    }
    const [p] = found;
    if (p === undefined) throw new Refusal(`no promotion ${id} here; memory promote lists them`);
    try {
      if (values.reject !== undefined) {
        rejectPromotion(db, p);
        return void console.log(`rejected ${p.id}; it is kept so it is not proposed again, and no file was written`);
      }
      process.stdout.write(fence(PROPOSALS_LABEL, renderPromotion(p)));
      ownerTerminal(values['yes-non-interactive'], 'nothing was written: apply is');
      console.log(applyPromotion(db, p, top, context.tenant, context.repository));
    } catch (error) {
      throw error instanceof Refusal ? error : new Refusal((error as Error).message);
    }
  } finally {
    db.close();
  }
}

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** `memory ui [--port <n>]`: the local page. The host is checked before anything is opened, so a refused one binds no socket. */
function uiCommand(args: string[], data: string, cwd: string): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { host: { type: 'string' }, port: { type: 'string' }, 'yes-non-interactive': { type: 'boolean' } } });
  if (positionals.length > 0) throw new Refusal('usage: memory ui [--port <n>] [--yes-non-interactive]', 2);
  if (values.host !== undefined && values.host !== UI_HOST) throw new Refusal(`memory ui binds ${UI_HOST} only; --host ${values.host} is refused`, 2);
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (values.port !== undefined && !/^\d+$/.test(values.port))) throw new Refusal('--port is a whole number from 0 to 65535', 2);
  // The page can apply edits to instruction files, so it starts only where conflicts apply would write.
  ownerTerminal(values['yes-non-interactive'], 'nothing was served: memory ui applies edits to instruction files, so it is');
  setUp(data);
  serveUi(data, cwd, port);
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
  const config = setUp(data);
  const done = await decideById(data, config, resolveContext(cwd, config, currentConfigDir()), id, decision, { scope, reason: typeof values.reason === 'string' ? values.reason : undefined });
  if (done === null) throw new Refusal(`no proposal ${id} here; memory review lists the proposals this repository and config may see`);
  console.log(done);
}

/** `memory related <path-or-symbol> [--depth <n>]`: what is anchored at or under it. */
function relatedCommand(args: string[], data: string, cwd: string): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { depth: { type: 'string' } } });
  if (positionals.length !== 1) throw new Refusal('give one path or symbol', 2);
  if (values.depth !== undefined && !/^\d+$/.test(values.depth)) throw new Refusal('--depth takes a whole number', 2);
  const target = relatedTarget(cwd, positionals[0]!);
  if (target === null) throw new Refusal('give a path inside the repository, or a symbol key path#name#kind', 2);
  const config = setUp(data);
  if (config.recallOff !== undefined) return void console.error(`Recall is off: ${config.recallOff.reason}. Run memory init --recall on to turn it on.`);
  const out = related(data, config, resolveContext(cwd, config, currentConfigDir()), cwd, target, values.depth === undefined ? undefined : Number(values.depth));
  if (out === '') console.error(`No memory item is anchored at or under ${target}.`);
  else process.stdout.write(out);
}

/** `memory route -- <task>`: the toolsets ranked against a task, with their outcomes. */
function routeCommand(args: string[], data: string): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length === 0) throw new Refusal('give the task, after --', 2);
  const config = setUp(data);
  if (config.recallOff !== undefined) return void console.error(`Recall is off: ${config.recallOff.reason}. Run memory init --recall on to turn it on.`);
  const db = openStore(personFile(data), false);
  const out = db === null ? '' : routeToolsets(db, positionals.join(' '));
  db?.close();
  if (out === '') console.error('No toolset matches.');
  else process.stdout.write(out);
}

/** `memory outcome <id> accepted|rejected [--cost <n>] [--source <run>]`: one run's outcome with a toolset. */
function outcomeCommand(args: string[], data: string): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { cost: { type: 'string', default: '0' }, source: { type: 'string' } } });
  const [id, outcome] = positionals as [string, Outcome];
  if (positionals.length !== 2 || !OUTCOMES.includes(outcome)) throw new Refusal(`usage: memory outcome <id> ${OUTCOMES.join('|')} [--cost <n>] [--source <run>]`, 2);
  const cost = Number(values.cost);
  if (!Number.isFinite(cost) || cost < 0 || values.cost.trim() === '') throw new Refusal('--cost takes a number, 0 or more', 2);
  const source = values.source?.trim() || undefined;
  const why = source === undefined ? null : refusal(source, undefined, true);
  if (why !== null) throw new Refusal(`not recorded: the source is refused because ${why}`);
  setUp(data);
  const db = openStore(personFile(data), false);
  let done: ReturnType<typeof recordOutcome> = 'missing';
  try {
    if (db !== null) done = recordOutcome(db, id, outcome, cost, source);
  } finally {
    db?.close();
  }
  if (done === 'missing') throw new Refusal(`no active toolset ${id}; remember one with --scope global --type toolset`);
  console.log(done === 'already' ? `already recorded: ${source} has an outcome on ${id}; nothing changed` : `recorded ${outcome} for ${id}${cost > 0 ? `, cost ${cost}` : ''}`);
}

/** `memory close <id>`: the owner closes an approved open question. */
function closeCommand(args: string[], data: string, cwd: string): void {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length !== 1) throw new Refusal('give one open question id', 2);
  for (const { file } of proposalStores(data, resolveContext(cwd, setUp(data), currentConfigDir()))) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      if (closeQuestion(db, positionals[0]!)) return void console.log(`closed ${positionals[0]}; it stays on record and is no longer recalled`);
    } finally {
      db.close();
    }
  }
  throw new Refusal(`no active open question ${positionals[0]} here; a proposed one is decided with memory approve or memory reject`);
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
  const file = tenantFile(data, context.tenant);
  const db = openStore(file, false);
  if (db === null) throw new Refusal(`no anchored item to check in ${context.repository}`);
  try {
    const result = withRefreshLock(file, () => recheck(db, context.tenant!, context.repository!, cwd, { id, window: Infinity, managed: managedBy(data, context.repository) }));
    if (result === undefined) return console.log(JSON.stringify({ skipped: 'another refresh holds the lock; nothing was changed' }, null, 2));
    if (id !== undefined && result.checked === 0) throw new Refusal(`no anchored item ${id} in ${context.repository}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

/** `memory recall --diff <range>`: what an owner decided about findings under the paths a change touches. */
async function recallCommand(args: string[], data: string, cwd: string): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { diff: { type: 'string' }, orbit: { type: 'boolean' }, path: { type: 'string', multiple: true }, fingerprint: { type: 'string', multiple: true }, check: { type: 'string', multiple: true }, 'max-tokens': { type: 'string' } },
  });
  const config = setUp(data);
  if (config.recallOff !== undefined) return void console.error(`Recall is off: ${config.recallOff.reason}. Run memory init --recall on to turn it on.`);
  if (values.orbit === true) {
    const [paths, fingerprints, checks] = [values.path ?? [], values.fingerprint ?? [], values.check ?? []];
    if (paths.length + fingerprints.length + checks.length === 0) throw new Refusal('recall --orbit needs a context: --path, --fingerprint or --check', 2);
    const maxTokens = values['max-tokens'] === undefined ? Infinity : Number(values['max-tokens']);
    if (!(maxTokens > 0)) throw new Refusal('--max-tokens takes a positive number', 2);
    return void process.stdout.write(orbitRecall(data, resolveContext(cwd, config, currentConfigDir()), cwd, { paths, fingerprints, checks, maxTokens }));
  }
  if (values.diff === undefined) throw new Refusal('recall needs --diff <base>..<head>', 2);
  const found = await diffRecall(data, config, resolveContext(cwd, config, currentConfigDir()), cwd, values.diff);
  if ('reason' in found) throw new Refusal(found.reason, 2);
  process.stdout.write(found.text);
}

/** `memory sweep`, or with `due` the session start's: each store this repository may see, once a day. */
function sweepCommand(data: string, cwd: string, due: boolean): void {
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  let proposed = 0;
  for (const { file, tenant } of proposalStores(data, context)) {
    const db = openStore(file, false, due ? HOOK_BUSY_MS : undefined);
    if (db === null) continue;
    try {
      proposed += (due ? sweepIfDue(db) : sweep(db)) ?? 0;
      expireEpisodes(db);
      expireTranscripts(db);
      if (transcriptsOn(config) && (tenant !== '' || covers(config, 'personTranscripts'))) processTranscripts(db, tenant, config);
    } finally {
      db.close();
    }
  }
  if (!due) console.log(`proposed ${proposed} merge${proposed === 1 ? '' : 's'}; they wait in memory review`);
}

/**
 * `memory corrections`: the model pass over the transcripts recorded for this repository's tenant and the person file
 * (#80), after the rule pass. Never run by a hook. A tenant's messages go only to a model on this machine; after one
 * failure no store is asked again this run.
 */
function correctionsCommand(data: string, cwd: string): void {
  const config = setUp(data);
  const settings = config.transcriptModel;
  if (settings === undefined || !transcriptsOn(config) || !covers(config, 'transcriptModel')) {
    throw new Refusal('the model pass is off: it needs the transcripts opt-in (memory init --transcripts on) and transcriptModel in config.json, with the plan that lists it agreed to');
  }
  const { url, model } = { ...MODEL_DEFAULTS, ...settings };
  const command = settings.command ?? [process.execPath, fileURLToPath(import.meta.url), 'model-client'];
  const ask: Ask = (turns) => {
    const r = runProvider(command, cwd, { op: 'corrections', url, model, turns }, modelTimeoutMs());
    return r.ok ? parseCorrections(r.stdout) : { failed: r.reason };
  };
  let failed: string | undefined;
  for (const { file, tenant } of proposalStores(data, resolveContext(cwd, config, currentConfigDir()))) {
    if (tenant === '' && !covers(config, 'personTranscripts')) continue;
    if (tenant !== '' && !modelIsLocal(url)) {
      console.error(`memory: the model pass did not run for tenant ${tenant}: its model at ${url} is not on this machine`);
      continue;
    }
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      expireTranscripts(db);
      processTranscripts(db, tenant, config);
      const done = modelTranscripts(db, tenant, config, ask);
      console.log(`${tenant === '' ? 'person file' : `tenant ${tenant}`}: the model read ${done.read} transcript${done.read === 1 ? '' : 's'} and proposed ${done.proposed} correction${done.proposed === 1 ? '' : 's'}`);
      failed = done.failed;
    } finally {
      db.close();
    }
    if (failed !== undefined) throw new Refusal(`memory: the model failed (${failed}); nothing more was asked this run`);
  }
}

/** The model pass's own Ollama client, run by the provider runner (`correctionsCommand`), never by a person. */
async function modelClient(): Promise<void> {
  process.stdout.write(await ollamaClient(readFileSync(0, 'utf8')));
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
function hookSlice(data: string, config: Config, input: Record<string, unknown>, budget: number, withheld: Withheld[] = []) {
  const cwd = typeof input['cwd'] === 'string' && input['cwd'] !== '' ? input['cwd'] : process.cwd();
  const items = visibleItems(data, resolveContext(cwd, config, currentConfigDir()), cwd, [], HOOK_BUSY_MS, withheld);
  // With recall at the point of action on, anchored items wait for the code they are anchored to; the slice counts them.
  if (config.pointOfAction !== true) return chooseSlice(items, budget);
  const unanchored = items.filter((i) => i.anchors.length === 0);
  return chooseSlice(unanchored, budget, items.length - unanchored.length);
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
    if (!recallOn(config)) return;
    if (input['source'] === 'compact') {
      try {
        afterCompaction(data, input);
      } catch {
        // A busy store keeps the ledger; the agent just sees fewer items again.
      }
    }
    const withheld: Withheld[] = [];
    process.stdout.write(hookSlice(data, config, input, config.sessionBudget ?? DEFAULT_SESSION_BUDGET, withheld).text);
    logWithheld(data, config, 'session-start', typeof input['session_id'] === 'string' ? input['session_id'] : 'unknown', withheld);
    // The anchor refresh talks to another program, so it never runs here: a detached job, as capture is.
    try {
      if (providerConfig(data) !== undefined) {
        const child = spawn(process.execPath, [process.argv[1]!, 'anchors', 'refresh'], { cwd: typeof input['cwd'] === 'string' && input['cwd'] !== '' ? input['cwd'] : process.cwd(), detached: true, stdio: 'ignore' });
        child.on('error', () => undefined);
        child.unref();
      }
    } catch {
      // A failed start costs the session nothing; the next session starts it again.
    }
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
    if (!recallOn(config) || typeof type !== 'string' || !subagentAllowed(config, type)) return;
    const id = (v: unknown) => (typeof v === 'string' && v !== '' ? v : 'unknown');
    let slice: ReturnType<typeof hookSlice>;
    const withheld: Withheld[] = [];
    try {
      slice = hookSlice(data, config, input, Math.min(config.sessionBudget ?? DEFAULT_SESSION_BUDGET, SUBAGENT_BUDGET), withheld);
    } catch {
      // The store was busy past the hook's limit or unreadable: print nothing, but count the skip.
      if (covers(config, 'injections')) {
        appendInjections(data, [`${JSON.stringify({ event: 'skipped', session: id(input['session_id']), agent: id(input['agent_id']), via: 'subagent-start', at: new Date().toISOString() })}\n`]);
      }
      return;
    }
    const { text, shown } = slice;
    logWithheld(data, config, 'subagent-start', id(input['session_id']), withheld);
    if (text === '') return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } }));
    if (!covers(config, 'injections')) return;
    const lines = shown.map(
      (item) =>
        `${JSON.stringify({ event: 'injected', session: id(input['session_id']), agent: id(input['agent_id']), item: item.id, via: 'subagent-start', anchors: item.anchors.map((a) => a.path), tokens: estimate(row(item)), at: new Date().toISOString() })}\n`,
    );
    appendInjections(data, lines);
  } catch {
    // Silent by design; see above.
  }
}

/** The PreToolUse hook on Read, Edit, Write, MultiEdit and NotebookEdit; see `pointOfAction`. Silent on any failure. */
function pointOfActionHook(data: string): void {
  try {
    process.stdout.write(pointOfAction(data, hookInput(), (lines) => appendInjections(data, lines.map((l) => `${JSON.stringify(l)}\n`))));
  } catch {
    // Silent by design: advisory memory never costs a tool call.
  }
}

/** The PostToolUseFailure hook on Bash: failure recall, then the failing-command episode when its opt-in is on. Silent on any failure. */
function failureRecallHook(data: string): void {
  const input = hookInput();
  try {
    process.stdout.write(failureRecall(data, input, (lines) => appendInjections(data, lines.map((l) => `${JSON.stringify(l)}\n`))));
  } catch {
    // A hook never fails the tool call.
  }
  try {
    recordEpisode(data, input);
  } catch {
    // A busy or unreadable store loses one episode, never the command.
  }
}

/** The PostToolUse hook on Bash; see `commandPassed`. Silent on any failure. */
function commandPassedHook(data: string): void {
  try {
    process.stdout.write(commandPassed(data, hookInput()));
  } catch {
    // A hook never fails the tool call.
  }
}

/** `memory ci`: repair proposals from failed CI runs that a later run fixed. */
function ciCommand(data: string, cwd: string): void {
  for (const line of captureCi(data, setUp(data), cwd)) console.log(line);
}

/** `memory reverts`: counts the reverts of commits memory linked items to, the scan the PostToolUse hook runs after a `git revert`. */
function revertsCommand(data: string, cwd: string): void {
  const config = setUp(data);
  if (!covers(config, 'failures')) throw new Refusal('your consent does not cover reverts yet; run memory init and confirm');
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null) throw new Refusal(context.reason);
  const db = openStore(tenantFile(data, context.tenant), false);
  if (db === null) return console.log('nothing to count');
  try {
    const message = revertMessage(data, config, scanReverts(db, cwd));
    console.log(message === '' ? 'no new memory-linked reverts' : (JSON.parse(message) as { systemMessage: string }).systemMessage);
  } finally {
    db.close();
  }
}

/** The SessionEnd hook's second job and the PostCompact hook: record a transcript's path, or a compaction's summary. Silent, never fails the session. */
function transcriptHook(data: string): void {
  try {
    recordTranscript(data, hookInput());
  } catch {
    // Silent by design.
  }
}

/** The PreCompact hook: the items shown at the point of action this session, so the summary can keep them. */
function preCompactHook(data: string): void {
  try {
    process.stdout.write(preCompact(data, hookInput()));
  } catch {
    // Silent by design.
  }
}

/** How long a hook waits for the injection log's lock, and how long a purge does. */
const LOG_LOCK_HOOK_MS = 2000;
const LOG_LOCK_PURGE_MS = 10_000;

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
 * than it, or of unknown age. Rewritten whole, so no purged line is left in the file, under the lock appends take.
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
  const done = withFileLock(
    injectionLock(data),
    () => {
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
      return true;
    },
    LOG_LOCK_PURGE_MS,
  );
  if (done === undefined) throw new Refusal('the injection log is busy; run the same purge again to remove its lines');
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
  // --repo also reaches the person and global items learned in that repository.
  if (values.all === true || days !== undefined || values.item !== undefined || values.source !== undefined || repository !== undefined) files.push(personFile(data));

  const report: Record<string, ReturnType<typeof previewPurge>> = {};
  const total = { items: 0, evidence: 0, returnedToProposed: 0, returnedToProposedIds: [] as string[], checks: [] as string[], episodes: 0, episodesByRepository: {} as Record<string, number>, episodesNotAttributable: 0 };
  const keptNotAttributable: string[] = [];
  const residue: string[] = [];
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
      total.episodes += r.episodes;
      total.episodesNotAttributable += r.episodesNotAttributable;
      for (const [repo, n] of Object.entries(r.episodesByRepository)) total.episodesByRepository[repo] = (total.episodesByRepository[repo] ?? 0) + n;
      // --repo keeps what it cannot attribute; the command that removes them is the tenant's own purge.
      if (repository !== undefined && r.episodesNotAttributable > 0 && file !== personFile(data)) {
        keptNotAttributable.push(`${r.episodesNotAttributable} episode(s) not attributable to a repository are kept; memory purge --tenant ${basename(file, '.sqlite')} removes them (and everything else in that tenant)`);
      }
    } catch (error) {
      // The other files are still purged; the failure is reported once at the end.
      if (!(error instanceof PurgeResidueError)) throw error;
      residue.push(`${file}: ${error.message}`);
    } finally {
      db.close();
    }
  }
  if (values.confirm === true) {
    if (values.all === true) rmSync(injectionLog(data), { force: true });
    else pruneLog(data, [...every.map((t) => tenantFile(data, t)), personFile(data)], scope.before);
  }
  console.log(JSON.stringify({ ...total, ...(keptNotAttributable.length > 0 ? { notAttributable: keptNotAttributable } : {}), files: report }, null, 2));
  if (residue.length > 0) throw new Refusal(`purge incomplete\n${residue.join('\n')}`);
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
async function evalCommand(args: string[], data: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: 'string' }, pulls: { type: 'string' }, log: { type: 'string' },
      agent: { type: 'string' }, model: { type: 'string' }, task: { type: 'string' },
      scorecard: { type: 'string' }, lab: { type: 'string' },
      history: { type: 'string' }, arms: { type: 'string' }, checked: { type: 'string' },
    },
  });
  const only = positionals[0];
  if (only === 'head-to-head' && positionals.length === 1) {
    const { since, history, arms, checked } = values;
    if (since === undefined || Number.isNaN(Date.parse(since))) throw new Refusal('head-to-head needs --since <date>, such as 2026-06-01', 2);
    if (history === undefined) throw new Refusal('head-to-head needs --history <file>', 2);
    const set = buildReplaySet(input(history, parseHistory), since);
    const external = arms === undefined ? {} : input(arms, parseArms);
    const marks = checked === undefined ? [] : input(checked, (t) => t.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as never));
    const { rows } = await headToHead(pluginVersion(), set, external, marks, headToHeadDir(data, set.tenant));
    return void process.stdout.write(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
  if (only === 'verdict' && positionals.length === 1) {
    if (values.scorecard === undefined || values.lab === undefined) throw new Refusal('verdict needs --scorecard <file> and --lab <file>', 2);
    return void console.log(verdict(input(values.scorecard, parseRows), input(values.lab, parseRows), currentConfigDir()));
  }
  if (only === 'poison' && positionals.length === 1) {
    if (Object.values(values).some((v) => v !== undefined)) throw new Refusal('poison takes no flags', 2);
    const { rows, meetsBar } = poison(pluginVersion());
    process.stdout.write(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    if (!meetsBar) process.exitCode = 1;
    return;
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
      return list(rest, data, process.cwd());
    case 'export':
      return exportCommand(rest, data, process.cwd());
    case 'import':
      return importCommand(rest, data);
    case 'report':
      return reportCommand(rest, data);
    case 'review':
      return review(data, process.cwd());
    case 'undo':
      return undoCommand(rest, data, process.cwd());
    case 'approve':
    case 'reject':
      return decideCommand(rest, data, process.cwd(), command);
    case 'conflicts':
      return conflictsCommand(rest, data, process.cwd());
    case 'promote':
      return promoteCommand(rest, data, process.cwd());
    case 'sweep':
      return sweepCommand(data, process.cwd(), false);
    case 'corrections':
      return correctionsCommand(data, process.cwd());
    case 'model-client':
      return modelClient();
    case 'recheck':
      return recheckCommand(rest, data, process.cwd());
    case 'anchors':
      return anchorsCommand(rest, data, process.cwd());
    case 'related':
      return relatedCommand(rest, data, process.cwd());
    case 'route':
      return routeCommand(rest, data);
    case 'outcome':
      return outcomeCommand(rest, data);
    case 'close':
      return closeCommand(rest, data, process.cwd());
    case 'recall':
      return recallCommand(rest, data, process.cwd());
    case 'ui':
      return uiCommand(rest, data, process.cwd());
    case 'mcp':
      return serve(data, process.cwd(), pluginVersion());
    case 'session-start':
      return sessionStart(data);
    case 'subagent-start':
      return subagentStart(data);
    case 'point-of-action':
      return pointOfActionHook(data);
    case 'failure-recall':
      return failureRecallHook(data);
    case 'command-passed':
      return commandPassedHook(data);
    case 'ci':
      return ciCommand(data, process.cwd());
    case 'reverts':
      return revertsCommand(data, process.cwd());
    case 'transcript':
      return transcriptHook(data);
    case 'pre-compact':
      return preCompactHook(data);
    case 'capture':
      return captureCommand(rest, data);
    case 'purge':
      return purge(rest, data, process.cwd());
    case 'eval':
      return evalCommand(rest, data);
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
