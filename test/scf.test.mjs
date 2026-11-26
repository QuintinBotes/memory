import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { setup, run, runAsync, remember, tools, assemble, until } from './helpers.mjs';

const KEY = 'scf-test-key';

/** A stand-in for SCF's /world routes: proposals live in `proposals`, run outcomes per fact in `feedback`. */
async function scf({ redirectTo = null } = {}) {
  const state = { proposals: [], feedback: {}, posts: 0, arrived: 0, calls: 0, auths: [], gate: null, failPostAt: 0, feedbackFail: false, endless: false };
  const server = createServer((req, res) => {
    state.calls++;
    state.auths.push(req.headers.authorization);
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (redirectTo !== null) {
      res.writeHead(302, { location: `${redirectTo}${url.pathname}` });
      return res.end();
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      if (req.method === 'GET' && url.pathname === '/world/proposals') {
        if (state.endless) return send(200, { items: Array.from({ length: 200 }, (_, i) => ({ id: `x-${i}`, status: 'proposed', fact_id: null, payload: {} })) });
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        return send(200, { items: state.proposals.slice(offset, offset + limit) });
      }
      if (req.method === 'POST' && url.pathname === '/world/proposals') {
        state.arrived++;
        if (state.gate !== null) await state.gate;
        if (state.failPostAt > 0 && state.arrived === state.failPostAt) return send(500, {});
        state.posts++;
        const payload = JSON.parse(body);
        const proposal = { id: `p-${state.proposals.length + 1}`, status: 'proposed', fact_id: null, payload };
        state.proposals.push(proposal);
        return send(201, proposal);
      }
      const m = /^\/world\/facts\/([^/]+)\/feedback$/.exec(url.pathname);
      if (req.method === 'GET' && m) return state.feedbackFail ? send(500, {}) : send(200, { items: (state.feedback[m[1]] ?? []).slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + Number(url.searchParams.get('limit'))) });
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

test('E4 an item holding text redaction would change is not sent', async () => {
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

const sha = (s) => {
  const dir = join(s.data, 'tenants');
  const h = createHash('sha256');
  for (const name of readdirSync(dir).filter((n) => !n.endsWith('-shm')).sort()) h.update(name).update(readFileSync(join(dir, name)));
  return h.digest('hex');
};
const withDb = (s, fn, file = 'tenants/acme.sqlite') => {
  const d = db(s, file);
  try {
    return fn(d);
  } finally {
    d.close();
  }
};
const importScf = (s) => runAsync(['import', '--scf'], at(s));

test('F1 a path that reads as another host never gets a request or the key', async () => {
  const s = setup();
  const evil = await scf();
  const good = await scf();
  try {
    const forms = [`${good.url}//${evil.url.slice(7)}`, `${good.url}/..//${evil.url.slice(7)}`, `http://127.0.0.1${evil.url.slice(evil.url.lastIndexOf(':'))}@${good.url.slice(7)}`];
    for (const bad of forms) {
      const r = run(['init', '--scf', `acme=${bad}`], { cwd: s.base, data: s.data, config: s.configA });
      assert.equal(r.status, 2, bad);
    }
    // The same address written straight into config.json is refused when the file is read.
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    const file = join(s.data, 'config.json');
    const edited = JSON.parse(readFileSync(file, 'utf8'));
    edited.scf = { acme: { url: forms[0] } };
    writeFileSync(file, JSON.stringify(edited));
    const r = await exportScf(s);
    assert.notEqual(r.status, 0);
    assert.equal(evil.calls, 0);
    assert.equal(good.calls, 0);
  } finally {
    await evil.close();
    await good.close();
  }
});

test('F3 an anchor path or an evidence source holding text redaction would change withholds the whole item', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    const token = assemble('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    propose(s, s.acmeApi, s.configA, 'Clean item');
    propose(s, s.acmeApi, s.configA, 'Anchor item');
    propose(s, s.acmeApi, s.configA, 'Source item');
    withDb(s, (d) => {
      d.prepare('UPDATE items SET anchors_json = ? WHERE statement = ?').run(JSON.stringify([{ path: `src/${token}.ts`, commit: 'abc', citedHash: 'h' }]), 'Anchor item');
      d.prepare('UPDATE evidence SET source_ref = ? WHERE item_id = (SELECT id FROM items WHERE statement = ?)').run(`agent-${token}`, 'Source item');
    });
    const r = await exportScf(s);
    assert.match(r.stdout, /sent 1 proposals.*2 not sent/);
    assert.deepEqual(acmeScf.proposals.map((p) => p.payload.value), ['Clean item']);
    assert.ok(!JSON.stringify(acmeScf.proposals).includes('A1b2C3d4'));
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('F4 the plan the owner confirms names each tenant\'s SCF destination', async () => {
  const s = setup();
  const r = run(['init', '--scf', 'acme=https://scf.example.com/api'], { cwd: s.base, data: s.data, config: s.configA });
  assert.deepEqual(JSON.parse(r.stdout).scfDestinations, { acme: 'https://scf.example.com/api' });
});

test('F5 an unreachable SCF leaves the store file byte for byte as it was, even one that would migrate', async () => {
  const { s, acmeScf, betaScf } = await configured();
  propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
  withDb(s, (d) => d.exec('DROP TABLE scf_links; DROP TABLE scf_feedback; PRAGMA user_version = 15;'));
  const before = sha(s);
  await acmeScf.close();
  try {
    const r = await exportScf(s);
    assert.equal(r.status, 1);
    assert.equal(sha(s), before);
  } finally {
    await betaScf.close();
  }
});

test('F6 a failure part-way records no link, and the next run adopts what was already posted', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'First item');
    propose(s, s.acmeApi, s.configA, 'Second item');
    acmeScf.failPostAt = 2;
    const r = await exportScf(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /1 proposals were already sent.*nothing was changed/);
    assert.deepEqual(rows(s, 'SELECT * FROM scf_links'), []);
    assert.equal(acmeScf.proposals.length, 1);
    const again = await exportScf(s);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(acmeScf.proposals.length, 2, 'the first is adopted, only the second is posted');
    assert.equal(rows(s, 'SELECT count(*) AS n FROM scf_links')[0].n, 2);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('F7 feedback that cannot be fetched leaves the accepted item as it was', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    await exportScf(s);
    acmeScf.accept(0, 'fact-1');
    acmeScf.feedbackFail = true;
    const r = await importScf(s);
    assert.equal(r.status, 1);
    assert.deepEqual(rows(s, 'SELECT status, helped, wrong FROM items'), [{ status: 'proposed', helped: 0, wrong: 0 }]);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('F8 an accepted item whose evidence was purged here stays proposed, and review lists it with the reason', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    await exportScf(s);
    withDb(s, (d) => d.exec('DELETE FROM evidence'));
    acmeScf.accept(0, 'fact-1');
    const r = await importScf(s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 held/);
    assert.deepEqual(rows(s, 'SELECT status FROM items'), [{ status: 'proposed' }]);
    const review = run(['review'], { cwd: s.acmeApi, data: s.data, config: s.configA });
    assert.match(review.stdout, /accepted in SCF, evidence purged here/);
    assert.match(review.stdout, /The cache is cleared on deploy/);
    assert.match((await importScf(s)).stdout, /0 held/);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('F9 two overlapping exports post an item once', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    const blocked = join(s.base, 'blocked.log');
    writeFileSync(blocked, '');
    const queued = () => readFileSync(blocked, 'utf8').length > 0;
    const withLog = { ...at(s), env: { ...env, FILE_LOCK_LOG: blocked } };
    let open;
    acmeScf.gate = new Promise((ok) => (open = ok));
    const first = runAsync(['export', '--to', 'scf'], withLog);
    await until(() => acmeScf.arrived >= 1);
    const second = runAsync(['export', '--to', 'scf'], withLog);
    // The second run is either blocked on the lock (the line) or, with no lock, already posting (a second arrival): no clock decides.
    await until(() => queued() || acmeScf.arrived >= 2);
    open();
    assert.equal((await first).status, 0);
    assert.equal((await second).status, 0);
    assert.equal(acmeScf.posts, 1);
    assert.equal(acmeScf.proposals.length, 1);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('F10 links belong to the SCF they went to: a changed address sends the pending items again', async () => {
  const { s, acmeScf, betaScf } = await configured();
  const other = await scf();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    await exportScf(s);
    assert.equal(run(['init', '--scf', `acme=${other.url}`, '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
    const r = await exportScf(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(other.proposals.length, 1);
    assert.equal(acmeScf.proposals.length, 1);
  } finally {
    await other.close();
    await acmeScf.close();
    await betaScf.close();
  }
});

test('F11 a listing too long for memory to read fails the export instead of stopping silently', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    acmeScf.endless = true;
    const r = await exportScf(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /more than 10000 proposals/);
    assert.equal(acmeScf.posts, 0);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});

test('F12 a redirect is never followed: the host it names gets no request and no key', async () => {
  const { s, acmeScf, betaScf } = await configured();
  const receiver = await scf();
  const redirecting = await scf({ redirectTo: receiver.url });
  try {
    assert.equal(run(['init', '--scf', `acme=${redirecting.url}`, '--confirm'], { cwd: s.base, data: s.data, config: s.configA }).status, 0);
    propose(s, s.acmeApi, s.configA, 'A statement');
    const r = await exportScf(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unreachable/);
    assert.equal(receiver.calls, 0);
    assert.deepEqual(receiver.auths, []);
  } finally {
    await receiver.close();
    await redirecting.close();
    await acmeScf.close();
    await betaScf.close();
  }
});

test('F13 feedback is read a page at a time', async () => {
  const { s, acmeScf, betaScf } = await configured();
  try {
    propose(s, s.acmeApi, s.configA, 'The cache is cleared on deploy');
    await exportScf(s);
    acmeScf.accept(0, 'fact-1');
    acmeScf.feedback['fact-1'] = Array.from({ length: 501 }, (_, i) => ({ run_id: `r${i}`, outcome: 'reinforced' }));
    assert.match((await importScf(s)).stdout, /501 helped/);
  } finally {
    await acmeScf.close();
    await betaScf.close();
  }
});
