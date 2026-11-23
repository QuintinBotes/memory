import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
  /** `version` is the consent plan's version agreed to; absent in a consent saved before plans had one. */
  consent?: { planHash: string; grantedAt: string; version?: number };
  /** Automatic capture at the end of a session; on unless `enabled` is false, and only once the owner has confirmed the plan that lists it. */
  capture?: CaptureConfig;
}

/** `model` names the filter ('haiku' or 'fake'); `apiModel` is the Anthropic model alias the haiku filter calls. */
export interface CaptureConfig {
  enabled?: boolean;
  model?: string;
  maxCandidates?: number;
  apiModel?: string;
}
export const DEFAULT_CAPTURE = { enabled: true, model: 'haiku', maxCandidates: 5, apiModel: 'claude-haiku-5-5' };
export const captureSettings = (config: Config): typeof DEFAULT_CAPTURE => ({ ...DEFAULT_CAPTURE, ...config.capture });

export const SILOS = ['rejections', 'standards', 'policy', 'notes'] as const;
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
  return {
    tenants: c.tenants,
    configs: c.configs,
    optIns: { transcripts: optIns.transcripts === true, failingCommands: optIns.failingCommands === true },
    ...(budget !== undefined ? { sessionBudget: budget } : {}),
    ...(types !== undefined ? { subagentTypes: types } : {}),
    ...(imports !== undefined ? { imports } : {}),
    ...(c.consent !== undefined ? { consent: c.consent } : {}),
    ...(capture !== undefined ? { capture } : {}),
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
  });
  return createHash('sha256').update(canonical).digest('hex');
}

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
