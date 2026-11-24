// Copied from Orbit, src/evidence/fingerprint.ts at 6407296 on branch next (https://github.com/QuintinBotes/orbit, MIT).
// Line selection, normalisation, the silent-failure fallback and the hash are Orbit's, minus the excerpt and the
// redaction it feeds, and the run's `roots` option. One difference: Orbit hashes its check's id into the fingerprint,
// and a Bash command has none, so the id is fixed to `bash`: a fingerprint here equals Orbit's for a check with that
// id, and cannot equal one Orbit stored for another check. test/failure.test.mjs pins the copy against Orbit's output.
import { createHash } from 'node:crypto';

export interface FailureFingerprint {
  /** `fp:` plus 16 hex characters. */
  fingerprint: string;
  /** The normalized lines the fingerprint was computed from, sorted and deduplicated. */
  signature: string[];
}

// A line this long is a minified bundle or a data dump, not a message.
const MAX_LINE = 400;
// Cap on lines scanned, so a runaway log cannot make this quadratic or slow.
const MAX_SCANNED_LINES = 200_000;
// Cap on the lines of an error that `errorLines` returns, taken from the end where the error is.
const MAX_MATCH_LINES = 2000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

const RELEVANT =
  /\b(error|errors|fail|failed|failure|failing|exception|assert|assertion|assertionerror|panic|fatal|expected|received|not ok|typeerror|referenceerror|syntaxerror|rangeerror|cannot find|enoent|eacces|traceback|unhandled|timeout|timed out|refused|denied|undefined is not|is not a function|is not defined)\b|[✗✖×]|^\s*FAIL\b|^\s*●|^\s*not ok\b/i;
// "Tests: 1 failed, 3 passed", "Test Files 1 failed | 3 passed": counts shift when tests are added, so they say nothing about the cause.
const SUMMARY = /\b\d+\s+(?:passed|failed|skipped|total|todo|pending|passing|failing)\b|\b(?:tests?|test files|suites?|duration|time|snapshots?)\s*:/i;
const STACK_FRAME = /^\s+at\s|^\s+\S+:\d+(?::\d+)?\s*$|^\s*File ".+", line \d+/;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** Replace everything that varies between two runs of the same failure with a fixed placeholder. */
export function normalizeLine(line: string): string {
  const s = stripAnsi(line)
    .replace(/\r/g, '')
    // Temp directories and per-run scratch names.
    .replace(/(?:\/private)?\/var\/folders\/[^\s'"():]+/g, '<tmp>')
    .replace(/(?:\/private)?\/tmp\/[^\s'"():]+/g, '<tmp>')
    .replace(/\b(?:orbit|tmp|temp)[-_.][A-Za-z0-9]{6,}\b/g, '<tmp>')
    // Timestamps in the usual shapes.
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?\b/g, '<time>')
    .replace(/\b1[5-9]\d{11}\b/g, '<time>')
    // Durations: "(12ms)", "in 1.2s", "took 340 ms", "0.45 seconds".
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|µs|us|ns|seconds?|secs?|s|minutes?|mins?)\b/gi, '<dur>')
    // Identifiers: uuids, pointers, long hex (shas, hashes, random suffixes).
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b\d{7,}\b/g, '<n>')
    .replace(/\b(pid|process|port)\s*[:=]?\s*\d+\b/gi, '$1 <n>')
    .replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/g, '$1:<port>')
    // Other absolute paths keep their last two segments, which is where the file identity lives.
    .replace(/(?<![\w:/.~<>-])\/(?:[^\s:'"()<>[\]]+\/)+[^\s:'"()<>[\]]+/g, (m) => `<path>/${m.split('/').filter(Boolean).slice(-2).join('/')}`)
    // Line and column numbers move whenever the file is edited.
    .replace(/(\.[A-Za-z0-9]{1,6}):\d+(?::\d+)?/g, '$1:<n>')
    .replace(/\b(line|col|column|ln)\s+\d+\b/gi, '$1 <n>')
    .replace(/\((\d+):(\d+)\)/g, '(<n>:<n>)')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE) : s;
}

/** The fingerprint of one Bash command's error output; `exitCode` is the process's, null when it is not known. */
export function fingerprintFailure(output: string, exitCode: number | null = null): FailureFingerprint {
  const lines = stripAnsi(output).split('\n', MAX_SCANNED_LINES);
  const picked: string[] = [];
  let expectFrame = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) {
      expectFrame = false;
      continue;
    }
    if (RELEVANT.test(line) && !SUMMARY.test(line)) {
      picked.push(normalizeLine(line));
      expectFrame = true;
    } else if (expectFrame && STACK_FRAME.test(line)) {
      // Only the top frame after an error line: deeper frames differ by runner version and call depth.
      picked.push(normalizeLine(line));
      expectFrame = false;
    } else {
      expectFrame = false;
    }
  }
  // Sorted and deduplicated: parallel runners interleave and repeat lines in a different order every run.
  let signature = [...new Set(picked.filter(Boolean))].sort();
  if (signature.length === 0) {
    // Silent failures still need a stable identity: the tail of the output, then how the process ended.
    const tail = lines.map(normalizeLine).filter(Boolean).slice(-3);
    signature = [...tail, `exit:${exitCode ?? 'signal'}`].sort();
  }
  return { fingerprint: `fp:${createHash('sha256').update(JSON.stringify(['bash', signature])).digest('hex').slice(0, 16)}`, signature };
}

/** Every normalised line of the last 2,000 lines of the output, relevant or not, deduplicated: what a recipe's signature is looked for in. */
export function errorLines(output: string): string[] {
  const lines = stripAnsi(output).split('\n').slice(-MAX_MATCH_LINES);
  return [...new Set(lines.map(normalizeLine).filter(Boolean))];
}
