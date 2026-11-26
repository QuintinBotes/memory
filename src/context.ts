import { runProgram } from './provider/run.ts';
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

/** The variables that point git at a repository other than the working directory's. */
export const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

/**
 * git, asked about the working directory only. A repository named in the
 * environment is not the one the session is in. Null when git answered no;
 * throws when git could not answer (not installed, output over 64 MiB), so a
 * caller never reads "could not run" as "not there".
 */
export function git(cwd: string, ...args: string[]): string | null {
  // A partial clone may fetch a missing object; it must never wait on a credential prompt in a hook.
  const r = runProgram('git', args, cwd, { GIT_TERMINAL_PROMPT: '0' });
  if (r.error !== undefined && r.missing !== true) throw r.error;
  return r.stdout;
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

/** What a read may reach beyond the repository in play: one other repository of the bound tenant, or all of that tenant's. */
export type Reach = { repository: string } | 'all';

/** `owner/repo` as a repository filter takes it. */
export const REPOSITORY_FILTER = /^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/;

/**
 * The repository a `--repo` or `repository` filter names, or why it may not be read. Only a repository of the tenant bound
 * here is reachable: `matchingTenants` must return exactly that tenant. The refusal names no other tenant, and nothing is
 * opened to decide it. `malformed` marks a value that is not owner/repo at all, a usage error.
 */
export function filterRepository(config: Config, context: Context, value: string): { repository: string } | { reason: string; malformed: boolean } {
  const repository = value.trim().toLowerCase();
  if (!REPOSITORY_FILTER.test(repository)) return { reason: `${value} is not owner/repo`, malformed: true };
  if (context.tenant === null) return { reason: `no tenant is bound here, so there is no repository to filter by; only the person file can be read`, malformed: false };
  const [owner, repo] = repository.split('/') as [string, string];
  const tenants = matchingTenants(config, owner, repo);
  if (tenants.length !== 1 || tenants[0] !== context.tenant) return { reason: `${repository} is not a repository of the tenant bound here, so it cannot be read from here`, malformed: false };
  return { repository };
}
