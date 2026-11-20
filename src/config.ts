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
 */
export interface Config {
  tenants: Record<string, string[]>;
  configs: Record<string, string[]>;
  optIns: { transcripts: boolean; failingCommands: boolean };
  sessionBudget?: number;
  consent?: { planHash: string; grantedAt: string };
}

export const DEFAULT_SESSION_BUDGET = 300;
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
  return {
    tenants: c.tenants,
    configs: c.configs,
    optIns: { transcripts: optIns.transcripts === true, failingCommands: optIns.failingCommands === true },
    ...(budget !== undefined ? { sessionBudget: budget } : {}),
    ...(c.consent !== undefined ? { consent: c.consent } : {}),
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
