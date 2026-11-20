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
  writeOperations: 'none';
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
      "The working directory's git origin remote, read at session start to find its tenant",
    ],
    optIns: { ...config.optIns },
    storageLocation,
    retention: [
      'Statements carrying a secret, an email address, a handle or a webhook URL are refused and never stored',
      'Person and global statements are refused unless they name no code, path, tenant or repository',
      'Items are kept until you purge them: memory purge --tenant, --repo, --older-than or --all',
      'Each tenant has its own file; a session opens only the tenant its repository and config allow',
      'Nothing is uploaded; the store never leaves this machine',
    ],
    writeOperations: 'none',
  };
}
