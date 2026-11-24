import type { DatabaseSync } from 'node:sqlite';
import { READS_EXPIRED, confidence } from '../recall/rank.ts';
import { fence, PROPOSALS_LABEL, safe } from '../render/rows.ts';

/** One active item of a tenant with the feedback agents gave it. */
export interface Ranked {
  id: string;
  type: string;
  scope: string;
  statement: string;
  quarantine: string | null;
  helped: number;
  wrong: number;
  stale: number;
  confidence: number;
}

const net = (r: Ranked): number => r.helped - r.wrong - r.stale;
const byId = (a: Ranked, b: Ranked): number => (a.id < b.id ? -1 : 1);

/** Active items of `tenant` (every scope its file holds), read from this one store. */
export function tenantReport(db: DatabaseSync, tenant: string, now = Date.now()): { ranked: Ranked[]; none: Ranked[] } {
  const rows = db
    .prepare(
      `SELECT id, type, scope, statement, quarantine, helped, wrong, stale_reports AS stale, coalesce(reinforced_at, valid_from) AS reinforced
       FROM items WHERE tenant = ? AND status = 'active' AND valid_to IS NULL AND NOT ${READS_EXPIRED}`,
    )
    .all(tenant) as unknown as (Omit<Ranked, 'confidence'> & { reinforced: string })[];
  const all = rows.map(({ reinforced, ...r }) => ({ ...r, confidence: confidence({ reinforced, helped: r.helped, wrong: r.wrong }, now) }));
  const has = (r: Ranked): boolean => r.helped + r.wrong + r.stale > 0;
  return {
    // Ids are unique, so the order is total.
    ranked: all.filter(has).sort((a, b) => net(b) - net(a) || b.confidence - a.confidence || byId(a, b)),
    none: all.filter((r) => !has(r)).sort(byId),
  };
}

const row = (r: Ranked): string =>
  safe(
    `- [${r.id}] ${r.type}, ${r.scope}, net ${net(r)} (helped ${r.helped}, wrong ${r.wrong}, stale ${r.stale}), confidence ${r.confidence.toFixed(2)}` +
      // A quarantined item reads as an instruction: its text is never shown.
      (r.quarantine === null ? `: ${JSON.stringify(safe(r.statement))}` : `, quarantined (${r.quarantine}), statement withheld`),
  ) + '\n';

export function renderReport(tenant: string, { ranked, none }: ReturnType<typeof tenantReport>): string {
  const section = (title: string, list: Ranked[]): string => `${title}\n${list.length === 0 ? '(none)\n' : list.map(row).join('')}`;
  return `Tenant ${tenant}\n` + fence(PROPOSALS_LABEL, `${section('Ranked by net feedback, then confidence', ranked)}${section('No feedback', none)}`);
}
