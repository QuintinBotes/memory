// Adapted from Review Voice, plugins/review-voice/src/store/audit.ts at 707ba60
// (https://github.com/QuintinBotes/review-voice, MIT).
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Every consequential action is recorded in the file it changed, so a user can
 * answer "what did this do with my data" from their own machine. Metadata
 * never holds an item's text.
 */
export type AuditAction =
  | 'consent_granted'
  | 'item_remembered'
  | 'item_captured'
  | 'item_stale'
  | 'item_restored'
  | 'anchor_moved'
  | 'purge'
  | 'import'
  | 'proposal_approved'
  | 'proposal_rejected'
  | 'question_closed'
  | 'proposal_received'
  | 'feedback'
  | 'toolset_outcome'
  | 'tombstones_reduced'
  | 'evidence_merged'
  | 'merge_proposed'
  | 'sweep'
  | 'supersession_applied'
  | 'instruction_edit_proposed'
  | 'instruction_edit_applied'
  | 'instruction_edit_rejected'
  | 'promotion_proposed'
  | 'promotion_applied'
  | 'promotion_rejected'
  | 'scf_exported'
  | 'scf_feedback'
  | 'transcripts_processed'
  | 'transcripts_modelled'
  | 'transcripts_expired'
  | 'undone';

export function recordAudit(
  db: DatabaseSync,
  action: AuditAction,
  subject: { type: string; id: string } | null,
  metadata: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_events (audit_id, action, subject_type, subject_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, action, subject?.type ?? null, subject?.id ?? null, JSON.stringify(metadata), new Date().toISOString());
  return id;
}
