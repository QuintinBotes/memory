import { spawnSync } from 'node:child_process';
import type { Config } from './config.ts';

export interface Context {
  /** `owner/repo`, lower case, or null when the remote is not on github.com. */
  repository: string | null;
  owner: string | null;
  /** The tenant this process may open here, or null: then only person and global items apply. */
  tenant: string | null;
  /** Why the tenant is null, for messages. */
  reason: string;
}

/**
 * git, asked about the working directory only. A repository named in the
 * environment is not the one the session is in.
 */
export function git(cwd: string, ...args: string[]): string | null {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) delete env[k];
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** `owner/repo` from a github.com remote URL; null for any other host or shape. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!m) return null;
  return { owner: m[1]!.toLowerCase(), repo: m[2]!.toLowerCase() };
}

/** Every tenant whose patterns match `owner/repo`. */
export function matchingTenants(config: Config, owner: string, repo: string): string[] {
  return Object.keys(config.tenants)
    .filter((name) =>
      (config.tenants[name] ?? []).some((pattern) => {
        const [o, r] = pattern.toLowerCase().split('/');
        return o === owner && (r === '*' || r === repo);
      }),
    )
    .sort();
}

/**
 * Fails closed: no remote, a host other than github.com, no matching tenant,
 * two matching tenants, or a tenant not bound to this Claude Code config all
 * mean no tenant.
 */
export function resolveContext(cwd: string, config: Config, configDir: string): Context {
  // The configured value, not `remote get-url`, which applies url.*.insteadOf
  // rewrites and could make another host's checkout read as a github.com one.
  const url = git(cwd, 'config', '--get', 'remote.origin.url');
  const parsed = url === null ? null : parseGitHubRemote(url);
  if (parsed === null) return { repository: null, owner: null, tenant: null, reason: 'no github.com origin remote here' };
  const repository = `${parsed.owner}/${parsed.repo}`;
  const base = { repository, owner: parsed.owner };
  const tenants = matchingTenants(config, parsed.owner, parsed.repo);
  if (tenants.length === 0) return { ...base, tenant: null, reason: `${repository} matches no tenant` };
  if (tenants.length > 1) return { ...base, tenant: null, reason: `${repository} matches more than one tenant` };
  const tenant = tenants[0]!;
  if (!(config.configs[configDir] ?? []).includes(tenant)) {
    return { ...base, tenant: null, reason: `this Claude Code config is not bound to tenant ${tenant}` };
  }
  return { ...base, tenant, reason: '' };
}
