// Adapted from Review Voice, plugins/review-voice/src/consent/plan.ts at 707ba60
// (https://github.com/QuintinBotes/review-voice, MIT).
import type { Config } from '../config.ts';

export interface ConsentPlan {
  tenants: Record<string, string[]>;
  configs: Record<string, string[]>;
  /** Exactly what will be read and kept, in the user's terms. */
  dataCategories: string[];
  /** Separate opt-ins, each off until the owner turns it on. */
  optIns: { transcripts: boolean; failingCommands: boolean };
  storageLocation: string;
  retention: string[];
}

/**
 * The disclosure shown before anything is stored. It is concrete on purpose:
 * a user cannot agree to a scope they have to infer.
 */
export function buildConsentPlan(config: Config, storageLocation: string): ConsentPlan {
  return {
    tenants: config.tenants,
    configs: config.configs,
    dataCategories: [
      'Statements you ask memory to remember, each with its scope, type and an optional source reference',
      'For an anchored statement: the file path, line range, commit and a hash of the cited lines, not the lines themselves',
      "The working directory's git origin remote, read at session start, after a compaction and at a subagent's start to find its tenant",
      'Which items a subagent was shown, by item id, with the session and agent ids and the estimated tokens, in logs/injections.jsonl; never their text',
      'When you run memory import: the auto memory files of every Claude Code config bound here, and the review-standards, rejections, Review Voice policy and notes files listed under imports in config.json; each statement is stored as a proposal that waits for your approval',
    ],
    optIns: { ...config.optIns },
    storageLocation,
    retention: [
      'Statements matching a known credential pattern, or carrying an email address, a handle or a webhook URL, are refused and never stored',
      'Person and global statements are refused unless they name no code, path, tenant or repository',
      'Items are kept until you purge them with memory purge --tenant, --repo or --all',
      'A rejected item is kept as a tombstone, reduced to a hash of its statement, its type and its scope 30 days after rejection, so the statement is never proposed again',
      'memory purge --older-than N deletes evidence older than N days; an item left without evidence stays on disk as proposed and is no longer shown',
      'Each tenant has its own file; a session opens only the tenant its repository and config allow',
      'Nothing is uploaded; the store never leaves this machine',
    ],
  };
}
