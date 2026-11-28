import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { automationReason } from './automation.ts';
import { ConfigError, TENANT_NAME, captureSettings, consented, configPath, emptyConfig, loadConfig, type Config } from './config.ts';
import { PLAN_VERSION, uncovered } from './consent/plan.ts';
import { git, matchingTenants, ownerOf, resolveContext } from './context.ts';
import { PERSON_SCOPE, TENANT_SCOPE } from './items.ts';
import { READS_EXPIRED } from './recall/rank.ts';
import { networkFilesystem } from './store/filesystem.ts';
import { personFile, tenantFile } from './store/paths.ts';
import { pluginVersion } from './version.ts';

/** One line of `memory doctor`: `off` is a choice the owner made, `fail` something to fix, with the command that fixes it. */
export interface Check {
  id: string;
  status: 'ok' | 'off' | 'fail';
  detail: string;
  fix: string | null;
}

const ok = (id: string, detail: string): Check => ({ id, status: 'ok', detail, fix: null });
const off = (id: string, detail: string, fix: string | null = null): Check => ({ id, status: 'off', detail, fix });
const fail = (id: string, detail: string, fix: string | null): Check => ({ id, status: 'fail', detail, fix });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Whether `program` is an executable file in a PATH directory. */
function onPath(program: string, env: NodeJS.ProcessEnv): boolean {
  // shortcut: Windows is matched by .exe and .cmd only, not every PATHEXT entry.
  const names = process.platform === 'win32' ? [`${program}.exe`, `${program}.cmd`] : [program];
  return (env['PATH'] ?? '').split(delimiter).some((dir) =>
    dir !== '' && names.some((n) => {
      try {
        accessSync(join(dir, n), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/** The installed copy against the marketplace checkout Claude Code updates it from (#108). */
function versionCheck(configDir: string): Check {
  const running = pluginVersion();
  const plugins = (readJson(join(configDir, 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, { version?: string }[]> } | undefined)?.plugins ?? {};
  const key = Object.keys(plugins).find((k) => k.startsWith('memory@'));
  const installed = key === undefined ? undefined : plugins[key]?.[0]?.version;
  if (key === undefined || installed === undefined) return off('version', `running ${running}; not installed from a marketplace in this Claude Code config`);
  const market = key.slice('memory@'.length);
  // shortcut: reads the marketplace's root plugin.json, where this repository's own marketplace keeps it.
  const held = (readJson(join(configDir, 'plugins', 'marketplaces', market, '.claude-plugin', 'plugin.json')) as { version?: unknown } | undefined)?.version;
  if (typeof held !== 'string') return fail('version', `installed ${installed}; the ${market} marketplace checkout was not found`, `/plugin marketplace update ${market}`);
  if (held !== installed) return fail('version', `installed ${installed}, the ${market} marketplace holds ${held}`, `/plugin update ${key}`);
  return ok('version', `installed ${installed}, as the ${market} marketplace holds; running ${running}`);
}

function hooksCheck(): Check {
  const hooks = (readJson(join(root, 'hooks', 'hooks.json')) as { hooks?: Record<string, unknown> } | undefined)?.hooks;
  if (hooks === undefined) return fail('hooks', `no hooks/hooks.json in ${root}`, '/plugin update memory@memory');
  return ok('hooks', Object.keys(hooks).join(', '));
}

/** Starts the MCP server as Claude Code does and asks it to initialize; it opens no store to answer. */
function mcpCheck(cwd: string): Check {
  const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'memory-doctor', version: '0' } } };
  const r = spawnSync(process.execPath, [process.argv[1]!, 'mcp'], { cwd, input: `${JSON.stringify(init)}\n`, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'ignore'] });
  const answer = (r.stdout ?? '').split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l) as { id?: unknown; result?: { serverInfo?: { version?: string } } }];
    } catch {
      return [];
    }
  }).find((m) => m.id === 0 && m.result !== undefined);
  if (answer === undefined) return fail('mcp', `the server did not answer initialize${r.error === undefined ? '' : ` (${r.error.message})`}`, '/plugin update memory@memory, then restart Claude Code');
  return ok('mcp', `answers initialize (memory ${answer.result!.serverInfo?.version ?? 'unknown'})`);
}

/** The last line of logs/capture.jsonl, as what that run kept or why it skipped; never the transcript, which the log does not hold. */
function lastCapture(data: string): string {
  const lines = existsSync(join(data, 'logs', 'capture.jsonl')) ? readFileSync(join(data, 'logs', 'capture.jsonl'), 'utf8').trim().split('\n') : [];
  let last: { at?: unknown; skipped?: unknown; saved?: unknown; merged?: unknown };
  try {
    last = JSON.parse(lines.at(-1) ?? '');
  } catch {
    return 'no run logged yet';
  }
  const what = typeof last.skipped === 'string' ? `skipped, ${last.skipped}` : `kept ${Number(last.saved ?? 0)}, merged ${Number(last.merged ?? 0)}`;
  return `last run ${String(last.at)}: ${what}`;
}

function captureCheck(config: Config, data: string, env: NodeJS.ProcessEnv): Check {
  const settings = captureSettings(config);
  const last = lastCapture(data);
  if (!settings.enabled) return off('capture', `capture.enabled is false in config.json; ${last}`, `set "capture": { "enabled": true } in ${configPath(data)}`);
  if (uncovered(config).some((c) => c.id === 'capture')) return fail('capture', `your consent does not cover capture yet; ${last}`, 'memory init --confirm');
  if (settings.model !== 'haiku') return ok('capture', `filter ${settings.model}; ${last}`);
  if ((env['ANTHROPIC_API_KEY'] ?? '') !== '') return ok('capture', `ANTHROPIC_API_KEY set; ${last}`);
  if (onPath('claude', env)) return ok('capture', `through the Claude Code login (claude on PATH); ${last}`);
  return fail('capture', `no ANTHROPIC_API_KEY and no claude on PATH; ${last}`, 'set ANTHROPIC_API_KEY, or put Claude Code\'s claude on PATH');
}

async function reachable(id: string, url: string): Promise<Check> {
  try {
    const res = await fetch(new URL('api/tags', url.endsWith('/') ? url : `${url}/`), { signal: AbortSignal.timeout(2000) });
    return res.ok ? ok(id, `Ollama answers at ${url}`) : fail(id, `Ollama at ${url} answered ${res.status}`, `start Ollama at ${url}`);
  } catch {
    return fail(id, `nothing answers at ${url}`, `start Ollama at ${url}`);
  }
}

const OLLAMA = 'http://127.0.0.1:11434';

async function embedderChecks(config: Config, env: NodeJS.ProcessEnv): Promise<Check[]> {
  const e = config.embeddings;
  const embed =
    e === undefined ? off('embeddings', 'no embedder in config.json; search uses words and paths')
    : e.provider === 'ollama' ? await reachable('embeddings', e.url ?? OLLAMA)
    : e.provider === 'voyage' ? ((env['VOYAGE_API_KEY'] ?? '') !== '' ? ok('embeddings', 'voyage, VOYAGE_API_KEY set') : fail('embeddings', 'voyage needs VOYAGE_API_KEY', 'set VOYAGE_API_KEY'))
    : ok('embeddings', e.provider);
  const rerank = config.rerank === undefined ? off('rerank', 'no reranker in config.json') : await reachable('rerank', config.rerank.url ?? OLLAMA);
  return [embed, rerank];
}

function anchorsCheck(config: Config): Check {
  const command = config.impactProvider?.command;
  if (command === undefined) return off('anchors', 'no impactProvider in config.json; anchors are checked by path and hash (docs/provider.md)');
  try {
    accessSync(command[0]!, constants.X_OK);
    return ok('anchors', command[0]!);
  } catch {
    return fail('anchors', `${command[0]} is not an executable file`, `fix impactProvider.command in config.json (docs/provider.md)`);
  }
}

/** Counts by status, read-only and only of the tenant bound here and the person file; never a statement. */
function counts(file: string, where: string, ...args: string[]): string {
  if (!existsSync(file)) return 'no store yet';
  // A read-only open of a WAL store still creates its -wal and -shm files; without them every write is in the main file, which immutable reads without touching anything.
  const live = existsSync(`${file}-wal`) && existsSync(`${file}-shm`);
  const url = pathToFileURL(file);
  if (!live) url.searchParams.set('immutable', '1');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(url, { readOnly: true });
  } catch (error) {
    return `not read (${(error as Error).message})`;
  }
  try {
    const current = `status = 'active' AND valid_to IS NULL`;
    const r = db.prepare(
      `SELECT count(CASE WHEN ${current} AND NOT ${READS_EXPIRED} THEN 1 END) AS active, count(CASE WHEN status = 'proposed' THEN 1 END) AS proposed,
              count(CASE WHEN status = 'stale' THEN 1 END) AS stale, count(CASE WHEN ${current} AND ${READS_EXPIRED} THEN 1 END) AS expired
         FROM items WHERE ${where}`,
    ).get(...args) as Record<string, number>;
    return `${r['active']} active, ${r['proposed']} proposed, ${r['stale']} stale, ${r['expired']} expired`;
  } finally {
    db.close();
  }
}

/** Every check, in order. Read only: it writes no file and opens no store but the tenant bound here and the person file. */
export async function doctor(data: string, cwd: string, configDir: string, env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const checks: Check[] = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push(major > 22 || (major === 22 && minor >= 13) ? ok('node', process.versions.node) : fail('node', `${process.versions.node}; memory needs 22.13 or later`, 'install Node 22.13 or later'));

  const network = networkFilesystem(data);
  checks.push(network !== undefined ? fail('data', `${data} is on a network file system (${network})`, 'set MEMORY_DATA_DIR to a local disk') : ok('data', `${data}, local disk`));
  checks.push(versionCheck(configDir));

  let config: Config | null = null;
  try {
    config = loadConfig(data);
    const agreed = config === null ? [] : uncovered(config);
    if (config === null) checks.push(fail('consent', 'memory is not set up', 'memory init --tenant <name>=<owner>/* --bind <name> --confirm'));
    else if (!consented(config)) checks.push(fail('consent', 'the configuration changed since you agreed to it; memory is inert', 'memory init --confirm'));
    else if (agreed.length > 0) checks.push(fail('consent', `agreed to plan version ${config.consent?.version ?? 1} of ${PLAN_VERSION}; not yet agreed: ${agreed.map((k) => k.id).join(', ')}`, 'memory init --confirm'));
    else checks.push(ok('consent', `plan version ${PLAN_VERSION}, every category agreed`));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    checks.push(fail('consent', error.message, `correct ${configPath(data)}`));
  }

  const c = config ?? emptyConfig();
  const context = resolveContext(cwd, c, configDir);
  const url = git(cwd, 'config', '--get', 'remote.origin.url')?.trim();
  if (context.repository === null) checks.push(off('tenant', `${context.reason}; only the person file applies`));
  else {
    const group = ownerOf(context.repository);
    const owner = group.split('/').at(-1)!;
    const tenants = matchingTenants(c, context.repository);
    const bound = c.configs[configDir] ?? [];
    if (tenants.length === 0) {
      // init refuses "person" and a name over 40 characters; an existing tenant of that name keeps its patterns.
      const name = TENANT_NAME.test(owner) && owner !== 'person' ? owner : 'work';
      const patterns = [...(c.tenants[name] ?? []), `${group}/*`].join(',');
      checks.push(fail('tenant', `${context.repository} (remote ${url}) matches no tenant`, `memory init --tenant ${name}=${patterns} --bind ${[...new Set([...bound, name])].join(',')} --confirm`));
    } else if (tenants.length > 1) checks.push(fail('tenant', `${context.repository} matches tenants ${tenants.join(', ')}`, `keep ${context.repository} in one tenant's patterns in ${configPath(data)}`));
    else checks.push(ok('tenant', `${context.repository} is tenant ${tenants[0]}`));
    if (tenants.length === 1) {
      const t = tenants[0]!;
      checks.push(bound.includes(t) ? ok('binding', `${configDir} is bound to ${t}`) : fail('binding', `${configDir} is not bound to ${t}`, `memory init --bind ${[...bound, t].join(',')} --confirm`));
    }
  }

  const automated = automationReason(env);
  checks.push(automated === null ? ok('automation', "a person's session") : c.automation === true ? ok('automation', `started by automation (${automated}); the consent plan names automation sessions`) : off('automation', `started by automation (${automated}); it neither captures nor proposes`, 'memory init --automation on --confirm'));
  checks.push(hooksCheck());
  checks.push(mcpCheck(cwd));
  checks.push(captureCheck(c, data, env));
  checks.push(c.recallOff !== undefined ? fail('recall', `off since ${c.recallOff.at}: ${c.recallOff.reason}`, 'memory init --recall on --confirm') : ok('recall', 'on'));
  checks.push(c.pointOfAction === true ? ok('pointOfAction', 'on') : off('pointOfAction', 'off; items anchored to code appear only at session start', `set "pointOfAction": true in ${configPath(data)}`));
  checks.push(...(await embedderChecks(c, env)));
  checks.push(anchorsCheck(c));

  const here = context.tenant === null || context.repository === null ? '' : `${context.repository}: ${counts(tenantFile(data, context.tenant), TENANT_SCOPE, context.tenant, context.repository, context.owner!)}; `;
  checks.push(ok('items', `${here}person file: ${counts(personFile(data), PERSON_SCOPE)}`));
  return checks;
}

/** One line a check, `fix:` under each that has one; or with `json` one object a line, the same bytes for the same state. */
export function renderChecks(checks: Check[], json: boolean): string {
  if (json) return checks.map((k) => `${JSON.stringify({ id: k.id, status: k.status, detail: k.detail, fix: k.fix })}\n`).join('');
  return checks.map((k) => `${k.status.padEnd(4)}  ${k.id.padEnd(13)} ${k.detail}\n${k.fix === null ? '' : `${' '.repeat(20)}fix: ${k.fix}\n`}`).join('');
}
