import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { addItem } from '../consolidate.ts';
import { currentConfigDir, loadConfig, saveConfig, type Config } from '../config.ts';
import { covers } from '../consent/plan.ts';
import { resolveContext } from '../context.ts';
import { fingerprintFailure } from '../fingerprint.ts';
import { refusal } from '../gate.ts';
import { SIGNATURE_END, weakSignature } from '../hooks/failure.ts';
import { HOOK_BUSY_MS, openStore } from '../store/db.ts';
import { tenantFile } from '../store/paths.ts';
import { inTransaction } from '../store/transaction.ts';
import { scrub } from './capture.ts';
import { isGitRevert, scanReverts, type RevertScan } from './reverts.ts';

/** Episodes are deleted after this many days (FR-006 of #18). */
export const EPISODE_DAYS = 30;
const MAX_COMMAND = 160;
const MAX_SIGNATURE = 150;

/** Whether the owner's consent covers the failure categories and the separate failing-commands opt-in is on. */
const episodesOn = (config: Config | null): config is Config => config !== null && config.optIns.failingCommands && covers(config, 'failures');

/** Commands memory never captures: the tools' own commits, pushes and posts, and memory itself. */
export const ownCommand = (command: string): boolean => /\bgit\s+(?:commit|push)\b|\bgh\s+(?:pr|issue|release|api)\b|memory\.mjs|\bmemory\s+\w/.test(command);

export const git = (cwd: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return null;
  }
};

/** Programs whose next words are subcommands (`npm run build`), not arguments; for any other program only its name is kept. */
const SUBCOMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'dotnet', 'make', 'gradle', 'mvn', 'pip', 'poetry', 'uv', 'pytest', 'tsc', 'node', 'docker']);

/**
 * What of a command is kept: its program (no directory) and, for a known tool, up to two plain subcommand words, so
 * `DB_PASSWORD=x npm run build --token=y` is `npm run build`. Environment assignments, flags, paths, URLs and every other
 * argument are dropped, because any of them may carry a secret or a user name. Empty when nothing safe is left.
 */
export function safeCommand(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  while (words[0] !== undefined && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
  const program = words.shift()?.split('/').pop() ?? '';
  if (!/^[\w.+-]{1,40}$/.test(program)) return '';
  const out = [program];
  if (SUBCOMMANDS.has(program)) {
    for (const w of words.slice(0, 2)) {
      if (!/^[a-z][a-z0-9:_-]{0,20}$/i.test(w)) break;
      out.push(w);
    }
  }
  return out.join(' ');
}

/** An episode is for one command in one directory of the repository: `npm test` in packages/a is not `npm test` in packages/b. */
const key = (command: string, cwd: string): string => createHash('sha256').update(`${git(cwd, 'rev-parse', '--show-prefix')?.trim() ?? ''}\0${safeCommand(command)}`).digest('hex').slice(0, 16);

/** The names of this repository's committers and authors, which no captured text may carry. */
export function committerNames(cwd: string): string[] {
  const out = git(cwd, 'log', '-n', '500', '--format=%an%n%cn') ?? '';
  return [...new Set(out.split('\n').map((n) => n.trim()).filter((n) => n.length >= 3))];
}

/** Everything that must not be kept: credentials, emails, handles, webhook URLs, and the committers' names. */
export function scrubFailure(text: string, names: string[]): string {
  // Every home directory's user name goes to `u`; then the committers' names and this machine's user name anywhere.
  // The user's directory name becomes `u`, so the line still normalises to the same path as the live error does.
  let out = scrub(text).replace(/(\/(?:home|Users)\/|[A-Za-z]:\\Users\\)[^\s/\\'"():]+/g, '$1u');
  const own = [userInfo().username, process.env['USER'], process.env['USERNAME']].filter((n): n is string => typeof n === 'string' && n.length >= 3);
  for (const n of [...names, ...own]) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'giu'), '[REDACTED:NAME]');
  return out;
}

/**
 * The one error line to recall a failure by, from an already scrubbed error: a line of Orbit's fingerprint that failure
 * recall can match (slice 12's rules: two words that are not common ones, no ` => `, nothing the gate refuses), the one
 * with the most words. Null when no line qualifies, and then no proposal is made. Raw error text is never kept: this is
 * one normalised line.
 */
export function signatureOf(scrubbed: string, exitCode: number | null): { fingerprint: string; signature: string | null } {
  const { fingerprint, signature } = fingerprintFailure(scrubbed, exitCode);
  // A redaction token is never in the live error that recall reads, so a signature keeps the words around it, not the token.
  const ok = signature
    .map((l) => l.replace(/\[REDACTED:[A-Z_]+\]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length <= MAX_SIGNATURE && !l.includes(SIGNATURE_END) && !l.startsWith('exit:') && !weakSignature(l) && refusal(l) === null)
    .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
  return { fingerprint, signature: ok[0] ?? null };
}

/** A repair proposal: the signature, then what is known of the fix. Null when the gate refuses the statement or the source. */
export function proposeRepair(
  db: DatabaseSync,
  context: { tenant: string; repository: string },
  r: { signature: string; fingerprint: string; fix: string; how: string; source: string; evidenceAt?: string },
): string | null {
  const statement = `${r.signature}${SIGNATURE_END}${r.how} after the fix at ${r.fix}`;
  if (refusal(statement) !== null || refusal(r.source) !== null) return null;
  const stored = addItem(db, {
    tenant: context.tenant, scope: 'repository', scopeKey: context.repository, type: 'repair-recipe', statement, rationale: null, anchors: [],
    source: r.source, trust: 'agent', status: 'proposed', exactOnly: true, ...(r.evidenceAt === undefined ? {} : { evidenceAt: r.evidenceAt }),
  });
  if (!('id' in stored)) return null;
  db.prepare("INSERT OR IGNORE INTO item_keys (item_id, kind, key) VALUES (?, 'fingerprint', ?)").run(stored.id, r.fingerprint);
  return stored.id;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const commandOf = (input: Record<string, unknown>): string | undefined => str((input['tool_input'] as { command?: unknown } | undefined)?.command);
const cutoff = (): string => new Date(Date.now() - EPISODE_DAYS * 864e5).toISOString();

/** Deletes episodes past their 30 days. */
export function expireEpisodes(db: DatabaseSync): void {
  if (db.prepare('SELECT 1 FROM episodes WHERE at < ? LIMIT 1').get(cutoff()) !== undefined) db.prepare('DELETE FROM episodes WHERE at < ?').run(cutoff());
}

/**
 * The PostToolUseFailure hook's second job (#18, FR-002): with the failing-commands opt-in on, a failed Bash command
 * becomes a scrubbed episode. With it off this returns before opening any store. Never a command memory ran itself.
 */
export function recordEpisode(data: string, input: Record<string, unknown>): void {
  const config = loadConfig(data);
  const error = str(input['error']);
  const command = commandOf(input);
  if (!episodesOn(config) || input['tool_name'] !== 'Bash' || input['is_interrupt'] === true || error === undefined || command === undefined || ownCommand(command)) return;
  const cwd = str(input['cwd']) ?? process.cwd();
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null) return;
  const names = committerNames(cwd);
  const safe = scrubFailure(safeCommand(command), names);
  if (safe === '') return;
  const code = /^Exit code (\d+)/.exec(error)?.[1];
  const { fingerprint, signature } = signatureOf(scrubFailure(error, names), code === undefined ? null : Number(code));
  const db = openStore(tenantFile(data, context.tenant), true, HOOK_BUSY_MS)!;
  try {
    inTransaction(db, () => {
      expireEpisodes(db);
      db.prepare(
        `INSERT INTO episodes (id, session, command_key, command, fingerprint, signature, head, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session, command_key, fingerprint) DO UPDATE SET at = excluded.at, head = excluded.head, repaired_at = NULL`,
      ).run(
        `x-${randomBytes(5).toString('hex')}`, str(input['session_id']) ?? 'unknown', key(command, cwd),
        safe.slice(0, MAX_COMMAND), fingerprint, signature ?? '', git(cwd, 'rev-parse', 'HEAD')?.trim() ?? '', new Date().toISOString(),
      );
    });
  } finally {
    db.close();
  }
}

/** Items shown in this session at the point of action or at a failure; both tables are made on first use. */
function shownItems(db: DatabaseSync, session: string): string[] {
  const ids = new Set<string>();
  for (const table of ['ledger', 'failure_ledger']) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) continue;
    for (const r of db.prepare(`SELECT DISTINCT item_id FROM ${table} WHERE session = ?`).all(session) as { item_id: string }[]) ids.add(r.item_id);
  }
  return [...ids];
}

/**
 * The PostToolUse hook on Bash. A command that passes is looked for among this session's open episodes (only with the
 * opt-in on) and becomes a repair proposal; a `git commit` is linked to the items this session was shown; a `git revert`
 * is counted (#18). Any other command returns before opening a store, and nothing here takes the write lock unless it
 * writes. Returns the hook's JSON, or '' for nothing.
 */
export function commandPassed(data: string, input: Record<string, unknown>): string {
  const config = loadConfig(data);
  const command = commandOf(input);
  if (config === null || !covers(config, 'failures') || input['tool_name'] !== 'Bash' || command === undefined) return '';
  const commits = /\bgit\s+commit\b/.test(command);
  const reverts = isGitRevert(command);
  const episodes = episodesOn(config) && !ownCommand(command);
  if (!commits && !reverts && !episodes) return '';
  const cwd = str(input['cwd']) ?? process.cwd();
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null) return '';
  const session = str(input['session_id']) ?? 'unknown';
  const db = openStore(tenantFile(data, context.tenant), false, HOOK_BUSY_MS);
  if (db === null) return '';
  try {
    if (episodes) repairOpenEpisodes(db, { tenant: context.tenant, repository: context.repository }, session, command, cwd);
    if (commits) {
      const items = shownItems(db, session);
      const sha = git(cwd, 'rev-parse', 'HEAD')?.trim();
      if (items.length > 0 && sha !== undefined && sha !== '') {
        inTransaction(db, () => {
          const put = db.prepare('INSERT OR IGNORE INTO commit_items (commit_sha, item_id, session, at) VALUES (?, ?, ?, ?)');
          for (const id of items) put.run(sha, id, session, new Date().toISOString());
        });
      }
    }
    return reverts ? revertMessage(data, config, scanReverts(db, cwd)) : '';
  } finally {
    db.close();
  }
}

/** The same command passing in the same session as an open episode: the episode closes and, when its signature can be recalled, a repair is proposed. */
function repairOpenEpisodes(db: DatabaseSync, repo: { tenant: string; repository: string }, session: string, command: string, cwd: string): void {
  const open = db.prepare('SELECT id, command, fingerprint, signature, head FROM episodes WHERE session = ? AND command_key = ? AND repaired_at IS NULL AND at >= ?').all(session, key(command, cwd), cutoff()) as
    { id: string; command: string; fingerprint: string; signature: string; head: string }[];
  if (open.length === 0) return;
  const now = git(cwd, 'rev-parse', 'HEAD')?.trim() ?? '';
  // A pass at the commit the command failed at is a retry, not a repair: no proposal, and the episode stays open for a later commit.
  const fixed = open.filter((e) => now !== '' && now !== e.head);
  if (fixed.length === 0) return;
  inTransaction(db, () => {
    for (const e of fixed) {
      const fix = now.slice(0, 7);
      if (e.signature !== '') {
        proposeRepair(db, repo, { signature: e.signature, fingerprint: e.fingerprint, fix, how: `\`${e.command}\` passed`, source: `session:${session} fingerprint:${e.fingerprint} passed-after:${fix}` });
      }
      db.prepare('UPDATE episodes SET repaired_at = ? WHERE id = ?').run(new Date().toISOString(), e.id);
    }
  });
}

/** Turns recall off when a scan found two linked reverts within seven days and says why; otherwise says what was counted. */
export function revertMessage(data: string, config: Config, scan: RevertScan): string {
  if (scan.pair !== null && config.recallOff === undefined) {
    const reason = `two memory-linked reverts within seven days (${scan.pair[0].slice(0, 7)} and ${scan.pair[1].slice(0, 7)})`;
    saveConfig(data, { ...config, recallOff: { reason, at: new Date().toISOString() } });
    return JSON.stringify({ systemMessage: `memory turned recall off: ${reason}. Run memory init --recall on to turn it on again.` });
  }
  return scan.counted > 0 ? JSON.stringify({ systemMessage: `memory: ${scan.counted} revert${scan.counted === 1 ? '' : 's'} counted against the items shown with the reverted change` }) : '';
}
