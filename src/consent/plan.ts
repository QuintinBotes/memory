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
  { id: 'injections', since: 2, text: 'Which items a subagent was shown, by item id with its anchored file paths, the session and agent ids, the estimated tokens and the time, in logs/injections.jsonl; never their text. memory purge removes the lines of the items it deletes, --older-than the lines older than its cut-off, and --all the file' },
  { id: 'import', since: 1, text: 'When you run memory import: the auto memory files of every Claude Code config bound here, and the review-standards, rejections, Review Voice policy and notes files, and the decisions in a Review Voice store (read-only), listed under imports in config.json; each statement is stored as a proposal that waits for your approval' },
  { id: 'embeddings', since: 4, text: "Embeddings, with the provider in config.json (voyage-4 by default, which needs VOYAGE_API_KEY): the text of each active item you remember or approve, and the words of each memory_search query, are sent to the provider's servers and the vectors that come back are kept in the item's own file. Quarantined text is never sent. Without a key or a network, nothing is sent and recall uses words and paths only" },
  { id: 'capture', since: 3, text: "At the end of a session in a repository that matches a tenant: the session transcript's user and assistant text, newest 48,000 characters at most, with credentials, emails and handles replaced, is sent to Anthropic's API (key ANTHROPIC_API_KEY, model set in config capture) so a small model can pick out lessons and decisions; what it keeps is stored as active items with agent trust, and the tokens used per run go to logs/capture.jsonl, never the transcript. Turn it off with capture.enabled false in config.json" },
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
    storageLocation,
    retention: [
      'Statements matching a known credential pattern, or carrying an email address, a handle or a webhook URL, are refused and never stored',
      'Person and global statements are refused unless they name no code, path, tenant or repository',
      'Items are kept until you purge them with memory purge --tenant, --repo, --item, --source or --all; a purge overwrites what it deletes, so it cannot be read back from the files memory keeps. Backups, file-system snapshots and swap are outside its reach',
      'A rejected item is kept as a tombstone, reduced to a hash of its statement, its type and its scope 30 days after rejection, so the statement is never proposed again',
      'memory purge --older-than N deletes evidence older than N days; an item left without evidence stays on disk as proposed and is no longer shown',
      'Each tenant has its own file; a session opens only the tenant its repository and config allow',
      'The store never leaves this machine; the only text that does is what the embeddings category above lists, and only when a provider key is set',
    ],
  };
}
