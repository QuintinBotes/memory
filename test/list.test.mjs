import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, run, remember } from './helpers.mjs';

// #122: an empty store says so, on stderr, so a script reading stdout sees nothing.
test('#122 memory list with nothing visible says so on stderr, naming the tenant; with items the output is unchanged', () => {
  const s = setup();
  const empty = run(['list'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '');
  assert.equal(empty.stderr.trim(), 'No memory items here (tenant acme and the person file).');
  const loose = run(['list'], { cwd: s.loose, data: s.data, config: s.configA });
  assert.match(loose.stderr, /^No memory items here \(the person file only: loose\/tool matches no tenant\)\./);
  assert.equal(remember(s.acmeApi, s.data, s.configA, 'Releases are cut from main').status, 0);
  const listed = run(['list'], { cwd: s.acmeApi, data: s.data, config: s.configA });
  assert.match(listed.stdout, /Releases are cut from main/);
  assert.equal(listed.stderr, '');
});
