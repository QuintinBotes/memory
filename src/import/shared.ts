import { refusal } from '../gate.ts';
import { TYPES, type Anchor, type NewItem } from '../items.ts';
import { SHARED_FILE } from '../export/shared.ts';
import { inside } from './silos.ts';

/** A line's item, to be stored as a team-trust proposal; `sharedSupersedes` is the file's id of the item it replaces. */
export type SharedCandidate = NewItem & { status: 'proposed'; sharedSupersedes?: string };

/** The evidence source a line's item is kept under, so a repeat import finds it. */
export const sharedSource = (id: string): string => `${SHARED_FILE}#${id}`;

const ID = /^[\w-]{1,64}$/;
const str = (v: unknown): v is string => typeof v === 'string';
const line = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** The anchor as a stored anchor, or null when the line does not hold one. */
function anchorOf(v: unknown): Anchor | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  if (!str(a['path']) || a['path'] === '' || !inside(a['path'])) return null;
  for (const k of ['commit', 'citedHash', 'symbol']) if (a[k] !== undefined && !str(a[k])) return null;
  for (const k of ['start', 'end']) if (a[k] !== undefined && !line(a[k])) return null;
  return {
    path: a['path'],
    ...(a['start'] === undefined ? {} : { start: a['start'] as number }),
    ...(a['end'] === undefined ? {} : { end: a['end'] as number }),
    ...(a['commit'] === undefined ? {} : { commit: a['commit'] as string }),
    ...(a['citedHash'] === undefined ? {} : { citedHash: a['citedHash'] as string }),
    ...(a['symbol'] === undefined ? {} : { symbol: a['symbol'] as string }),
  };
}

/**
 * The text of `.memory/shared.jsonl` as proposals for `tenant`'s `repository` (#137): team trust and the taint
 * `shared:<owner/repo>`, never active. A line that is not what the file holds, or that the gate refuses, is reported by
 * line number and reason only.
 */
export function sharedCandidates(text: string, tenant: string, repository: string): { candidates: SharedCandidate[]; statements: number; refused: { source: string; reason: string }[] } {
  const candidates: SharedCandidate[] = [];
  const refused: { source: string; reason: string }[] = [];
  let statements = 0;
  for (const [i, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    statements++;
    const source = `${SHARED_FILE}:${i + 1}`;
    let v: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) v = parsed as Record<string, unknown>;
    } catch {
      // reported below
    }
    const anchors = Array.isArray(v?.['anchors']) && v['anchors'].length <= 20 ? (v['anchors'] as unknown[]).map(anchorOf) : null;
    if (
      v === null || !str(v['id']) || !ID.test(v['id']) || !str(v['type']) || !(TYPES as readonly string[]).includes(v['type']) || !str(v['statement']) ||
      anchors === null || anchors.includes(null) || (v['supersedes'] != null && (!str(v['supersedes']) || !ID.test(v['supersedes'])))
    ) {
      refused.push({ source, reason: 'the line is not what this file format holds' });
      continue;
    }
    const kept = anchors as Anchor[];
    const why = [v['statement'], ...kept.flatMap((a) => [a.path, ...(a.symbol === undefined ? [] : [a.symbol])])].map((t) => refusal(t)).find((r) => r !== null);
    if (why !== undefined) {
      refused.push({ source, reason: why });
      continue;
    }
    candidates.push({
      tenant, scope: 'repository', scopeKey: repository, type: v['type'], statement: v['statement'], rationale: null, anchors: kept,
      source: sharedSource(v['id']), trust: 'team', status: 'proposed', taint: `shared:${repository}`,
      ...(str(v['supersedes']) ? { sharedSupersedes: v['supersedes'] } : {}),
    });
  }
  return { candidates, statements, refused };
}
