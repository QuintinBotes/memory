import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { refusal } from '../gate.ts';
import { writeAtomic } from '../instructions.ts';
import type { Anchor } from '../items.ts';
import { committers, lineRefusal, writable } from '../promote/promote.ts';
import { read } from './markdown.ts';

/**
 * `memory share` (#137): this repository's active, unquarantined repository items as one line each in a file of the
 * repository, for `memory import --shared` on another machine. Deterministic: sorted by id, no clock. Never commits.
 */
export const SHARED_FILE = '.memory/shared.jsonl';

export interface ShareReport {
  file: string;
  dryRun: boolean;
  written: number;
  /** By reason only: a reason never repeats the withheld text. */
  withheld: Record<string, number>;
  changed: boolean;
}

/** The anchor fields that mean the same on another machine; a code anchor provider's own state stays here. */
const portable = (a: Anchor): Anchor => ({
  path: a.path,
  ...(a.start === undefined ? {} : { start: a.start }),
  ...(a.end === undefined ? {} : { end: a.end }),
  ...(a.commit === undefined ? {} : { commit: a.commit }),
  ...(a.citedHash === undefined ? {} : { citedHash: a.citedHash }),
  ...(a.symbol === undefined ? {} : { symbol: a.symbol }),
});

/** The file's lines for `tenant`'s `repository`, and what was withheld. `top` is the checkout, for its committers' names. */
export function sharedLines(db: DatabaseSync, tenant: string, repository: string, top: string): { text: string; written: number; withheld: Record<string, number> } {
  const names = committers(top);
  const withheld: Record<string, number> = {};
  const lines: string[] = [];
  for (const { row, evidence } of read(db, tenant, repository)) {
    if (row.scope !== 'repository' || row.status !== 'active') continue;
    const anchors = (JSON.parse(row.anchors_json) as Anchor[]).map(portable);
    const sources = [...new Set(evidence.map((e) => e.source_ref))].sort();
    const why =
      row.quarantine !== null
        ? 'quarantined'
        : [row.statement, ...sources].map((t) => lineRefusal(t, top, names)).find((r) => r !== null) ??
          anchors.flatMap((a) => [a.path, ...(a.symbol === undefined ? [] : [a.symbol])]).map((t) => refusal(t)).find((r) => r !== null) ??
          null;
    if (why !== null) {
      withheld[why] = (withheld[why] ?? 0) + 1;
      continue;
    }
    lines.push(JSON.stringify({ id: row.id, type: row.type, statement: row.statement, anchors, validFrom: row.valid_from, validTo: row.valid_to, supersedes: row.supersedes, sources }));
  }
  return { text: lines.map((l) => `${l}\n`).join(''), written: lines.length, withheld };
}

/** Writes the file under `top` unless `dryRun`; an unchanged file is not touched. */
export function share(db: DatabaseSync | null, tenant: string, repository: string, top: string, dryRun: boolean): ShareReport {
  const { text, written, withheld } = db === null ? { text: '', written: 0, withheld: {} } : sharedLines(db, tenant, repository, top);
  const target = writable(top, SHARED_FILE);
  let before: string | null = null;
  try {
    before = readFileSync(target, 'utf8');
  } catch {
    // not there yet
  }
  const changed = before !== text;
  if (!dryRun && changed) {
    mkdirSync(dirname(target), { recursive: true });
    writeAtomic(target, text);
  }
  return { file: SHARED_FILE, dryRun, written, withheld, changed };
}
