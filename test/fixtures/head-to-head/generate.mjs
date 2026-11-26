#!/usr/bin/env node
/**
 * Writes acme.json, the head-to-head replay's public synthetic fixture (#25): the made-up tenant `acme`, its evidence
 * from January to May 2026 and the corrections, decisions and failures after a 2026-06-01 cut-off that become its
 * questions, 45 of each of the seven categories, plus five whose answer lies after the cut-off and must be dropped.
 * Every name and value is invented. Deterministic: the same script writes the same bytes.
 *
 *   node test/fixtures/head-to-head/generate.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES = ['payments', 'invoices', 'ledger', 'webhooks', 'auth', 'search', 'exports', 'notifications', 'billing', 'reports', 'uploads', 'sessions', 'audit', 'pricing', 'refunds'];
// Words for a module that share none with its evidence: a question phrased this way is a vocabulary miss for word search.
const OTHER_WORDS = {
  payments: 'card charges', invoices: 'customer bills', ledger: 'bookkeeping', webhooks: 'callbacks', auth: 'sign-in',
  search: 'lookup', exports: 'downloads', notifications: 'alerts', billing: 'subscriptions', reports: 'dashboards',
  uploads: 'attachments', sessions: 'logins', audit: 'trail', pricing: 'price lists', refunds: 'chargebacks',
};
const ABSENT = ['warehouse', 'loyalty', 'chat', 'maps', 'kiosk', 'ocr', 'printing', 'fax', 'voice', 'iot', 'ads', 'surveys', 'trivia', 'calendar', 'weather'];

const evidence = [];
const events = [];
const day = (month, d) => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const n = (i, k) => 3 + ((i * 7 + k * 5) % 17);
let ev = 0;
let q = 0;
const add = (e) => (evidence.push({ id: `e${String(++ev).padStart(3, '0')}`, ...e }), `e${String(ev).padStart(3, '0')}`);
const ask = (e) => events.push({ id: `q${String(++q).padStart(3, '0')}`, at: day(6 + (q % 3), 1 + (q % 27)), ...e });

MODULES.forEach((m, i) => {
  const d = 1 + (i % 27);
  // Single fact, three facets; the timeout of every other module is asked in other words.
  let id = add({ at: day(1, d), kind: 'decision', statement: `The ${m} worker batch size is ${n(i, 1) * 10}`, key: `${m} worker batch size is ${n(i, 1) * 10}` });
  ask({ kind: 'correction', question: `What batch size does the ${m} worker use?`, answers: [id] });
  id = add({ at: day(1, d), kind: 'lesson', statement: `${m} requests time out after ${n(i, 2)} seconds`, key: `${m} requests time out after ${n(i, 2)} seconds` });
  ask({ kind: 'failure', question: i % 2 === 0 ? `How patient are we with slow ${OTHER_WORDS[m]}?` : `How long before ${m} requests time out?`, answers: [id] });
  id = add({ at: day(2, d), kind: 'decision', statement: `The ${m} service publishes to the ${m}-events-v${n(i, 3)} queue`, key: `${m}-events-v${n(i, 3)}` });
  ask({ kind: 'decision', question: `Which queue does the ${m} service publish to?`, answers: [id] });

  // Multi-source: two pieces of evidence answer one question.
  for (const [what, a, b] of [
    ['deploying', `Run the ${m} migration before deploying ${m}`, `Flush the ${m} cache after deploying ${m}`],
    ['releasing', `Write the ${m} changelog entry before releasing ${m}`, `Turn the ${m} feature flag on only after releasing ${m}`],
    ['on call', `The ${m} on call runbook lives in docs/runbooks/${m}.md`, `Page the ${m} on call rota through the ${m}-oncall alias`],
  ]) {
    const x = add({ at: day(2, d), kind: 'decision', statement: a, key: a });
    const y = add({ at: day(3, d), kind: 'correction', statement: b, key: b });
    ask({ kind: 'decision', question: `What must we do about ${m} when ${what}?`, answers: [x, y] });
  }

  // Knowledge update: only the newer decision is right.
  for (const [thing, from, to] of [['amounts', 'floats', 'integer cents'], ['identifiers', 'uuid v4', 'ulid'], ['log level', 'debug', 'info']]) {
    const old = add({ at: day(1, d), kind: 'decision', statement: `Store ${m} ${thing} as ${from}`, key: `store ${m} ${thing} as ${from}` });
    const now = add({ at: day(4, d), kind: 'decision', statement: `Store ${m} ${thing} as ${to}`, key: `store ${m} ${thing} as ${to}`, supersedes: old });
    ask({ kind: 'correction', question: `How do we store ${m} ${thing}?`, answers: [now] });
  }

  // Temporal: what applied at a commit between the old decision and the one that replaced it.
  for (const [thing, from, to] of [['API version', '2024-01', '2025-06'], ['Node version', '20', '22'], ['retry backoff', 'linear', 'exponential']]) {
    const old = add({ at: day(1, d), kind: 'decision', statement: `The ${m} client pins ${thing} ${from}`, key: `${m} client pins ${thing} ${from}` });
    add({ at: day(5, d), kind: 'decision', statement: `The ${m} client pins ${thing} ${to}`, key: `${m} client pins ${thing} ${to}`, supersedes: old });
    ask({ kind: 'failure', question: `Which ${thing} did the ${m} client pin at commit c${i}${thing.length}?`, asOf: day(3, d), answers: [old] });
  }

  // Abstention: nothing applies. One facet shares words with real evidence; two share none.
  const a = ABSENT[i];
  ask({ kind: 'correction', question: `What batch size does the ${a} worker use?`, answers: [] });
  ask({ kind: 'decision', question: `Who approves ${a} forklift rentals?`, answers: [] });
  ask({ kind: 'failure', question: `Is the ${a} gizmo firmware signed?`, answers: [] });

  // Code-anchored hazard: a failure while editing the anchored file.
  for (const [file, lock] of [['charge', 'row lock'], ['sync', 'advisory lock'], ['flush', 'write fence']]) {
    const path = `src/${m}/${file}.ts`;
    const h = add({ at: day(2, d), kind: 'hazard', statement: `Never call ${m}.${file}() without holding the ${m} ${lock}`, key: `holding the ${m} ${lock}`, path });
    ask({ kind: 'failure', question: `Editing ${path}: anything to watch for?`, path, answers: [h] });
  }

  // Stale citation: the cited code was rewritten before the cut-off, so the item must not be recalled.
  for (const [k, thing] of [[1, 'rounding rule'], [2, 'currency table'], [3, 'tax lookup']]) {
    const path = `src/${m}/legacy-${k}.ts`;
    const s = add({ at: day(1, d), kind: 'hazard', statement: `The ${m} ${thing} lives in legacy module ${k}`, key: `${m} ${thing} lives in legacy module ${k}`, path });
    add({ at: day(4, d), kind: 'code-change', statement: `Rewrote ${path}`, path });
    ask({ kind: 'correction', question: `Where does the ${m} ${thing} live?`, answers: [s] });
  }
});

// Five corrections whose answer was only recorded after the cut-off: dropped from the replay set, never ingested.
MODULES.slice(0, 5).forEach((m, i) => {
  const late = add({ at: day(6, 10 + i), kind: 'decision', statement: `The ${m} archive keeps ${n(i, 9)} months`, key: `${m} archive keeps ${n(i, 9)} months` });
  ask({ kind: 'correction', question: `How long does the ${m} archive keep records?`, answers: [late] });
});

const out = join(dirname(fileURLToPath(import.meta.url)), 'acme.json');
writeFileSync(out, `${JSON.stringify({ tenant: 'acme', repository: 'acme/api', client: true, evidence, events }, null, 1)}\n`);
console.log(`${out}: ${evidence.length} evidence, ${events.length} events`);
