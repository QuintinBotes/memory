import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, run, runAsync, remember, tools, assemble } from './helpers.mjs';

const KEY = 'scf-test-key';

/** A stand-in for SCF's /world routes: proposals live in `proposals`, run outcomes per fact in `feedback`. */
async function scf({ redirect = false } = {}) {
  const state = { proposals: [], feedback: {}, posts: 0, calls: 0, auths: [] };
  const server = createServer((req, res) => {
    state.calls++;
    state.auths.push(req.headers.authorization);
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (redirect) {
      res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
      return res.end();
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method === 'GET' && url.pathname === '/world/proposals') {
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        return send(200, { items: state.proposals.slice(offset, offset + limit) });
      }
      if (req.method === 'POST' && url.pathname === '/world/proposals') {
        state.posts++;
        const payload = JSON.parse(body);
        const proposal = { id: `p-${state.proposals.length + 1}`, status: 'proposed', fact_id: null, payload };
        state.proposals.push(proposal);
        return send(201, proposal);
      }
      const m = /^\/world\/facts\/([^/]+)\/feedback$/.exec(url.pathname);
      if (req.method === 'GET' && m) return send(200, { items: state.feedback[m[1]] ?? [] });
      send(404, {});
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((ok) => server.close(ok));
  state.accept = (i, fact) => Object.assign(state.proposals[i], { status: 'accepted', fact_id: fact });
  return state;
}

const db = (s, file) => new DatabaseSync(join(s.data, file));
const rows = (s, sql, file = 'tenants/acme.sqlite') => {
  const d = db(s, file);
  try {
    return d.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    d.close();
  }
};
const propose = (s, cwd, config, statement, scope = 'repository') => {
  const [r] = tools(cwd, s.data, config, [['memory_propose', { statement, scope, type: 'convention', evidence: { source: 'agent-1' } }]]);
  assert.equal(r.isError, false, r.text);
};
const env = { SCF_API_KEY: KEY };
const at = (s) => ({ cwd: s.acmeApi, data: s.data, config: s.configA, env, net: false });
const exportScf = (s, ...flags) => runAsync(['export', '--to', 'scf', ...flags], at(s));

/** Tenant acme sends to `acmeScf`, tenant beta to `betaScf`; the plan is confirmed. */
async function configured() {
  const s = setup();
  const acmeScf = await scf();
  const betaScf = await scf();
  const r = run(['init', '--scf', `acme=${acmeScf.url}`, '--scf', `beta=${betaScf.url}`, '--bind', 'acme,beta', '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  return { s, acmeScf, betaScf };
}

test('S1 each proposed item arrives as a world proposal with layer memory and its evidence; person items and other tenants never leave', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    propose(s, s.acmeApi, s.configA, 'Prefer small pull requests', 'person');
    propose(s, s.betaWeb, s.configA, 'Beta deploys need a second approver');
    assert.equal(remember(s.acmeApi, s.data, s.configA, 'Active items are not proposals').status, 0);
    const r = await exportScf(s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sent 1 proposals of tenant acme/);
    assert.equal(acmeScf.proposals.length, 1);
    const p = acmeScf.proposals[0].payload;
    assert.equal(p.layer, 'memory');
    assert.equal(p.value, 'The cache is cleared on deploy');
    assert.equal(p.subject, 'acme/api');
    assert.equal(p.qualifiers.evidence[0].source_ref, 'agent-1');
    assert.equal(p.qualifiers.scope, 'repository');
    assert.equal(betaScf.calls, 0, 'beta items go only to the SCF set for beta');
    assert.deepEqual(new Set(acmeScf.auths), new Set([`Bearer ${KEY}`]));
    const beta = await runAsync(['export', '--to', 'scf'], { cwd: s.betaWeb, data: s.data, config: s.configA, env, net: false });
    assert.equal(beta.status, 0, beta.stderr);
    assert.equal(betaScf.proposals.length, 1);
    assert.equal(betaScf.proposals[0].payload.value, 'Beta deploys need a second approver');
    assert.equal(acmeScf.proposals.length, 1);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('S2 a proposal accepted in SCF makes its item active once the feedback import runs', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    await exportScf(s);
    assert.deepEqual(rows(s, 'SELECT status FROM items'), [{ status: 'proposed' }]);
    acmeScf.accept(0, 'fact-1');
    const r = await runAsync(['import', '--scf'], at(s));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 approved/);
    assert.deepEqual(rows(s, 'SELECT status FROM items'), [{ status: 'active' }]);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('S3 run outcomes on the accepted fact change helped and wrong, each counted once', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    await exportScf(s);
    acmeScf.accept(0, 'fact-1');
    acmeScf.feedback['fact-1'] = [{ run_id: 'r1', outcome: 'reinforced' }, { run_id: 'r2', outcome: 'reinforced' }, { run_id: 'r3', outcome: 'weakened' }];
    assert.match((await runAsync(['import', '--scf'], at(s))).stdout, /2 helped, 1 wrong/);
    assert.deepEqual(rows(s, 'SELECT helped, wrong FROM items'), [{ helped: 2, wrong: 1 }]);
    acmeScf.feedback['fact-1'].push({ run_id: 'r4', outcome: 'weakened' });
    await runAsync(['import', '--scf'], at(s));
    assert.deepEqual(rows(s, 'SELECT helped, wrong FROM items'), [{ helped: 2, wrong: 2 }], 'the first three runs are not counted again');
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('S4 the same export run twice leaves SCF with no duplicates, even when the local record is lost', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    await exportScf(s);
    const again = await exportScf(s);
    assert.match(again.stdout, /sent 0 proposals.*1 already there/);
    const d = db(s, 'tenants/acme.sqlite');
    d.exec('DELETE FROM scf_links');
    d.close();
    assert.equal((await exportScf(s)).status, 0);
    assert.equal(acmeScf.posts, 1);
    assert.equal(acmeScf.proposals.length, 1);
    assert.equal(rows(s, 'SELECT count(*) AS n FROM scf_links')[0].n, 1, 'the existing proposal is linked again');
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('E1 an unreachable SCF leaves memory unchanged and says so', async () => {
  const { s, acmeScf, betaScf } = await configured();
  propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
  const before = rows(s, 'SELECT * FROM items');
  const audits = rows(s, 'SELECT count(*) AS n FROM audit_events')[0].n;
  await acmeScf.close();
  try {
    const r = await exportScf(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unreachable.*nothing was changed/);
    assert.deepEqual(rows(s, 'SELECT * FROM items'), before);
    assert.deepEqual(rows(s, 'SELECT * FROM scf_links'), []);
    assert.equal(rows(s, 'SELECT count(*) AS n FROM audit_events')[0].n, audits);
  } finally {
    await betaScf.close();
  }
});

test('E2 a tenant with no SCF address, no key, or a configuration not yet confirmed sends nothing', async () => {
  const s = setup();
  const stub = await scf();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    assert.match((await exportScf(s)).stderr, /no SCF address/);
    // Set but not confirmed: the plan changed, so memory is inert until the owner agrees.
    const file = join(s.data, 'config.json');
    const edited = JSON.parse(readFileSync(file, 'utf8'));
    edited.scf = { acme: { url: stub.url } };
    writeFileSync(file, JSON.stringify(edited));
    assert.match((await exportScf(s)).stderr, /configuration changed/);
    run(['init', '--scf', `acme=${stub.url}`, '--confirm'], { cwd: s.base, data: s.data, config: s.configA });
    const noKey = await runAsync(['export', '--to', 'scf'], { cwd: s.acmeApi, data: s.data, config: s.configA, net: false });
    assert.match(noKey.stderr, /SCF_API_KEY is not set/);
    assert.equal(stub.calls, 0);
  } finally {
    await stub.close();
  }
});

test('E3 an address must be https, or http to this machine, with no credentials', () => {
  const s = setup();
  for (const bad of ['http://scf.example.com', 'https://user:pw@scf.example.com', 'ftp://scf.example.com', 'nope']) {
    const r = run(['init', '--scf', `acme=${bad}`], { cwd: s.base, data: s.data, config: s.configA });
    assert.equal(r.status, 2, bad);
  }
  assert.equal(run(['init', '--scf', 'ghost=https://scf.example.com'], { cwd: s.base, data: s.data, config: s.configA }).status, 2);
});

test('E4 an item holding text redaction would change is not sent, and the key is never followed to a redirect', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    propose(s, s.acmeApi, s.configA, 'Uses a token');
    const d = db(s, 'tenants/acme.sqlite');
    d.prepare('UPDATE items SET statement = ? WHERE statement = ?').run(`Uses ${assemble('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')}`, 'Uses a token');
    d.close();
    const r = await exportScf(s);
    assert.match(r.stdout, /sent 1 proposals.*1 not sent/);
    assert.deepEqual(acmeScf.proposals.map((p) => p.payload.value), ['The cache is cleared on deploy']);
    assert.ok(!JSON.stringify(acmeScf.proposals).includes('A1b2C3d4'));
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
  const r2 = await configured();
  const redirecting = await scf({ redirect: true });
  try {
    run(['init', '--scf', `acme=${redirecting.url}`, '--confirm'], { cwd: r2.s.base, data: r2.s.data, config: r2.s.configA });
    propose(r2.s, r2.s.acmeApi, r2.s.configA, 'A statement');
    const r = await exportScf(r2.s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unreachable/);
  } finally {
    await redirecting.close();
    await r2.acmeScf.close();
    await r2.betaScf.close();
  }
});

test('E5 --repo sends only that repository, as list and export --markdown reach it', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'Api statement');
    propose(s, s.acmeWeb, s.configA, 'Web statement');
    const r = await exportScf(s, '--repo', 'acme/web');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(acmeScf.proposals.map((p) => p.payload.value), ['Web statement']);
    const foreign = await exportScf(s, '--repo', 'beta/web');
    assert.notEqual(foreign.status, 0);
    assert.equal(acmeScf.proposals.length, 1);
    assert.equal(betaScf.calls, 0);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});
