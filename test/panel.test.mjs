import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, run, tools } from './helpers.mjs';

// #104: the data the review pane reads.
const json = (s) => {
  const r = run(['review', '--json'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('#104 SC1 memory review --json lists the proposals memory review prints, with ids, and none when none wait', () => {
  const s = setup();
  assert.deepEqual(json(s).proposals, []);
  const [proposed] = tools(s.acmeApi, s.data, s.configA, [['memory_propose', { statement: 'Releases are cut from main', scope: 'repository', type: 'convention', evidence: { source: 'session-1' } }]]);
  assert.equal(proposed.isError, false, proposed.text);
  const id = /m-[0-9a-f]+/.exec(proposed.text)[0];
  const { proposals } = json(s);
  assert.deepEqual(proposals.map((p) => [p.id, p.statement, p.status, p.scope, p.shadow]), [[id, 'Releases are cut from main', 'proposed', 'repository', 'hold']]);
  assert.match(run(['review'], { cwd: s.acmeApi, data: s.data, config: s.configA }).stdout, new RegExp(id));
  assert.equal(run(['approve', id], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 0);
  assert.deepEqual(json(s).proposals, []);
});

test('#104 memory review --json takes no other argument', () => {
  const s = setup();
  assert.equal(run(['review', '--yaml'], { cwd: s.acmeApi, data: s.data, config: s.configA }).status, 2);
});
