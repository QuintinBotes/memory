import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, sandbox } from './helpers.mjs';

// Gap 4 (#24), edge case: a store on a network file system is refused at `memory init`, because SQLite's locking is
// not reliable there. The mount table is injected (MEMORY_MOUNT_TABLE_FILE), so no real mount is needed.
const INIT = ['init', '--tenant', 'acme=acme/*', '--bind', 'acme', '--confirm'];

function table(s, mountPoint, linux) {
  const file = join(mkdtempSync(join(tmpdir(), 'memory-mounts-')), 'mounts');
  const real = realpathSync(s.base);
  const point = mountPoint === '' ? '/' : join(real, mountPoint); // '' makes the whole disk the network mount, so it is the only root entry
  writeFileSync(file, linux
    ? `${mountPoint === '' ? '' : '/dev/sda1 / ext4 rw 0 0\n'}fileserver:/export ${point} nfs4 rw,vers=4.2 0 0\n`
    : `/dev/disk3s1 on / (apfs, local)\n//me@nas/share on ${point} (smbfs, nodev, nosuid, mounted by me)\n`);
  return file;
}

for (const [name, linux] of [['Linux /proc/mounts', true], ['macOS mount output', false]]) {
  test(`init refuses a data directory on a network file system (${name}) and names the reason, saving nothing`, () => {
    const s = sandbox();
    mkdirSync(join(s.base, 'net'));
    const data = join(s.base, 'net', 'data');
    const r = run(INIT, { cwd: s.base, data, config: s.configA, env: { MEMORY_MOUNT_TABLE_FILE: table(s, 'net', linux) } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /network file system/i);
    assert.match(r.stderr, /(nfs4|smbfs)/);
    assert.equal(existsSync(data), false, 'nothing is created on the network volume');
  });

  test(`init accepts a local data directory (${name})`, () => {
    const s = sandbox();
    const r = run(INIT, { cwd: s.base, data: s.data, config: s.configA, env: { MEMORY_MOUNT_TABLE_FILE: table(s, 'elsewhere', linux) } });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('init without --confirm also refuses, so the plan is never agreed to for an unsafe store', () => {
  const s = sandbox();
  const r = run(['init', '--tenant', 'acme=acme/*'], { cwd: s.base, data: s.data, config: s.configA, env: { MEMORY_MOUNT_TABLE_FILE: table(s, '', true) } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /network file system/i);
});

test('a macOS mount point containing " on " is read whole, so an smbfs share there is refused', () => {
  const s = sandbox();
  const point = join(realpathSync(s.base), 'Backup on NAS');
  mkdirSync(point);
  const file = join(mkdtempSync(join(tmpdir(), 'memory-mounts-')), 'mounts');
  writeFileSync(file, `/dev/disk3s1 on / (apfs, local)\n//me@nas/share on ${point} (smbfs, nodev, nosuid, mounted by me)\n`);
  const data = join(point, 'data');
  const r = run(INIT, { cwd: s.base, data, config: s.configA, env: { MEMORY_MOUNT_TABLE_FILE: file } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /smbfs/);
  assert.equal(existsSync(data), false);
});
