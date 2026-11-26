import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import type { Readable, Writable } from 'node:stream';
import { supersedeNow } from '../../consolidate.ts';
import { insertItem, tenantItems, textMatches, type NewItem } from '../../items.ts';
import { rank, searchTerms } from '../../recall/rank.ts';
import { withTextRatio } from '../../recall/visible.ts';
import { LEAN_ROW_TOKENS, leanRow } from '../../render/rows.ts';
import { openStore } from '../../store/db.ts';
import type { Evidence, Question, ReplaySet } from './replay-set.ts';

/**
 * FR-002 of #25: an arm ingests the evidence before the cut-off, then answers each question with the texts it would put
 * in the agent's context, best first; an empty list is silence. The harness times each answer on this machine.
 */
export interface Arm {
  ingest(set: ReplaySet): Promise<void>;
  answer(q: Question): Promise<string[]>;
  close(): void;
}

const TYPE: Record<Evidence['kind'], string> = { decision: 'decision', correction: 'convention', lesson: 'precedent', hazard: 'hazard', failure: 'failure-pattern', 'code-change': '' };

/**
 * This plugin, as `memory_search` answers: a throwaway store holding the evidence as active items, a supersession applied
 * as the owner's approval applies it, and the question's words, path and as-of date ranked as the tool ranks them.
 * shortcut: a code change marks the items anchored at its path stale, as `memory recheck` does once the cited lines are
 * gone, without a git checkout to check against; replay real commits when the history carries them.
 */
export function memoryArm(): Arm {
  const dir = mkdtempSync(join(tmpdir(), 'memory-head-to-head-'));
  const db: DatabaseSync = openStore(join(dir, 'arm.sqlite'), true)!;
  let set: ReplaySet;
  const item = new Map<string, string>();
  const evidence = new Map<string, string>();
  return {
    async ingest(s) {
      set = s;
      for (const e of s.ingest) {
        if (e.kind === 'code-change') {
          for (const i of tenantItems(db, s.tenant, s.repository, s.repository.split('/')[0]!)) {
            if (i.anchors.some((a) => a.path === e.path)) db.prepare("UPDATE items SET status = 'stale', status_reason = ? WHERE id = ?").run(`${e.path} changed`, i.id);
          }
          continue;
        }
        const c: NewItem = {
          tenant: s.tenant, scope: 'repository', scopeKey: s.repository, type: TYPE[e.kind], statement: e.statement, rationale: null,
          anchors: e.path === undefined ? [] : [{ path: e.path }], source: `history ${e.id}`, evidenceAt: e.at,
        };
        const older = e.supersedes === undefined ? undefined : item.get(e.supersedes);
        const id = (older === undefined ? null : supersedeNow(db, c, older))?.id ?? insertItem(db, c);
        // The replay cannot set the clock, so each version is dated by its evidence, as if captured then; reinforced_at keeps
        // the capture time, so confidence and expiry read as before.
        const at = new Date(e.at).toISOString();
        db.prepare('UPDATE items SET reinforced_at = coalesce(reinforced_at, valid_from), valid_from = ? WHERE id = ?').run(at, id);
        if (older !== undefined) db.prepare("UPDATE items SET valid_to = ? WHERE id = ? AND status = 'superseded'").run(at, older);
        item.set(e.id, id);
        evidence.set(id, e.id);
      }
    },
    async answer(q) {
      // Evidence ids, not random store ids, so a tie breaks the same way every run.
      // A temporal question carries its time, and asks memory_search as of it (#102).
      const items = withTextRatio(tenantItems(db, set.tenant, set.repository, set.repository.split('/')[0]!, q.asOf), textMatches(db, searchTerms(q.question)))
        .map((i) => ({ ...i, id: evidence.get(i.id)! }));
      return rank(items, q.path === undefined ? [] : [q.path], Date.now(), undefined, undefined, [], set.repository).map((h) => leanRow(h.item, h.why, LEAN_ROW_TOKENS));
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Memory off: nothing is recalled. */
export const offArm = (): Arm => ({ async ingest() {}, async answer() { return []; }, close() {} });

/** Claude Code reads only the first 200 lines of an auto memory MEMORY.md into a session. */
const AUTO_MEMORY_LINES = 200;

/**
 * Claude Code auto memory, as Claude Code loads it: a MEMORY.md of one line per note, appended as they were learned and
 * never revised, of which the first 200 lines are put into every session whole, whatever the question.
 */
export function autoMemoryArm(): Arm {
  let text = '';
  return {
    async ingest(s) {
      const lines = s.ingest.filter((e) => e.kind !== 'code-change').map((e) => `- ${e.statement}${e.path === undefined ? '' : ` (${e.path})`}`);
      text = ['# Memory', ...lines].slice(0, AUTO_MEMORY_LINES).join('\n');
      if (lines.length === 0) text = '';
    },
    async answer() { return text === '' ? [] : [text]; },
    close() {},
  };
}

/** The whole history in context: every piece of evidence before the cut-off, dated, in every session. */
export function wholeHistoryArm(): Arm {
  let text = '';
  return {
    async ingest(s) { text = s.ingest.map((e) => `${e.at} ${e.kind}: ${e.statement}${e.path === undefined ? '' : ` (${e.path})`}`).join('\n'); },
    async answer() { return text === '' ? [] : [text]; },
    close() {},
  };
}

/** An alternative installed on this machine, run as its own process by the command the owner configures. */
export interface ExternalSpec {
  command: string[];
  /** It sends evidence to a hosted model or service: never run for a client tenant. */
  offMachine?: boolean;
  /** It calls a model, so its answers vary: run three times and report the spread. */
  modelBacked?: boolean;
}

/** Each alternative's own telemetry switch, beside DO_NOT_TRACK, which every arm gets. */
export const EXTERNAL_ARMS: Record<string, Record<string, string>> = {
  mem0: { MEM0_TELEMETRY: 'False' },
  graphiti: { GRAPHITI_TELEMETRY_ENABLED: 'false' },
  'basic-memory': {},
  'community-plugin': {},
};

/** Why an arm could not be measured; it then scores zero and the scorecard says this. */
export class ArmFailed extends Error {}

const ANSWER_MS = 30_000;
const INGEST_MS = 300_000;

/**
 * An alternative behind the line protocol in the README under Head to head: one JSON request per line on its stdin, one JSON reply
 * per line on its stdout. It starts with only PATH, HOME and the telemetry switches in its environment, and must answer
 * the first request, `hello`, with `"telemetry": "off"` before it is sent any evidence.
 */
export function externalArm(name: string, spec: ExternalSpec): Arm {
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  let failed: Error | undefined;
  const replies: string[] = [];
  let waiting: (() => void) | undefined;
  const call = async (request: unknown, ms: number): Promise<Record<string, unknown>> => {
    if (failed !== undefined) throw failed;
    child!.stdin.write(`${JSON.stringify(request)}\n`);
    let timer: NodeJS.Timeout | undefined;
    while (replies.length === 0) {
      if (failed !== undefined) throw failed;
      await new Promise<void>((ok) => {
        waiting = ok;
        timer = setTimeout(() => {
          failed = new ArmFailed(`${name} crashed: no reply within ${ms / 1000} s`);
          ok();
        }, ms);
      });
      clearTimeout(timer);
    }
    try {
      const reply = JSON.parse(replies.shift()!) as Record<string, unknown>;
      if (typeof reply !== 'object' || reply === null) throw new Error('not an object');
      return reply;
    } catch {
      throw (failed = new ArmFailed(`${name} crashed: a reply that is not a JSON object`));
    }
  };
  return {
    async ingest(set) {
      const [program, ...args] = spec.command;
      const c = spawn(program!, args, {
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', DO_NOT_TRACK: '1', ...EXTERNAL_ARMS[name] },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      child = c;
      c.on('error', (error: NodeJS.ErrnoException) => {
        failed = new ArmFailed(error.code === 'ENOENT' ? `${name} is not installed: ${program} was not found` : `${name} crashed: ${error.message}`);
        waiting?.();
      });
      c.on('exit', (code, signal) => {
        failed ??= new ArmFailed(`${name} crashed: it exited (${signal ?? code})`);
        waiting?.();
      });
      c.stdin.on('error', () => {});
      createInterface({ input: c.stdout }).on('line', (line) => {
        replies.push(line);
        waiting?.();
      });
      const hello = await call({ op: 'hello', arm: name }, ANSWER_MS);
      if (hello['telemetry'] !== 'off') throw (failed = new ArmFailed(`${name} did not confirm its telemetry is off, so it was sent no evidence`));
      await call({ op: 'ingest', tenant: set.tenant, repository: set.repository, evidence: set.ingest }, INGEST_MS);
    },
    async answer(q) {
      const reply = await call({ op: 'answer', question: q.question, ...(q.path !== undefined ? { path: q.path } : {}) }, ANSWER_MS);
      const hits = reply['hits'];
      if (!Array.isArray(hits) || !hits.every((h) => typeof h === 'string')) throw (failed = new ArmFailed(`${name} crashed: an answer without a hits list of text`));
      return hits as string[];
    },
    close() {
      child?.removeAllListeners('exit');
      child?.kill();
    },
  };
}
