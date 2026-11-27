import type { DatabaseSync } from 'node:sqlite';
import { addItem } from '../consolidate.ts';
import { git } from '../context.ts';
import { MAX_STATEMENT, refusal } from '../gate.ts';
import { committerNames, scrubFailure } from './failures.ts';

/** Proposals stored per run, newest first, so the review queue is not flooded (#145). */
export const SEED_LIMIT = 20;
/** Files anchored per proposal. shortcut: a wide commit's later files are dropped; anchor by symbol if that loses recall. */
const MAX_ANCHORS = 10;

export interface SeedCandidate {
  sha: string;
  at: string;
  statement: string;
  /** The changed files that still exist at HEAD. */
  files: string[];
  /** The whole message, scrubbed, for the model pass only; never stored. */
  message: string;
}

/** A sentence that gives a reason. shortcut: English cue words only; the model pass does not widen it. */
const CUE = /\b(?:because|so that|must|never|instead of)\b(?!-)/i;
const BOT = /\[bot\]|^(?:dependabot|renovate|github-actions)\b/i;
const PREFIX = /^\w+(?:\([^)]*\))?!?:\s+/;

/** The message as sentences: paragraphs and list items are joined across wrapped lines, then split at sentence ends. Trailers are dropped. */
function sentences(text: string): string[] {
  const chunks: string[] = [];
  let open = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || /^(?:Co-authored-by|Signed-off-by|Reviewed-by|Change-Id|Refs?|Fixes|Closes):/i.test(t)) {
      open = false;
      continue;
    }
    const item = /^[-*]\s+/.test(t);
    if (!open || item) chunks.push(t.replace(/^[-*]\s+/, ''));
    else chunks[chunks.length - 1] += ` ${t}`;
    open = true;
  }
  return chunks.flatMap((c) => c.split(/(?<=[.!?])\s+/)).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** One statement: no conventional-commit prefix, a capital first letter and a full stop. */
const tidy = (s: string): string => {
  const t = s.replace(PREFIX, '').trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
};

/**
 * The rule pass: a revert with a body gives its reason (the sentence with a cue, else its first), any other commit the
 * first sentence of its message that carries a cue. Null when there is none, or when scrubbing would change the
 * sentence (it names a committer, an email, a handle or a credential): such a sentence is dropped, never kept redacted.
 */
export function reasonOf(message: string, names: string[]): string | null {
  const [subject = '', ...rest] = message.split('\n');
  const reverted = /^(?:Revert|Reapply) "(.+)"\s*$/.exec(subject.trim())?.[1];
  let statement: string | undefined;
  if (reverted !== undefined) {
    const body = sentences(rest.join('\n')).filter((s) => !/^This reverts commit [0-9a-f]{7,40}/.test(s));
    const why = body.find((s) => CUE.test(s)) ?? body[0];
    if (why !== undefined) statement = `Reverted "${reverted.replace(PREFIX, '')}": ${tidy(why)}`;
  } else {
    const why = sentences(message).find((s) => CUE.test(s));
    if (why !== undefined) statement = tidy(why);
  }
  if (statement === undefined || statement.length > MAX_STATEMENT || statement.split(/\s+/).length < 4) return null;
  if (scrubFailure(statement, names) !== statement || refusal(statement) !== null) return null;
  return statement;
}

/**
 * Reads this repository's history with `git log`, newest first, merges and bots' commits skipped, and returns one
 * candidate per commit that gives a reason and changed a file that still exists at HEAD. Null when git could not read it.
 */
export function seedCandidates(cwd: string, since: string): SeedCandidate[] | null {
  let log: string | null;
  let tree: string | null;
  try {
    log = git(cwd, 'log', '--no-merges', `--since=${since}`, '--name-only', '--format=%x1e%H%x1f%cI%x1f%an%x1f%ae%x1f%cn%x1f%B%x1d');
    tree = git(cwd, 'ls-tree', '-r', '--name-only', '--full-tree', 'HEAD');
  } catch {
    return null;
  }
  if (log === null || tree === null) return null;
  const head = new Set(tree.split('\n').filter(Boolean));
  const records = log.split('\x1e').slice(1).map((r) => {
    const [meta = '', files = ''] = r.split('\x1d');
    const [sha = '', at = '', author = '', email = '', committer = '', message = ''] = meta.split('\x1f');
    return { sha, at, author, email, committer, message: message.trim(), files: files.split('\n').map((f) => f.trim()).filter(Boolean) };
  });
  const names = [...new Set([...committerNames(cwd), ...records.flatMap((r) => [r.author, r.committer]).filter((n) => n.trim().length >= 3)])];
  const out: SeedCandidate[] = [];
  for (const r of records) {
    if (!/^[0-9a-f]{40}$/.test(r.sha) || BOT.test(r.author) || BOT.test(r.email)) continue;
    const files = r.files.filter((f) => head.has(f));
    if (files.length === 0) continue;
    const statement = reasonOf(r.message, names);
    if (statement === null) continue;
    out.push({ sha: r.sha, at: Number.isNaN(Date.parse(r.at)) ? new Date().toISOString() : new Date(r.at).toISOString(), statement, files: files.slice(0, MAX_ANCHORS), message: scrubFailure(r.message, names) });
  }
  return out;
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** The model's rewrite, kept only when every word of it is in the commit message and the gate takes it; else the rule's sentence. */
export function keepRewrite(c: SeedCandidate, rewrite: string): string {
  const own = new Set(words(c.message));
  const t = rewrite.replace(/\s+/g, ' ').trim();
  return t !== '' && words(t).every((w) => own.has(w)) && refusal(t) === null ? t : c.statement;
}

/** Asks the model to rewrite one candidate: the sentence, or why it failed. */
export type Rewrite = (c: SeedCandidate) => string | { failed: string };

export interface Seeded {
  lines: string[];
  stored: number;
  left: number;
  failed?: string;
}

const sourceOf = (c: SeedCandidate): string => `commit:${c.sha}`;

/**
 * Stores candidates newest first as agent-trusted proposals until SEED_LIMIT are new. A commit already evidence for an
 * item is skipped before the model is asked, so a rerun stores nothing new; a rejected statement stays rejected. The
 * first model failure ends the model pass, not the run.
 */
export function seed(db: DatabaseSync, repo: { tenant: string; repository: string }, candidates: SeedCandidate[], rewrite?: Rewrite): Seeded {
  const done: Seeded = { lines: [], stored: 0, left: 0 };
  for (const [i, c] of candidates.entries()) {
    if (done.stored >= SEED_LIMIT) {
      done.left = candidates.length - i;
      break;
    }
    const short = c.sha.slice(0, 7);
    if (db.prepare('SELECT 1 FROM evidence WHERE source_ref = ?').get(sourceOf(c)) !== undefined) {
      done.lines.push(`${short}: already known`);
      continue;
    }
    let statement = c.statement;
    if (rewrite !== undefined && done.failed === undefined) {
      const r = rewrite(c);
      if (typeof r === 'string') statement = keepRewrite(c, r);
      else done.failed = r.failed;
    }
    const stored = addItem(db, {
      tenant: repo.tenant, scope: 'repository', scopeKey: repo.repository, type: 'decision', statement, rationale: null,
      anchors: c.files.map((path) => ({ path })), source: sourceOf(c), trust: 'agent', status: 'proposed', evidenceAt: c.at,
      extractor: statement === c.statement ? 'deterministic' : 'model',
    });
    if (stored.kind === 'inserted' || stored.kind === 'superseded-on-arrival') done.stored++;
    done.lines.push(
      `${short}: ${
        stored.kind === 'inserted' ? `proposed ${stored.id}` : stored.kind === 'superseded-on-arrival' ? `proposed ${stored.id}, already superseded by ${stored.by}` : stored.kind === 'rejected' ? 'rejected before' : `merged into ${stored.id}`
      }`,
    );
  }
  return done;
}

/** A model answer, `{"status":"ok","statement":"..."}` on its first line; anything else is a failure. */
export function parseRewrite(stdout: string): string | { failed: string } {
  try {
    const o = JSON.parse(stdout.split('\n')[0]!) as { status?: unknown; statement?: unknown };
    return o?.status === 'ok' && typeof o.statement === 'string' ? o.statement : { failed: 'it did not answer status ok with a statement' };
  } catch {
    return { failed: 'it answered text that is not JSON' };
  }
}
