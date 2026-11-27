import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DEFAULT_CAPTURE } from '../config.ts';

/** The reason a run over a daily cap is skipped with, in `logs/capture.jsonl`. */
export const DAILY_CAP = 'daily cap';

interface LogLine {
  at?: string;
  session?: string;
  skipped?: string;
  inputTokens?: number;
  outputTokens?: number;
  via?: string;
}

/** The local calendar day of a time, as YYYY-MM-DD. */
export function localDay(at: string | number | Date): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** shortcut: reads the whole log each run; fine at a few hundred lines a day, rotate the log if it grows past megabytes. */
function readCaptureLog(data: string): LogLine[] {
  let text: string;
  try {
    text = readFileSync(join(data, 'logs', 'capture.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      const o: unknown = JSON.parse(line);
      return typeof o === 'object' && o !== null && typeof (o as LogLine).at === 'string' ? [o as LogLine] : [];
    } catch {
      return [];
    }
  });
}

/** A line for a run that called the model; skips carry no tokens. */
const isRun = (l: LogLine): boolean => l.skipped === undefined && typeof l.inputTokens === 'number';

/**
 * Why a run today would go over a cap, or null. `session` names whether this session was already told today, so a
 * session hears it once.
 */
export function dailyCap(data: string, settings: typeof DEFAULT_CAPTURE, session: string): { reason: string; told: boolean } | null {
  const today = localDay(Date.now());
  const lines = readCaptureLog(data).filter((l) => localDay(l.at!) === today);
  const runs = lines.filter(isRun);
  const tokens = runs.reduce((n, l) => n + (l.inputTokens ?? 0) + (l.outputTokens ?? 0), 0);
  const reason =
    runs.length >= settings.maxCallsPerDay
      ? `${runs.length} of ${settings.maxCallsPerDay} calls today`
      : tokens >= settings.maxTokensPerDay
        ? `${tokens} of ${settings.maxTokensPerDay} tokens today`
        : null;
  return reason === null ? null : { reason, told: lines.some((l) => l.skipped === DAILY_CAP && l.session === session) };
}

/** `memory capture --cost`: per local day from `since` on, runs by how they were paid for, skips by reason, and tokens. */
export function costReport(data: string, since?: string): string[] {
  const days = new Map<string, LogLine[]>();
  for (const l of readCaptureLog(data)) {
    const day = localDay(l.at!);
    if (since !== undefined && day < since) continue;
    days.set(day, [...(days.get(day) ?? []), l]);
  }
  const counts = (keys: string[]): string =>
    [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  return [...days.keys()].sort().map((day) => {
    const lines = days.get(day)!;
    const runs = lines.filter(isRun);
    const skips = lines.filter((l) => l.skipped !== undefined).map((l) => l.skipped!);
    const sum = (k: 'inputTokens' | 'outputTokens'): number => runs.reduce((n, l) => n + (l[k] ?? 0), 0);
    return [
      day,
      `runs ${runs.length}${runs.length > 0 ? ` (${counts(runs.map((l) => l.via ?? 'unrecorded'))})` : ''}`,
      `skipped ${skips.length}${skips.length > 0 ? ` (${counts(skips)})` : ''}`,
      `input ${sum('inputTokens')}`,
      `output ${sum('outputTokens')}`,
    ].join('  ');
  });
}
