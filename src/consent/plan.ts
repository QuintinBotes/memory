// Adapted from Review Voice, plugins/review-voice/src/consent/plan.ts at 707ba60
// (https://github.com/QuintinBotes/review-voice, MIT).
import type { Config } from '../config.ts';

/**
 * Every data category, with the plan version that first disclosed it. A new
 * category takes the next version, so a consent given before it does not cover
 * it: its capture stays off until the owner agrees to the plan again.
 */
export const DATA_CATEGORIES = [
  { id: 'statements', since: 1, text: 'Statements you ask memory to remember, each with its scope, type and an optional source reference' },
  { id: 'anchors', since: 1, text: 'For an anchored statement: the file path, line range, commit and a hash of the cited lines, not the lines themselves' },
  { id: 'origin', since: 1, text: "The working directory's git origin remote, read at session start, after a compaction and at a subagent's start to find its tenant" },
  { id: 'injections', since: 2, text: 'Which items a subagent was shown, and with pointOfAction on which an agent was shown when it read or edited anchored code, by item id with its anchored file paths, the session and agent ids, the estimated tokens and the time, in logs/injections.jsonl; never their text. memory purge removes the lines of the items it deletes, --older-than the lines older than its cut-off, and --all the file' },
  { id: 'import', since: 1, text: 'When you run memory import: the auto memory files of every Claude Code config bound here, and the review-standards, rejections, Review Voice policy and notes files, listed under imports in config.json; each statement is stored as a proposal that waits for your approval' },
  { id: 'embeddings', since: 13, text: "Embeddings, only when embeddings in config.json names a provider (off by default; a local Ollama with an embedding model you install, or voyage-4, which needs VOYAGE_API_KEY): the text of each active item you remember or approve, and the words of each memory_search query and the changed files' names of memory recall --diff, are sent to that provider and the vectors that come back are kept in the item's own file. A tenant's text is sent only to a provider on this machine (an address of 127.0.0.1, localhost or [::1]); one elsewhere gets the person file's text only. When rerank in config.json names a generative model (off by default; Inkling 2 Mini on the same local Ollama unless set, which you install), each memory_search query or memory recall --diff file list and the statements of the rows it found are sent to it to reorder them, under the same rule for a tenant's text. Quarantined text is never sent, and no hook uses either. Without a provider, a key or a network, nothing is sent and recall uses words and paths only" },
  { id: 'capture', since: 3, text: "At the end of a session in a repository that matches a tenant: the session transcript's user and assistant text, newest 48,000 characters at most, with credentials, emails and handles replaced, is sent to Anthropic's API (key ANTHROPIC_API_KEY, model set in config capture) so a small model can pick out lessons and decisions; what it keeps is stored as active items with agent trust, and the tokens used per run go to logs/capture.jsonl, never the transcript. Turn it off with capture.enabled false in config.json" },
  { id: 'decisions', since: 5, text: "When you run memory import with decisions set under imports: Review Voice's SQLite store is opened read-only. It holds findings and decisions for every repository it reviewed; those of other repositories are read and then filtered out, and only the checkout's own repository's owner and team decisions are kept, each as a proposal that waits for your approval. The finding text came from a model, so it is checked as agent-written" },
  { id: 'orbit', since: 6, text: "When you run memory import --orbit: each listed checkout's Orbit knowledge store (.orbit/knowledge.sqlite unless imports names another) is opened read-only. Its validated repository lessons, the runs that supported or contradicted them and the failure fingerprints and check ids of runs that ended without succeeding are kept as proposals in the checkout's tenant, agent-trusted, waiting for your approval. Lessons of Orbit's global graph are not read. memory recall --orbit, called by Orbit, reads active items and the checkout's .orbit/config.yaml and writes nothing" },
  { id: 'failures', since: 7, text: "Failures that were fixed (#18): memory ci reads this repository's GitHub Actions runs with gh run list and, for a failed run followed by a passing run on another commit, the failed run's log with gh run view --log-failed; Orbit's run-end observations count the same way. The log line that names the failure, with credentials, emails, handles and committers' names replaced, is kept in a repair proposal that waits for your approval; the rest of the log is not kept. When you turn on the separate opt-in for failing commands (memory init --failing-commands on), a failed Bash command in a session is also kept as an episode: its scrubbed error line, the command's program and subcommand only (npm run build; never its arguments, flags, paths or environment), a hash of the command and the directory it ran in, the failure's fingerprint, the session id, the commit it failed at and the time, in the tenant's file, deleted after 30 days, and the same command passing later in that session, after a new commit, becomes a repair proposal. Commits and reverts are tracked without that opt-in: the commit hash of each commit made in a session, with the ids of the items shown in that session, and each revert of such a commit made by you (the commit's subject Revert or Reapply, its body naming the hash); a revert counts as a contradiction of those items, and two such reverts within seven days turn recall off until you run memory init --recall on. memory purge removes episodes with the items it deletes and --older-than removes episodes older than its cut-off" },
  { id: 'impact', since: 8, text: "When impactProvider is set in config.json, memory recall --diff runs that command, without a shell, once per call and sends it on standard input the repository's owner/name, the range and the paths the range changes; what it answers (dependents' paths and symbol keys) is used to rank items and is not stored. A provider backed by a code graph may start an index job of its own to answer, and a graph that has no snapshot yet answers pending, which memory reads as no snapshot. Without impactProvider, or before you agree to this plan, nothing is run" },
  { id: 'symbols', since: 9, text: "When impactProvider is set in config.json, the anchor refresh (#10) runs that command, which you chose, without a shell and with only PATH and HOME in its environment, once per question: at session start in a detached job, and when you remember an anchor at a symbol key or run memory anchors. It sends on standard input the repository's owner/name, the symbol keys, file paths, line numbers and snapshot ids of the checkout's anchored items; it answers with symbols' keys, signatures, line ranges and content hashes. memory sends nothing elsewhere and what the command does with what it receives is outside memory. Each automatic move of an anchor is logged in the tenant's file and can be undone with memory anchors undo. Without impactProvider, or before you agree to this plan, anchors are checked by path and hash only" },
  { id: 'transcripts', since: 10, text: "When you turn on the separate opt-in for transcripts (memory init --transcripts on), in a repository that matches a tenant: at the end of a session only the path of the session's transcript file, with the session id, the repository and the time, is recorded in the tenant's file; at the next session start or in the daily sweep memory reads that file on this machine, never sending it anywhere, takes only your own messages, replaces credentials, emails and handles in them, and keeps each correction you gave the agent (a sentence such as 'no, use the other branch') as a proposal that quotes your words verbatim, with the session id and line as its source, waiting for your approval. Nothing of the transcript is kept besides those quotes; agent output, subagent reports and tool results are never read as corrections, text between <private> and </private> and a transcript containing DO NOT INDEX THIS CHAT are skipped. After a compaction the compaction summary, redacted, is kept as an episode. The path records and episodes are deleted after 30 days; memory purge removes them with the tenant and --older-than removes those before its cut-off. With the opt-in off, or before you agree to this plan, nothing is recorded" },
  { id: 'scf', since: 11, text: "When you run memory export --to scf, or memory import --scf, for a tenant that has an SCF address in config.json (memory init --scf <tenant>=<url>, https only, or http to this machine), with the key in SCF_API_KEY: that tenant's proposed repository and organisation items are sent to that address as proposals: the statement, type, scope, repository name, rationale, anchored paths and symbols, and each evidence's source reference, role and time, with credentials replaced; an item that holds one is not sent. The tenant's person-file items and every other tenant's items are never sent. memory import --scf asks the same address for the decisions on those proposals and for the run outcomes on accepted ones, and applies them to the items it sent. Nothing is sent for a tenant without an address, or before you agree to this plan" },
  { id: 'personTranscripts', since: 12, text: "With the transcripts opt-in on, a session whose working directory matches no tenant is recorded the same way in the person file: the transcript's path, the session id, the repository if there is one and the time, deleted after 30 days. At the next session start or sweep memory reads your own messages in it on this machine, as above, and keeps each correction about your own habits as a person proposal quoting you verbatim; a correction that names a path, code, a tenant or a repository is not kept" },
  { id: 'transcriptModel', since: 12, text: "When transcriptModel is set in config.json and you run memory corrections (never in a hook): your own messages of each transcript recorded above, read and redacted as above, are sent to the model it names (Inkling 2 Mini by default, which you install; memory never downloads a model) at its address (a local Ollama at http://127.0.0.1:11434 by default), through the provider runner, so it can find corrections the rules miss. Only a quote found verbatim in your messages is kept, as a proposal. A tenant's messages are sent only to a model on this machine (an address of 127.0.0.1, localhost or [::1]); an address elsewhere is used for the person file only. Without transcriptModel, or before you agree to this plan, nothing is sent" },
] as const;
export const PLAN_VERSION = Math.max(...DATA_CATEGORIES.map((c) => c.since));

/** The categories the owner's consent does not cover; a consent saved before plans had a version agreed to version 1. */
export const uncovered = (config: Config): (typeof DATA_CATEGORIES)[number][] =>
  DATA_CATEGORIES.filter((c) => c.since > (config.consent?.version ?? 1));
export const covers = (config: Config, id: (typeof DATA_CATEGORIES)[number]['id']): boolean =>
  !uncovered(config).some((c) => c.id === id);

export interface ConsentPlan {
  /** Which data categories this plan discloses; a consent records the version it agreed to. */
  version: number;
  tenants: Record<string, string[]>;
  configs: Record<string, string[]>;
  /** Exactly what will be read and kept, in the user's terms. */
  dataCategories: string[];
  /** Separate opt-ins, each off until the owner turns it on. */
  optIns: { transcripts: boolean; failingCommands: boolean };
  /** Whether sessions started by automation (headless runs, CI jobs) may capture and propose; off unless you turn it on. */
  automationSessions: boolean;
  /** Where each tenant's proposals go when the owner runs memory export --to scf; empty when none does. */
  scfDestinations: Record<string, string>;
  storageLocation: string;
  retention: string[];
}

/**
 * The disclosure shown before anything is stored. It is concrete on purpose:
 * a user cannot agree to a scope they have to infer.
 */
export function buildConsentPlan(config: Config, storageLocation: string): ConsentPlan {
  return {
    version: PLAN_VERSION,
    tenants: config.tenants,
    configs: config.configs,
    dataCategories: DATA_CATEGORIES.map((c) => c.text),
    optIns: { ...config.optIns },
    automationSessions: config.automation === true,
    scfDestinations: Object.fromEntries(Object.entries(config.scf ?? {}).map(([tenant, { url }]) => [tenant, url])),
    storageLocation,
    retention: [
      'Statements matching a known credential pattern, or carrying an email address, a handle or a webhook URL, are refused and never stored',
      'Person and global statements are refused unless they name no code, path, tenant or repository',
      'Items are kept until you purge them with memory purge --tenant, --repo, --item, --source or --all; a purge overwrites what it deletes, so it cannot be read back from the files memory keeps. Backups, file-system snapshots and swap are outside its reach',
      'A rejected item is kept as a tombstone, reduced to a hash of its statement, its type and its scope 30 days after rejection, so the statement is never proposed again',
      'memory purge --older-than N deletes evidence older than N days; an item left without evidence stays on disk as proposed and is no longer shown',
      'Each tenant has its own file; a session opens only the tenant its repository and config allow',
      'The store never leaves this machine; the only text that does is what the embeddings, capture and scf categories above list: item and query text to the embedding provider (for a tenant, only one on this machine), the redacted transcript to the capture model, and, when you run memory export --to scf, a tenant\'s proposals with their evidence to the SCF address set for it',
    ],
  };
}
