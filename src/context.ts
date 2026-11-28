import { runProgram } from './provider/run.ts';
import type { Config } from './config.ts';

export interface Context {
  /** `owner/repo` on github.com, `host/group/repo` elsewhere, lower case; null without a remote on a host some tenant pattern names. */
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

const OWNER = /^[a-z0-9][a-z0-9-]*$/;
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const GROUP = /^[a-z0-9_][a-z0-9_.-]*$/;
const NAME = /^[a-z0-9._-]+$/;

/**
 * The repository key `value` names, lower case, or null: `owner/repo` on github.com (with or without the host), or
 * `host/group[/subgroup...]/repo` on any other host, the host keeping `acme/api` on two hosts apart.
 */
export function repositoryKey(value: string): string | null {
  const parts = value.trim().toLowerCase().split('/');
  const github = parts[0] === 'github.com';
  if (github) parts.shift();
  const name = parts.at(-1)!;
  const ok = parts.length === 2 ? OWNER.test(parts[0]!) : !github && parts.length > 2 && HOST.test(parts[0]!) && parts.slice(1, -1).every((g) => GROUP.test(g));
  return ok && NAME.test(name) && name !== '.' && name !== '..' ? parts.join('/') : null;
}

/** The host of a repository key or tenant pattern: its first part when it has more than two, else github.com. */
export const hostOf = (key: string): string => (key.split('/').length > 2 ? key.split('/')[0]!.toLowerCase() : 'github.com');

/** The organisation of a repository key: all but its last part (`acme`, `gitlab.com/acme/platform`). */
export const ownerOf = (repository: string): string => repository.slice(0, repository.lastIndexOf('/'));

/** The repository key of an https or ssh remote URL on any host, or null for another shape (a port, a query, a relative path). */
export function parseRemote(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?([^/:@]+)\/|git@([^/:@]+):|ssh:\/\/git@([^/:@]+)\/)(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m === null ? null : repositoryKey(`${m[1] ?? m[2] ?? m[3]}/${m[4]}`);
}

/** With the host spelled out, so a pattern and a key compare whatever their host. */
const full = (key: string): string => (key.split('/').length === 2 ? `github.com/${key}` : key);

/** Every tenant whose patterns match the repository key: `group/*` takes every repository below that group, nested ones included. */
export function matchingTenants(config: Config, repository: string): string[] {
  const repo = full(repository);
  return Object.keys(config.tenants)
    .filter((name) =>
      (config.tenants[name] ?? []).some((pattern) => {
        const p = full(pattern.toLowerCase());
        return p.endsWith('/*') ? repo.startsWith(p.slice(0, -1)) : repo === p;
      }),
    )
    .sort();
}

/**
 * Fails closed: no remote, a host no tenant pattern names, no matching tenant,
 * two matching tenants, or a tenant not bound to this Claude Code config all
 * mean no tenant.
 */
export function resolveContext(cwd: string, config: Config, configDir: string): Context {
  // The configured value, not `remote get-url`, which applies url.*.insteadOf
  // rewrites and could make one host's checkout read as another's.
  const url = git(cwd, 'config', '--get', 'remote.origin.url');
  const repository = url === null ? null : parseRemote(url);
  if (repository === null) return { repository: null, owner: null, tenant: null, reason: 'no origin remote here that names a repository' };
  const host = hostOf(repository);
  if (host !== 'github.com' && !Object.values(config.tenants).some((patterns) => patterns.some((p) => hostOf(p) === host))) {
    return { repository: null, owner: null, tenant: null, reason: `no tenant pattern names the host ${host}` };
  }
  const base = { repository, owner: ownerOf(repository) };
  const tenants = matchingTenants(config, repository);
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

/**
 * The repository a `--repo` or `repository` filter names, or why it may not be read. Only a repository of the tenant bound
 * here is reachable: `matchingTenants` must return exactly that tenant. The refusal names no other tenant, and nothing is
 * opened to decide it. `malformed` marks a value that is not a repository name at all, a usage error.
 */
export function filterRepository(config: Config, context: Context, value: string): { repository: string } | { reason: string; malformed: boolean } {
  const repository = repositoryKey(value);
  if (repository === null) return { reason: `${value} is not owner/repo or host/group/repo`, malformed: true };
  if (context.tenant === null) return { reason: `no tenant is bound here, so there is no repository to filter by; only the person file can be read`, malformed: false };
  const tenants = matchingTenants(config, repository);
  if (tenants.length !== 1 || tenants[0] !== context.tenant) return { reason: `${repository} is not a repository of the tenant bound here, so it cannot be read from here`, malformed: false };
  return { repository };
}
