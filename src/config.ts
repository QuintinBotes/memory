import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Memory's one configuration file, machine-wide, in the data directory.
 *
 * `tenants` maps a tenant name to GitHub `owner/*` or `owner/repo` patterns.
 * `configs` binds a Claude Code config directory to the tenants it may open.
 * `consent` holds the hash of the plan the owner confirmed; any change to
 * tenants, bindings or opt-ins changes the hash, and memory is inert until the
 * owner confirms the new plan.
 *
 * `imports` maps a repository checkout to the silo files `memory import`
 * reads there, each a path inside the checkout. No path has a default.
 */
export interface Config {
  tenants: Record<string, string[]>;
  configs: Record<string, string[]>;
  optIns: { transcripts: boolean; failingCommands: boolean };
  sessionBudget?: number;
  /** Subagent types, beyond general-purpose, that get the slice at their start. */
  subagentTypes?: string[];
  imports?: Record<string, RepositorySilos>;
  /** Which embedding provider and model recall uses; absent means voyage-4. */
  embeddings?: { provider: (typeof EMBEDDING_PROVIDERS)[number]; model?: string };
  /** `version` is the consent plan's version agreed to; absent in a consent saved before plans had one. */
  consent?: { planHash: string; grantedAt: string; version?: number };
  /** Automatic capture at the end of a session; on unless `enabled` is false, and only once the owner has confirmed the plan that lists it. */
  capture?: CaptureConfig;
  /** Whether sessions started by automation may capture and propose (FR-008 of #22); off unless true, and part of the consent plan. */
  automation?: boolean;
  /** Recall at the point of action (#14): items anchored where an agent reads or edits; off unless true. */
  pointOfAction?: boolean;
  /** The code anchor provider `memory recall --diff` asks for a change's impact (#16): a command, run without a shell. */
  impactProvider?: { command: string[] };
  /** The SCF each tenant exports its proposals to (#13), by tenant name; a tenant without an entry sends nothing. Part of the consent plan. */
  scf?: Record<string, { url: string }>;
  /** Set by memory itself when two memory-linked reverts came within seven days (#18); every recall stays off until the owner runs `memory init --recall on`. */
  recallOff?: { reason: string; at: string };
}

export const EMBEDDING_PROVIDERS = ['voyage', 'fake'] as const;
/** `model` names the filter ('haiku' or 'fake'); `apiModel` is the Anthropic model alias the haiku filter calls. */
export interface CaptureConfig {
  enabled?: boolean;
  model?: string;
  maxCandidates?: number;
  apiModel?: string;
}
export const DEFAULT_CAPTURE = { enabled: true, model: 'haiku', maxCandidates: 5, apiModel: 'claude-haiku-5-5' };
export const captureSettings = (config: Config): typeof DEFAULT_CAPTURE => ({ ...DEFAULT_CAPTURE, ...config.capture });

/** `decisions` names a Review Voice store and `orbit` an Orbit knowledge store (default `.orbit/knowledge.sqlite`), SQLite files, absolute or relative to the checkout; the others are text files inside it. */
export const SILOS = ['rejections', 'standards', 'policy', 'notes', 'decisions', 'orbit'] as const;
export type RepositorySilos = Partial<Record<(typeof SILOS)[number], string>>;

export const DEFAULT_SESSION_BUDGET = 300;
export const SUBAGENT_BUDGET = 300;
/**
 * Read-only and review agents: a reviewer primed with the owner's preferences is no longer independent. Review Voice's
 * agents are refused bare too, as its own hooks accept them, so a user agent of the same name is refused as well.
 */
const REVIEW_VOICE_AGENTS = ['challenger', 'concise-editor', 'concurrency-analyst', 'diff-analyst', 'evidence-verifier', 'intent-extractor', 'security-analyst', 'structure-analyst', 'tie-breaker'];
export const neverSubagent = (type: string): boolean =>
  type === 'Explore' || type === 'Plan' || type.startsWith('review-voice:') || REVIEW_VOICE_AGENTS.includes(type);
export const subagentAllowed = (config: Config, type: string): boolean =>
  !neverSubagent(type) && (type === 'general-purpose' || (config.subagentTypes ?? []).includes(type));
/** The configured address as a URL, or why it is refused: https, or http to this machine only; no credentials, query or fragment. */
export function scfUrl(text: string): URL | string {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return `"${text}" is not a URL`;
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'an SCF address must be https (http only to this machine)';
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return 'an SCF address carries no credentials, query or fragment';
  // No empty or dot segment: "//host" in a path would read as another host once a route is appended.
  if (!/^(\/[A-Za-z0-9._~-]+)*\/?$/.test(u.pathname) || u.pathname.split('/').some((seg) => seg === '.' || seg === '..')) return 'an SCF address path holds only plain segments';
  return u;
}

/** What links to an SCF are scoped to: its origin and path prefix, no trailing slash. */
export const scfEndpoint = (u: URL): string => `${u.origin}${u.pathname.replace(/\/$/, '')}`;

export const TENANT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const TENANT_PATTERN = /^[a-z0-9][a-z0-9_.-]*\/(?:\*|[a-z0-9_.-]+)$/i;

export class ConfigError extends Error {}

export const configPath = (data: string): string => join(data, 'config.json');

/** The Claude Code config this process runs under, as an absolute path. */
export function currentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return resolve(dir !== undefined && dir.length > 0 ? dir : join(homedir(), '.claude'));
}

export function emptyConfig(): Config {
  return { tenants: {}, configs: {}, optIns: { transcripts: false, failingCommands: false } };
}

const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isListMap = (v: unknown): v is Record<string, string[]> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isList);

/** Null when there is no configuration yet; throws when the file is not one this code wrote. */
export function loadConfig(data: string): Config | null {
  const path = configPath(data);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const c = raw as Partial<Config>;
  if (typeof raw !== 'object' || raw === null || !isListMap(c.tenants) || !isListMap(c.configs)) {
    throw new ConfigError(`${path} must hold "tenants" and "configs" maps of lists`);
  }
  for (const name of Object.keys(c.tenants)) {
    if (!TENANT_NAME.test(name)) throw new ConfigError(`tenant name "${name}" is not lower-case letters, digits and dashes`);
  }
  const optIns = c.optIns ?? { transcripts: false, failingCommands: false };
  const budget = c.sessionBudget;
  if (budget !== undefined && !(Number.isInteger(budget) && budget >= 0)) {
    throw new ConfigError('sessionBudget must be a whole number, 0 or more');
  }
  const types = c.subagentTypes;
  if (types !== undefined && !isList(types)) throw new ConfigError('subagentTypes must be a list of agent type names');
  const never = types?.find(neverSubagent);
  if (never !== undefined) throw new ConfigError(`subagentTypes names ${never}, which can never receive the slice`);
  const imports = c.imports;
  if (
    imports !== undefined &&
    !(
      typeof imports === 'object' && imports !== null && !Array.isArray(imports) &&
      Object.values(imports).every(
        (silos) =>
          typeof silos === 'object' && silos !== null &&
          Object.entries(silos).every(([k, v]) => (SILOS as readonly string[]).includes(k) && typeof v === 'string'),
      )
    )
  ) {
    throw new ConfigError(`imports must map a checkout path to file paths named ${SILOS.join(', ')}`);
  }
  const emb = c.embeddings;
  if (
    emb !== undefined &&
    !(
      typeof emb === 'object' && emb !== null && !Array.isArray(emb) &&
      (EMBEDDING_PROVIDERS as readonly string[]).includes(emb.provider) &&
      (emb.model === undefined || (typeof emb.model === 'string' && emb.model !== ''))
    )
  ) {
    throw new ConfigError(`embeddings must be {"provider": ${EMBEDDING_PROVIDERS.map((p) => `"${p}"`).join(' or ')}, "model"?: a name}`);
  }
  const capture = c.capture;
  if (capture !== undefined) {
    const ok = typeof capture === 'object' && capture !== null && !Array.isArray(capture);
    const { enabled, model, maxCandidates, apiModel } = ok ? capture : ({} as CaptureConfig);
    if (
      !ok ||
      (enabled !== undefined && typeof enabled !== 'boolean') ||
      (model !== undefined && typeof model !== 'string') ||
      (apiModel !== undefined && typeof apiModel !== 'string') ||
      (maxCandidates !== undefined && !(Number.isInteger(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 20))
    ) {
      throw new ConfigError('capture must be { enabled: true|false, model: "haiku"|"fake", maxCandidates: 1 to 20, apiModel: a model alias }');
    }
  }
  if (c.automation !== undefined && typeof c.automation !== 'boolean') throw new ConfigError('automation must be true or false');
  if (c.pointOfAction !== undefined && typeof c.pointOfAction !== 'boolean') throw new ConfigError('pointOfAction must be true or false');
  const impact = c.impactProvider;
  if (
    impact !== undefined &&
    !(typeof impact === 'object' && impact !== null && !Array.isArray(impact) && isList(impact.command) && impact.command.length > 0 && impact.command.every((a) => a !== ''))
  ) {
    throw new ConfigError('impactProvider must be {"command": [absolute program path, arguments...]}');
  }
  // A relative program would resolve inside the repository, which could then supply it.
  if (impact !== undefined && !isAbsolute(impact.command[0]!)) {
    throw new ConfigError('impactProvider.command[0] must be an absolute path');
  }
  const scf = c.scf;
  if (scf !== undefined) {
    const entries = typeof scf === 'object' && scf !== null && !Array.isArray(scf) ? Object.entries(scf) : null;
    const bad = entries === null ? 'scf must map a tenant name to {"url": an address}' : entries.map(([t, v]) => (!(t in c.tenants!) ? `scf names tenant "${t}", which does not exist` : typeof v?.url !== 'string' ? `scf.${t} needs a "url"` : typeof scfUrl(v.url) === 'string' ? `scf.${t}: ${scfUrl(v.url) as string}` : null)).find((m) => m !== null);
    if (bad !== undefined && bad !== null) throw new ConfigError(bad);
  }
  const off = c.recallOff;
  if (off !== undefined && !(typeof off === 'object' && off !== null && typeof off.reason === 'string' && typeof off.at === 'string')) {
    throw new ConfigError('recallOff must be { reason: text, at: a time }');
  }
  return {
    tenants: c.tenants,
    configs: c.configs,
    optIns: { transcripts: optIns.transcripts === true, failingCommands: optIns.failingCommands === true },
    ...(budget !== undefined ? { sessionBudget: budget } : {}),
    ...(types !== undefined ? { subagentTypes: types } : {}),
    ...(imports !== undefined ? { imports } : {}),
    ...(emb !== undefined ? { embeddings: emb } : {}),
    ...(c.consent !== undefined ? { consent: c.consent } : {}),
    ...(capture !== undefined ? { capture } : {}),
    ...(c.automation !== undefined ? { automation: c.automation } : {}),
    ...(c.pointOfAction !== undefined ? { pointOfAction: c.pointOfAction } : {}),
    ...(impact !== undefined ? { impactProvider: impact } : {}),
    ...(scf !== undefined ? { scf } : {}),
    ...(off !== undefined ? { recallOff: off } : {}),
  };
}

export function saveConfig(data: string, config: Config): void {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const path = configPath(data);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Order-free: the same tenants, bindings and opt-ins hash the same however they were written. */
export function planHash(config: Config): string {
  const sorted = (m: Record<string, string[]>) =>
    Object.keys(m)
      .sort()
      .map((k) => [k, [...(m[k] ?? [])].sort()]);
  const canonical = JSON.stringify({
    tenants: sorted(config.tenants),
    configs: sorted(config.configs),
    optIns: [config.optIns.transcripts, config.optIns.failingCommands],
    // Only when on, so a consent given before this existed still holds.
    ...(config.automation === true ? { automation: true } : {}),
    // Likewise: a destination for a tenant's items needs the owner's yes.
    ...(config.scf !== undefined && Object.keys(config.scf).length > 0 ? { scf: sorted(Object.fromEntries(Object.entries(config.scf).map(([k, v]) => [k, [v.url]]))) } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Whether recall may show anything: consent holds and memory has not turned itself off after reverts. */
export const recallOn = (config: Config | null): config is Config => consented(config) && config.recallOff === undefined;

export const consented = (config: Config | null): config is Config =>
  config !== null && config.consent?.planHash === planHash(config);

/** Every tenant, owner and repository name: a person or global item must carry none of them. */
export function organisationTerms(config: Config, repository: string | null): string[] {
  const terms = new Set<string>(Object.keys(config.tenants));
  for (const patterns of Object.values(config.tenants)) {
    for (const p of patterns) for (const part of p.split('/')) if (part !== '*') terms.add(part);
  }
  if (repository !== null) for (const part of repository.split('/')) terms.add(part);
  return [...terms];
}
