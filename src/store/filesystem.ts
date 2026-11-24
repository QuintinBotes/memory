import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** File systems where SQLite's write-ahead log and file locks are not reliable. */
const NETWORK_TYPES = /^(nfs\d*|cifs|smb\w*|smbfs|afpfs|afs|ncpfs|webdav|davfs\w*|9p|fuse\.(sshfs|davfs\w*|rclone)|sshfs|ceph|glusterfs|lustre)$/i;

type Mount = { point: string; type: string };

/** Reads Linux /proc/mounts lines ("dev point type opts") and macOS `mount` lines ("dev on point (type, opts)"). */
export function parseMounts(table: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of table.split('\n')) {
    const mac = /^.+ on (.+) \(([^,)]+)/.exec(line);
    if (mac !== null) {
      mounts.push({ point: mac[1]!, type: mac[2]!.trim() });
      continue;
    }
    const linux = /^\S+ (\S+) (\S+) /.exec(line);
    if (linux !== null) mounts.push({ point: linux[1]!.replace(/\\040/g, ' '), type: linux[2]! });
  }
  return mounts;
}

/** The file system type of the mount holding `path`, from a mount table: the longest mount point that contains it. */
export function mountTypeOf(path: string, table: string): string | undefined {
  const contains = (m: Mount): boolean => m.point === '/' || path === m.point || path.startsWith(m.point + sep);
  return parseMounts(table).filter(contains).sort((a, b) => b.point.length - a.point.length)[0]?.type;
}

function mountTable(): string {
  const file = process.env['MEMORY_MOUNT_TABLE_FILE']; // test seam: stands in for the real table
  if (file !== undefined && file.length > 0) return readFileSync(file, 'utf8');
  try {
    if (process.platform === 'linux') return readFileSync('/proc/mounts', 'utf8');
    if (process.platform === 'darwin') return execFileSync('mount', { encoding: 'utf8', timeout: 3000 });
  } catch {
    // shortcut: an unreadable table is treated as local, so a failed probe never blocks init; Windows is not probed.
  }
  return '';
}

/** The network file system type `dir` (or its nearest existing parent) is on, or undefined when local or unknown. */
export function networkFilesystem(dir: string): string | undefined {
  let probe = resolve(dir);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const type = mountTypeOf(realpathSync(probe), mountTable());
  return type !== undefined && NETWORK_TYPES.test(type) ? type : undefined;
}
