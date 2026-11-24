import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, remember, sessionStart, tools, fenced, commit, tokens } from './helpers.mjs';

const INVOICE = 'Invoices are rounded half up before tax is added';
const RATES = 'Tax rates are read from the rates table, never hard coded';
const LEDGER = 'The ledger consumes one unit per call';
const QUESTION = 'Should invoices be issued in the guest currency or the hotel currency';

function seeded() {
  const s = setup();
  commit(s.acmeApi, {
    'src/billing/invoice.ts': 'export const invoice = 1;\nexport const total = 2;\n',
    'src/billing/tax/rates.ts': 'export const rates = 1;\n',
    'src/billing/tax/deep/x.ts': 'export const x = 1;\n',
    'src/ledger/x.ts': 'export const x = 1;\n',
  });
  const ok = (r) => assert.equal(r.status, 0, r.stderr);
  ok(remember(s.acmeApi, s.data, s.configA, INVOICE, '--type', 'decision', '--anchor', 'src/billing/invoice.ts'));
  ok(remember(s.acmeApi, s.data, s.configA, RATES, '--type', 'decision', '--anchor', 'src/billing/tax/rates.ts'));
  ok(remember(s.acmeApi, s.data, s.configA, LEDGER, '--type', 'hazard', '--anchor', 'src/ledger/x.ts'));
  return s;
}

const rowsOf = (text) => fenced(text).filter((l) => l.startsWith('- ['));
const db = (s) => new DatabaseSync(join(s.data, 'tenants', 'acme.sqlite'));
const idOf = (s, text) => {
  const d = db(s);
  const id = d.prepare('SELECT id FROM items WHERE statement = ?').get(text).id;
  d.close();
  return id;
};
const statusOf = (s, id) => {
  const d = db(s);
  const row = d.prepare('SELECT status, valid_to FROM items WHERE id = ?').get(id);
  d.close();
  return row;
};
const related = (s, path, ...more) => run(['related', path, ...more], { cwd: s.acmeApi, data: s.data, config: s.configA });
const propose = (s, statement) =>
  tools(s.acmeApi, s.data, s.configA, [['memory_propose', { statement, scope: 'repository', type: 'open_question', evidence: { source: 'session-1' } }]])[0];

test('SC1: related returns only the items anchored under the prefix, by CLI and by MCP tool', () => {
  const s = seeded();
  const cli = related(s, 'src/billing');
  assert.equal(cli.status, 0, cli.stderr);
  const rows = rowsOf(cli.stdout);
  assert.equal(rows.length, 2, cli.stdout);
  assert.ok(rows.some((r) => r.includes(INVOICE)) && rows.some((r) => r.includes(RATES)));
  assert.ok(!cli.stdout.includes(LEDGER));
  const [tool] = tools(s.acmeApi, s.data, s.configA, [['memory_related', { path_or_symbol: 'src/billing' }]]);
  assert.equal(tool.isError, false, tool.text);
  assert.equal(rowsOf(tool.text).length, 2);
  assert.ok(!tool.text.includes(LEDGER));
  // a prefix is a path boundary, not a string prefix
  assert.equal(related(s, 'src/bill').stdout, '');
});

test('SC1b: depth limits the segments matched below the prefix', () => {
  const s = seeded();
  assert.equal(rowsOf(related(s, 'src/billing', '--depth', '1').stdout).length, 1, 'only invoice.ts is one segment below');
  assert.equal(rowsOf(related(s, 'src/billing', '--depth', '2').stdout).length, 2);
  assert.equal(rowsOf(related(s, 'src/billing/invoice.ts', '--depth', '0').stdout).length, 1);
  const [tool] = tools(s.acmeApi, s.data, s.configA, [['memory_related', { path_or_symbol: 'src/billing', depth: 1 }]]);
  assert.equal(rowsOf(tool.text).length, 1);
});

test('SC2: a stale item under the prefix is not returned', () => {
  const s = seeded();
  commit(s.acmeApi, { 'src/billing/invoice.ts': null });
  const out = related(s, 'src/billing');
  const rows = rowsOf(out.stdout);
  assert.equal(rows.length, 1, out.stdout);
  assert.ok(rows[0].includes(RATES));
  assert.equal(statusOf(s, idOf(s, INVOICE)).status, 'stale');
});

test('SC3: a superseded item under the prefix is not returned', () => {
  const s = seeded();
  const old = idOf(s, INVOICE);
  const r = remember(s.acmeApi, s.data, s.configA, 'Invoices are rounded half even before tax is added', '--type', 'decision', '--supersedes', old, '--anchor', 'src/billing/invoice.ts');
  assert.equal(r.status, 0, r.stderr);
  const out = rowsOf(related(s, 'src/billing').stdout);
  assert.equal(out.length, 2);
  assert.ok(!out.some((x) => x.includes(INVOICE)));
  assert.ok(out.some((x) => x.includes('half even')));
});

test('SC4: an open_question an agent proposes is inactive: neither related nor search returns it', () => {
  const s = seeded();
  const p = propose(s, QUESTION);
  assert.equal(p.isError, false, p.text);
  assert.match(p.text, /^proposed m-[0-9a-f]+/);
  const [search, rel] = tools(s.acmeApi, s.data, s.configA, [
    ['memory_search', { query: 'invoices guest currency hotel currency' }],
    ['memory_related', { path_or_symbol: 'src/billing' }],
  ]);
  assert.ok(!search.text.includes(QUESTION), search.text);
  assert.ok(!rel.text.includes(QUESTION), rel.text);
  assert.ok(!related(s, 'src/billing').stdout.includes(QUESTION));
  assert.equal(statusOf(s, idOf(s, QUESTION)).status, 'proposed');
  assert.ok(!sessionStart(s.acmeApi, s.data, s.configA).stdout.includes(QUESTION));
});

test('SC5: once the owner approves it, the open question is in the next session slice', () => {
  const s = seeded();
  propose(s, QUESTION);
  const id = idOf(s, QUESTION);
  const a = run(['approve', id], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(a.status, 0, a.stderr);
  assert.match(sessionStart(s.acmeApi, s.data, s.configA).stdout, new RegExp(`\\[${id}\\] open_question: ${QUESTION}`));
});

test('SC6: memory close removes an approved open question from recall and records it closed', () => {
  const s = seeded();
  propose(s, QUESTION);
  const id = idOf(s, QUESTION);
  const early = run(['close', id], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(early.status, 1, 'a proposal is not closed, it is approved or rejected');
  assert.equal(statusOf(s, id).status, 'proposed');
  run(['approve', id], { cwd: s.acmeApi, data: s.data, config: s.configA });
  const c = run(['close', id], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(c.status, 0, c.stderr);
  assert.equal(statusOf(s, id).status, 'closed');
  assert.ok(!sessionStart(s.acmeApi, s.data, s.configA).stdout.includes(QUESTION));
  const [search] = tools(s.acmeApi, s.data, s.configA, [['memory_search', { query: 'invoices guest currency hotel currency' }]]);
  assert.ok(!search.text.includes(QUESTION));
  // only an open question closes, and no MCP tool does it
  const other = run(['close', idOf(s, LEDGER)], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(other.status, 1);
  assert.equal(statusOf(s, idOf(s, LEDGER)).status, 'active');
  const [bad] = tools(s.acmeApi, s.data, s.configA, [['memory_close', { id }]]);
  assert.equal(bad.isError, true);
});

test('SC7: past the budget whole rows are dropped and no row is cut', () => {
  const s = setup();
  const lines = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  commit(s.acmeApi, { 'src/many/a.ts': lines });
  const statement = (n) => `Decision number ${n} applies to every module under the many directory without exception`;
  for (let n = 0; n < 30; n++) {
    const r = remember(s.acmeApi, s.data, s.configA, statement(n), '--type', 'decision', '--anchor', 'src/many/a.ts');
    assert.equal(r.status, 0, r.stderr);
  }
  const path = join(s.data, 'config.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), sessionBudget: 200 }));
  const out = related(s, 'src/many').stdout;
  assert.ok(tokens(out) <= 200, `${tokens(out)} tokens`);
  const rows = rowsOf(out);
  assert.ok(rows.length > 0 && rows.length < 30, `${rows.length} shown`);
  for (const row of rows) assert.match(row, /Decision number \d+ applies to every module under the many directory without exception \(src\/many\/a\.ts\)$/);
  assert.match(out, new RegExp(`\\+${30 - rows.length} more`));
  const [tool] = tools(s.acmeApi, s.data, s.configA, [['memory_related', { path_or_symbol: 'src/many' }]]);
  assert.equal(rowsOf(tool.text).length, rows.length);
});
