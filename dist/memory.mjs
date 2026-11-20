#!/usr/bin/env node

// src/cli.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, readdirSync } from "node:fs";
import { isAbsolute, join as join4, normalize } from "node:path";
import { parseArgs } from "node:util";

// src/warnings.ts
function suppressSqliteExperimentalWarning() {
  const handlers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) {
      return;
    }
    if (handlers.length > 0) {
      for (const handler of handlers) handler(warning);
      return;
    }
    process.emitWarning(warning.message, warning.name);
  });
}

// src/version.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
function pluginVersion() {
  const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof parsed.version === "string" ? parsed.version : "0.0.0-unknown";
}

// src/config.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2, resolve } from "node:path";
var DEFAULT_SESSION_BUDGET = 300;
var TENANT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
var TENANT_PATTERN = /^[a-z0-9][a-z0-9_.-]*\/(?:\*|[a-z0-9_.-]+)$/i;
var ConfigError = class extends Error {
};
var configPath = (data) => join2(data, "config.json");
function currentConfigDir(env = process.env) {
  const dir = env["CLAUDE_CONFIG_DIR"];
  return resolve(dir !== void 0 && dir.length > 0 ? dir : join2(homedir(), ".claude"));
}
function emptyConfig() {
  return { tenants: {}, configs: {}, optIns: { transcripts: false, failingCommands: false } };
}
var isList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
var isListMap = (v) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isList);
function loadConfig(data) {
  const path = configPath(data);
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const c = raw;
  if (typeof raw !== "object" || raw === null || !isListMap(c.tenants) || !isListMap(c.configs)) {
    throw new ConfigError(`${path} must hold "tenants" and "configs" maps of lists`);
  }
  for (const name of Object.keys(c.tenants)) {
    if (!TENANT_NAME.test(name)) throw new ConfigError(`tenant name "${name}" is not lower-case letters, digits and dashes`);
  }
  const optIns = c.optIns ?? { transcripts: false, failingCommands: false };
  const budget = c.sessionBudget;
  if (budget !== void 0 && !(Number.isInteger(budget) && budget >= 0)) {
    throw new ConfigError("sessionBudget must be a whole number, 0 or more");
  }
  return {
    tenants: c.tenants,
    configs: c.configs,
    optIns: { transcripts: optIns.transcripts === true, failingCommands: optIns.failingCommands === true },
    ...budget !== void 0 ? { sessionBudget: budget } : {},
    ...c.consent !== void 0 ? { consent: c.consent } : {}
  };
}
function saveConfig(data, config) {
  mkdirSync(data, { recursive: true, mode: 448 });
  const path = configPath(data);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
  renameSync(tmp, path);
}
function planHash(config) {
  const sorted = (m) => Object.keys(m).sort().map((k) => [k, [...m[k] ?? []].sort()]);
  const canonical = JSON.stringify({
    tenants: sorted(config.tenants),
    configs: sorted(config.configs),
    optIns: [config.optIns.transcripts, config.optIns.failingCommands]
  });
  return createHash("sha256").update(canonical).digest("hex");
}
var consented = (config) => config !== null && config.consent?.planHash === planHash(config);

// src/context.ts
import { spawnSync } from "node:child_process";
function git(cwd, ...args) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"]) delete env[k];
  env["GIT_TERMINAL_PROMPT"] = "0";
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== void 0 && r.error.code !== "ENOENT") throw r.error;
  return r.status === 0 ? r.stdout : null;
}
function parseGitHubRemote(url) {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    url.trim()
  );
  if (!m) return null;
  return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() };
}
function matchingTenants(config, owner, repo) {
  return Object.keys(config.tenants).filter(
    (name) => (config.tenants[name] ?? []).some((pattern) => {
      const [o, r] = pattern.toLowerCase().split("/");
      return o === owner && (r === "*" || r === repo);
    })
  ).sort();
}
function resolveContext(cwd, config, configDir) {
  const url = git(cwd, "config", "--get", "remote.origin.url");
  const parsed = url === null ? null : parseGitHubRemote(url);
  if (parsed === null) return { repository: null, owner: null, tenant: null, reason: "no github.com origin remote here" };
  const repository = `${parsed.owner}/${parsed.repo}`;
  const base = { repository, owner: parsed.owner };
  const tenants = matchingTenants(config, parsed.owner, parsed.repo);
  if (tenants.length === 0) return { ...base, tenant: null, reason: `${repository} matches no tenant` };
  if (tenants.length > 1) return { ...base, tenant: null, reason: `${repository} matches more than one tenant` };
  const tenant = tenants[0];
  if (!(config.configs[configDir] ?? []).includes(tenant)) {
    return { ...base, tenant: null, reason: `this Claude Code config is not bound to tenant ${tenant}` };
  }
  return { ...base, tenant, reason: "" };
}

// src/redact/redact.ts
import { createHash as createHash2 } from "node:crypto";

// src/redact/patterns.ts
var SECRET_PATTERNS = [
  // Key material is replaced whole: a PEM block's header is not the secret,
  // but leaving it invites someone to reconstruct what was removed. When a
  // header has no footer after it, no later header has one either, so the
  // second branch takes the rest of the text with group 1 unset, which
  // replaces nothing, instead of every later header searching it again.
  {
    label: "PRIVATE_KEY",
    pattern: /(-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----)|-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*/gd,
    group: 1
  },
  {
    label: "PEM_BLOCK",
    pattern: /(-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----)|-----BEGIN [A-Z ]+-----[\s\S]*/gd,
    group: 1
  },
  { label: "GITHUB_TOKEN", pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,255})\b/gd, group: 1 },
  { label: "GITHUB_TOKEN", pattern: /\b(github_pat_[A-Za-z0-9_]{20}[A-Za-z0-9_]*)\b/gd, group: 1 },
  { label: "AWS_ACCESS_KEY", pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/gd, group: 1 },
  {
    label: "AWS_SECRET_KEY",
    pattern: /\b(?:aws_secret_access_key|aws_secret)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gid,
    group: 1
  },
  { label: "GOOGLE_API_KEY", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/gd, group: 1 },
  { label: "SLACK_TOKEN", pattern: /\b(xox[abposr]-[0-9A-Za-z-]{10}[0-9A-Za-z-]*)\b/gd, group: 1 },
  { label: "STRIPE_KEY", pattern: /\b((?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16}[0-9A-Za-z]*)\b/gd, group: 1 },
  { label: "NPM_TOKEN", pattern: /\b(npm_[A-Za-z0-9]{36})\b/gd, group: 1 },
  { label: "PYPI_TOKEN", pattern: /\b(pypi-[A-Za-z0-9_-]{16}[A-Za-z0-9_-]*)\b/gd, group: 1 },
  { label: "OPENAI_KEY", pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*)\b/gd, group: 1 },
  { label: "ANTHROPIC_KEY", pattern: /\b(sk-ant-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*)\b/gd, group: 1 },
  // JWTs: three base64url segments. The payload is often the sensitive part.
  // A segment cannot contain '.', so the first always ends where its run of
  // base64url characters ends, and the leftmost eyJ that may start a token
  // (at the run's start or after a '-') succeeds wherever a later one in the
  // same run would. Each run is tried once, from that eyJ, with the first two
  // segments taken whole: trying every '-eyJ' rescanned the run each time. The
  // last segment can still give back a trailing '-' to meet the closing \b.
  {
    label: "JWT",
    pattern: /(?<![A-Za-z0-9_-])(?=((?:[A-Za-z0-9_-]*?-)??)eyJ)\1(eyJ(?=([A-Za-z0-9_-]{8}[A-Za-z0-9_-]*))\3\.(?=([A-Za-z0-9_-]{8}[A-Za-z0-9_-]*))\4\.[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*)\b/gd,
    group: 2
  },
  // A connection string's credentials, keeping the scheme and host so the
  // surrounding review comment still makes sense. A scheme cannot contain ':',
  // so it always ends where its run of scheme characters ends, and where in the
  // run it starts changes nothing that follows. Each run is therefore tried
  // once, from its start, and taken whole by a lookahead and backreference, as
  // JavaScript has no possessive quantifier. Trying every word boundary in the
  // run rescanned it each time, and pull request text could stall a review for
  // minutes. The run must still hold a scheme's start at a word boundary: a
  // letter first with no '_' before it, or a letter after '+', '.' or '-'.
  {
    label: "DB_CREDENTIALS",
    pattern: /(?<![a-z0-9+.-])(?=(?<!_)[a-z]|[a-z0-9+.-]*?[+.-][a-z])(?=([a-z0-9+.-]+))\1:\/\/([^\s:@/]+):([^\s@/]+)@/gid,
    group: 3
  },
  {
    label: "AUTHORIZATION_HEADER",
    pattern: /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12}[A-Za-z0-9._~+/=-]*)/gid,
    group: 1
  },
  // Assignment-shaped secrets. Deliberately after the specific rules: it is the
  // broadest one, and a more specific label above is more useful in an audit
  // than "SECRET".
  {
    label: "SECRET_ASSIGNMENT",
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']([^"'\s]{8}[^"'\s]*)["']/gid,
    group: 1
  },
  // A connection string with no user, as in `redis://:password@host`. It runs
  // last because its password reaches the first '@': run earlier, it took the
  // keyword or closing quote of an assignment, and the rest of that secret
  // stayed in clear text. Nothing runs after it, so it has no assignment to
  // protect and takes a scheme that follows '_' as well.
  {
    label: "DB_CREDENTIALS",
    pattern: /(?<![a-z0-9+.-])(?=[a-z]|[a-z0-9+.-]*?[+.-][a-z])(?=([a-z0-9+.-]+))\1:\/\/:([^\s@/]+)@/gid,
    group: 2
  }
];
var PLACEHOLDERS = /* @__PURE__ */ new Set([
  "xxxxxxxx",
  "changeme",
  "password",
  "redacted",
  "your_token_here",
  "example",
  "placeholder",
  "dummy",
  "notarealsecret",
  "test",
  "password123",
  "<token>",
  "secret",
  "todo",
  "fixme",
  "null",
  "undefined",
  "none"
]);

// src/redact/redact.ts
var REDACTION_VERSION = "2";
function hash(value) {
  return createHash2("sha256").update(value).digest("hex").slice(0, 32);
}
function isPlaceholder(value) {
  const normalised = value.toLowerCase().replace(/[<>{}[\]]/g, "");
  if (PLACEHOLDERS.has(normalised)) return true;
  return value.length >= 4 && value === value.charAt(0).repeat(value.length);
}
function redact(input) {
  const counts = {};
  let text = input;
  for (const { label, pattern, group = 0 } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let redacted = "";
    let copied = 0;
    for (const match of text.matchAll(pattern)) {
      const captured = match[group];
      if (captured === void 0 || captured.length === 0) continue;
      if (isPlaceholder(captured)) continue;
      const span = match.indices?.[group];
      if (span === void 0) throw new Error(`the ${label} pattern lacks the d flag`);
      counts[label] = (counts[label] ?? 0) + 1;
      redacted += `${text.slice(copied, span[0])}[REDACTED:${label}]`;
      copied = span[1];
    }
    text = redacted + text.slice(copied);
  }
  return {
    text,
    counts,
    sourceHash: hash(input),
    redactedHash: hash(text),
    version: REDACTION_VERSION
  };
}

// src/codefree.ts
function visibleText(text) {
  return text.normalize("NFKC").replace(new RegExp("\\p{Cf}", "gu"), "").replace(/[‘’ʼ′]/g, "'");
}
var VOCABULARY = new Set(
  [
    "JavaScript",
    "TypeScript",
    "CoffeeScript",
    "ActionScript",
    "GitHub",
    "GitLab",
    "BitBucket",
    "PostgreSQL",
    "MySQL",
    "SQLite",
    "MariaDB",
    "MongoDB",
    "DynamoDB",
    "CouchDB",
    "GraphQL",
    "OAuth",
    "OpenID",
    "OpenAPI",
    "WebSocket",
    "WebSockets",
    "WebAssembly",
    "WebKit",
    "WebRTC",
    "NodeJS",
    "iOS",
    "macOS",
    "iPadOS",
    "watchOS",
    "tvOS",
    "PowerShell",
    "DevOps",
    "NoSQL",
    "JSDoc",
    "TypeDoc",
    "PyPI",
    "PyTest",
    "NumPy",
    "SciPy",
    "FastAPI",
    "CircleCI",
    "TravisCI",
    "AppVeyor",
    "CloudFormation",
    "CloudFront",
    "CloudWatch",
    "ElasticSearch",
    "OpenSearch",
    "RabbitMQ",
    "ActiveMQ",
    "LocalStorage",
    "SessionStorage",
    "IndexedDB",
    "ReactDOM",
    "NextJS",
    "NuxtJS",
    "VueJS",
    "SvelteKit",
    "TailwindCSS",
    "PostCSS",
    "ESLint",
    "TSLint",
    "StyleLint",
    "YouTube",
    "LinkedIn",
    "JetBrains",
    "IntelliJ",
    "PhpStorm",
    "WebStorm",
    "PyCharm",
    "VSCode",
    "DataDog",
    "PagerDuty",
    "OpenTelemetry",
    "ClickHouse",
    "BigQuery",
    "CockroachDB",
    "TimescaleDB",
    "InfluxDB",
    "MacBook",
    "iPhone",
    "iPad",
    "eBay",
    "PayPal",
    "WordPress",
    "DigitalOcean",
    "CloudFlare",
    "TestFlight",
    "XCTest",
    "JUnit",
    "NUnit",
    "xUnit",
    "TestNG",
    "PHPUnit",
    "RSpec",
    "MiniTest",
    "GoogleTest",
    "PlayWright",
    "WebDriver",
    "ChromeDriver",
    "GeckoDriver",
    "DevTools",
    "VoiceOver",
    "TalkBack",
    "NVDA",
    "JAWS"
  ].map((w) => w.toLowerCase())
);
var DOTTED_VOCABULARY = /* @__PURE__ */ new Set(["node.js", "next.js", "nuxt.js", "vue.js", "express.js", "nest.js", "react.js", "ember.js", "d3.js", "three.js", "chart.js", "socket.io", "e.g", "i.e", "etc", "vs"]);
var FILE_EXTENSIONS = "ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|fs|php|scala|clj|ex|exs|erl|hs|lua|dart|r|m|mm|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|sql|sh|bash|zsh|ps1|bat|md|mdx|rst|txt|css|scss|sass|less|html?|vue|svelte|astro|xml|gradle|proto|graphql|gql|tf|hcl|dockerfile|csv|ipynb";
var CHECKS = [
  { reason: "code fence or inline code", test: (t) => /```|~~~|`[^`\n]+`/.test(t) },
  { reason: "path-like token", test: (t) => /(?:^|[\s("'])(?:\.{1,2}\/|~\/|\/[\w.-]+\/)/.test(t) || /\b[\w.-]+(?:\/[\w.*-]+){2,}/.test(t) || /\b[\w-]+\/[\w-]+\.\w{1,6}\b/.test(t) || /\*\*\/|\/\*\*/.test(t) || /\b[A-Za-z]:\\/.test(t) },
  { reason: "file name", test: (t) => new RegExp(String.raw`(?:^|[^\w.])[\w-]+\.(?:${FILE_EXTENSIONS})\b`, "i").test(t) && !onlyVocabularyDots(t) },
  // Prose uses "test (unit)" and "test(s)"; code uses "run()" and "fn(a, b)".
  { reason: "call or member syntax", test: (t) => /\b[A-Za-z_$][\w$]*\((?:\s*|[\w$]+(?:,\s*[\w$]+)+)\)/.test(t) || /::|=>|\$\{/.test(t) },
  { reason: "dotted identifier", test: (t) => hasDottedIdentifier(t) },
  { reason: "camelCase or PascalCase identifier", test: (t) => hasCasedIdentifier(t) },
  { reason: "snake_case or SCREAMING_CASE identifier", test: (t) => /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/.test(t) },
  { reason: "hash or long hex value", test: (t) => /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/i.test(t) }
];
function onlyVocabularyDots(text) {
  const re = new RegExp(String.raw`(?:^|[^\w.])([\w-]+\.(?:${FILE_EXTENSIONS}))\b`, "gi");
  for (const m of text.matchAll(re)) {
    if (!DOTTED_VOCABULARY.has(m[1].toLowerCase())) return false;
  }
  return true;
}
function hasDottedIdentifier(text) {
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b/g)) {
    const token = m[1];
    if (DOTTED_VOCABULARY.has(token.toLowerCase())) continue;
    const parts = token.split(".");
    if (parts.every((p) => p.length <= 1)) continue;
    if (parts.length === 2 && /^[A-Z]/.test(parts[1]) && /^[a-z]+$/.test(parts[0]) && parts[0].length > 3) continue;
    return true;
  }
  return false;
}
function hasCasedIdentifier(text) {
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*\b/g)) {
    const w = m[0];
    if (VOCABULARY.has(w.toLowerCase())) continue;
    if (/^[a-z]+[A-Z]/.test(w)) return true;
    if (/^[A-Z][a-z0-9]+[A-Z]/.test(w)) return true;
  }
  return false;
}
function codeFreeViolations(text, repoTerms = []) {
  const visible2 = visibleText(text);
  const reasons = [];
  for (const check of CHECKS) if (check.test(visible2)) reasons.push(check.reason);
  if (mentionsRepoTerm(visible2, repoTerms)) reasons.push("repository identifier");
  return reasons;
}
function mentionsRepoTerm(text, repoTerms) {
  const lower = visibleText(text).toLowerCase();
  for (const term of repoTerms) {
    const t = term.trim().toLowerCase();
    if (t.length < 3) continue;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^\\w])${escaped}(?:[^\\w]|$)`).test(lower)) return true;
  }
  return false;
}

// src/gate.ts
var MAX_STATEMENT = 300;
function refusal(text, organisationTerms2) {
  if (text.trim().length === 0) return "it is empty";
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return "it has a line break or a control character; one item is one line";
  if (text.length > MAX_STATEMENT) return `it is ${text.length} characters; at most ${MAX_STATEMENT}`;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return "it carries a private key";
  const labels = Object.keys(redact(text).counts);
  if (labels.length > 0) return `it carries a secret (${labels.sort().join(", ")})`;
  if (/hooks\.slack\.com\/(?:services|workflows|triggers)\/|discord(?:app)?\.com\/api\/webhooks\//i.test(text)) {
    return "it carries a webhook URL, which is a credential";
  }
  if (/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9])/.test(text)) return "it carries an email address";
  if (/(?<![\w@/.])@[A-Za-z0-9][A-Za-z0-9-]*(?![\w-]*(?:\/|\(|\.\w))/.test(text)) {
    return "it carries a person's handle";
  }
  if (organisationTerms2 !== void 0) {
    const reasons = codeFreeViolations(text);
    const visible2 = visibleText(text);
    const named = organisationTerms2.some(
      (t) => t.length >= 2 && new RegExp(`(?<![\\p{L}\\p{N}_])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "iu").test(visible2)
    );
    if (named) reasons.push("an organisation or repository name");
    if (reasons.length > 0) return `a person or global item must be organisation-free, and this has: ${reasons.join(", ")}`;
  }
  return null;
}

// src/items.ts
import { createHash as createHash3, randomBytes } from "node:crypto";
var SCOPES = ["repository", "organisation", "person", "global"];
var TYPES = ["preference", "convention", "decision", "hazard", "precedent", "failure-pattern", "repair-recipe"];
var sha256 = (text) => createHash3("sha256").update(text).digest("hex");
function insertItem(db, item) {
  const id = `m-${randomBytes(5).toString("hex")}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO items (id, tenant, scope, scope_key, type, statement, rationale, status, authority, origin_trust,
         anchors_json, valid_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'advisory', 'owner', ?, ?, ?)`
    ).run(id, item.tenant, item.scope, item.scopeKey, item.type, item.statement, item.rationale, JSON.stringify(item.anchors), now, now);
    db.prepare(
      `INSERT INTO evidence (id, item_id, source_ref, author_role, quote_hash, captured_at, extractor)
       VALUES (?, ?, ?, 'owner', ?, ?, 'deterministic')`
    ).run(`e-${randomBytes(5).toString("hex")}`, id, item.source, sha256(item.statement), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return id;
}
var SELECT = `SELECT id, scope, type, statement, support, anchors_json,
  (SELECT source_ref FROM evidence e WHERE e.item_id = items.id ORDER BY captured_at, id LIMIT 1) AS source
  FROM items WHERE status = 'active' AND valid_to IS NULL`;
var visible = (rows) => rows.map((r) => ({
  id: r.id,
  scope: r.scope,
  type: r.type,
  statement: r.statement,
  support: r.support,
  anchors: JSON.parse(r.anchors_json),
  source: r.source ?? ""
}));
function tenantItems(db, tenant, repository, owner) {
  return visible(
    db.prepare(
      `${SELECT} AND tenant = ? AND ((scope = 'repository' AND scope_key = ?) OR (scope = 'organisation' AND scope_key = ?))`
    ).all(tenant, repository, owner)
  );
}
function personItems(db) {
  return visible(db.prepare(`${SELECT} AND scope IN ('person', 'global')`).all());
}

// src/slice.ts
var SCOPE_POINTS = { repository: 2, organisation: 1, person: 1, global: 0.5 };
var HEADER = "Memory (advisory; facts recorded earlier, with their source):\n";
var estimate = (text) => Math.ceil(text.length / 4);
function rank(items) {
  return [...items].sort(
    (a, b) => (SCOPE_POINTS[b.scope] ?? 0) - (SCOPE_POINTS[a.scope] ?? 0) || b.support - a.support || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
var oneLine = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
function row(item) {
  const anchors = item.anchors.map((a) => a.start === void 0 ? a.path : `${a.path}:${a.start}-${a.end ?? a.start}`).join(", ");
  const source = item.source !== "" && item.source !== "remember" ? ` ${item.source}` : "";
  return oneLine(`- [${item.id}] ${item.type}: ${item.statement}${anchors ? ` (${anchors})` : ""}${source}`) + "\n";
}
function compose(rows, more) {
  return HEADER + rows.join("") + (more > 0 ? `+${more} more: memory list
` : "");
}
function renderSlice(items, budget) {
  if (budget <= 0 || items.length === 0) return "";
  const rows = rank(items).map(row);
  const chosen = [];
  for (const r of rows) {
    const candidate = [...chosen, r];
    if (estimate(compose(candidate, rows.length - candidate.length)) <= budget) chosen.push(r);
  }
  return chosen.length === 0 ? "" : compose(chosen, rows.length - chosen.length);
}
function renderAll(items) {
  return items.length === 0 ? "" : compose(rank(items).map(row), 0);
}

// src/store/audit.ts
import { randomUUID } from "node:crypto";
function recordAudit(db, action, subject, metadata = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_events (audit_id, action, subject_type, subject_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, action, subject?.type ?? null, subject?.id ?? null, JSON.stringify(metadata), (/* @__PURE__ */ new Date()).toISOString());
  return id;
}

// src/anchors.ts
var WINDOW = 50;
function fileLines(text) {
  const lines = text === "" ? [] : text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}
var rangeHash = (lines, start, end) => sha256(lines.slice(start - 1, end).join("\n"));
function checkAnchor(anchor, text, window = WINDOW) {
  if (text === null) return { ok: false, reason: "path gone" };
  if (anchor.start === void 0) {
    return sha256(text) === anchor.citedHash ? { ok: true, anchor } : { ok: false, reason: "cited text gone" };
  }
  const lines = fileLines(text);
  const length = (anchor.end ?? anchor.start) - anchor.start + 1;
  for (let d = 0; d <= window && (anchor.start - d >= 1 || anchor.start + d + length - 1 <= lines.length); d++) {
    for (const start of d === 0 ? [anchor.start] : [anchor.start - d, anchor.start + d]) {
      if (start < 1 || start + length - 1 > lines.length) continue;
      if (rangeHash(lines, start, start + length - 1) === anchor.citedHash) {
        return { ok: true, anchor: { ...anchor, start, end: start + length - 1 } };
      }
    }
  }
  return { ok: false, reason: "cited text gone" };
}
var at = (a) => a.start === void 0 ? a.path : `${a.path}:${a.start}-${a.end ?? a.start}`;
function transition(db, apply, audit) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const changed = apply();
    if (changed) audit();
    db.exec("COMMIT");
    return changed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function recheck(db, tenant, repository, cwd, { id, window = WINDOW } = {}) {
  const result = { checked: 0, current: 0, stale: 0, restored: 0, staleItems: [] };
  const rows = db.prepare(
    `SELECT id, status, anchors_json FROM items
       WHERE tenant = ? AND scope = 'repository' AND scope_key = ? AND anchors_json != '[]'
         AND status IN ('active', 'stale') ${id === void 0 ? "" : "AND id = ?"}
       ORDER BY id`
  ).all(tenant, repository, ...id === void 0 ? [] : [id]);
  if (rows.length === 0 || git(cwd, "rev-parse", "--verify", "-q", "HEAD") === null) return result;
  const files = /* @__PURE__ */ new Map();
  const read = (path) => {
    if (!files.has(path)) {
      let text;
      try {
        text = git(cwd, "cat-file", "blob", `HEAD:${path}`);
      } catch {
        text = void 0;
      }
      files.set(path, text);
    }
    return files.get(path);
  };
  const toStale = db.prepare("UPDATE items SET status = 'stale', status_reason = ? WHERE id = ? AND status = 'active'");
  const toActive = db.prepare("UPDATE items SET status = 'active', status_reason = NULL WHERE id = ? AND status = 'stale'");
  for (const row2 of rows) {
    const anchors = JSON.parse(row2.anchors_json);
    const texts = anchors.map((a) => read(a.path));
    if (texts.includes(void 0)) continue;
    result.checked++;
    const checks = anchors.map((a, i) => checkAnchor(a, texts[i], window));
    const failed = checks.find((c) => !c.ok);
    if (failed !== void 0 && !failed.ok) {
      result.stale++;
      result.staleItems.push({ id: row2.id, reason: failed.reason });
      transition(
        db,
        () => toStale.run(failed.reason, row2.id).changes === 1,
        () => recordAudit(db, "item_stale", { type: "item", id: row2.id }, { reason: failed.reason })
      );
      continue;
    }
    result.current++;
    const now = checks.map((c) => c.ok ? c.anchor : anchors[0]);
    const moved = JSON.stringify(now);
    if (moved !== row2.anchors_json) {
      transition(
        db,
        () => db.prepare("UPDATE items SET anchors_json = ? WHERE id = ?").run(moved, row2.id).changes === 1,
        () => recordAudit(db, "anchor_moved", { type: "item", id: row2.id }, { from: anchors.map(at), to: now.map(at) })
      );
    }
    const restored = transition(
      db,
      () => toActive.run(row2.id).changes === 1,
      () => recordAudit(db, "item_restored", { type: "item", id: row2.id })
    );
    if (restored) result.restored++;
  }
  return result;
}

// src/consent/plan.ts
function buildConsentPlan(config, storageLocation) {
  return {
    tenants: config.tenants,
    configs: config.configs,
    dataCategories: [
      "Statements you ask memory to remember, each with its scope, type and an optional source reference",
      "For an anchored statement: the file path, line range, commit and a hash of the cited lines, not the lines themselves",
      "The working directory's git origin remote, read at session start to find its tenant"
    ],
    optIns: { ...config.optIns },
    storageLocation,
    retention: [
      "Statements matching a known credential pattern, or carrying an email address, a handle or a webhook URL, are refused and never stored",
      "Person and global statements are refused unless they name no code, path, tenant or repository",
      "Items are kept until you purge them with memory purge --tenant, --repo or --all",
      "memory purge --older-than N deletes evidence older than N days; an item left without evidence stays on disk as proposed and is no longer shown",
      "Each tenant has its own file; a session opens only the tenant its repository and config allow",
      "Nothing is uploaded; the store never leaves this machine"
    ]
  };
}

// src/consent/purge.ts
var count = (db, sql, ...params) => db.prepare(sql).get(...params).n;
function itemClause(scope) {
  if (scope.all === true || scope.tenant !== void 0) return { where: "1=1", params: [] };
  if (scope.repository !== void 0) return { where: "scope = 'repository' AND scope_key = ?", params: [scope.repository] };
  return { where: "1=0", params: [] };
}
function previewPurge(db, scope) {
  const { where, params } = itemClause(scope);
  const items = count(db, `SELECT COUNT(*) AS n FROM items WHERE ${where}`, ...params);
  let evidence = count(db, `SELECT COUNT(*) AS n FROM evidence WHERE item_id IN (SELECT id FROM items WHERE ${where})`, ...params);
  let returnedToProposed = 0;
  const before = scope.before;
  if (before !== void 0) {
    evidence = count(db, "SELECT COUNT(*) AS n FROM evidence WHERE captured_at < ?", before);
    returnedToProposed = count(
      db,
      `SELECT COUNT(*) AS n FROM items i WHERE status != 'proposed'
         AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = i.id AND e.captured_at >= ?)`,
      before
    );
  }
  return { items, evidence, returnedToProposed };
}
function executePurge(db, scope) {
  const preview = previewPurge(db, scope);
  const { where, params } = itemClause(scope);
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM items WHERE ${where}`).run(...params);
    if (scope.before !== void 0) {
      db.prepare("DELETE FROM evidence WHERE captured_at < ?").run(scope.before);
      db.prepare(
        "UPDATE items SET status = 'proposed' WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.item_id = items.id)"
      ).run();
    }
    recordAudit(db, "purge", null, { scope, removed: preview });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return preview;
}

// src/store/db.ts
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync as existsSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
var MIGRATIONS = [
  `
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('repository', 'organisation', 'person', 'global')),
    scope_key TEXT NOT NULL,
    type TEXT NOT NULL,
    statement TEXT NOT NULL,
    rationale TEXT,
    status TEXT NOT NULL,
    authority TEXT NOT NULL DEFAULT 'advisory',
    origin_trust TEXT NOT NULL,
    anchors_json TEXT NOT NULL DEFAULT '[]',
    support INTEGER NOT NULL DEFAULT 1,
    contradictions INTEGER NOT NULL DEFAULT 0,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    expires_at TEXT,
    supersedes TEXT,
    promoted_to TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_items_visible ON items (status, scope, scope_key);

  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    source_ref TEXT NOT NULL,
    author_role TEXT NOT NULL,
    quote_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    extractor TEXT NOT NULL
  );
  CREATE INDEX idx_evidence_item ON evidence (item_id);

  CREATE TABLE audit_events (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    subject_type TEXT,
    subject_id TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v2 - why an item went stale (slice 2), so the owner can see it before a recheck.
  `ALTER TABLE items ADD COLUMN status_reason TEXT;`
];
function openStore(path, create) {
  if (!existsSync2(path)) {
    if (!create) return null;
    mkdirSync2(dirname2(path), { recursive: true, mode: 448 });
  }
  const db = new DatabaseSync(path);
  chmodSync(path, 384);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  const version = () => db.prepare("PRAGMA user_version").get().user_version;
  if (version() < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let v = version(); v < MIGRATIONS.length; v++) {
        db.exec(MIGRATIONS[v]);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

// src/store/paths.ts
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
function dataDirectory(env = process.env) {
  const override = env["MEMORY_DATA_DIR"];
  if (override !== void 0 && override.length > 0) return override;
  const home = homedir2();
  switch (process.platform) {
    case "darwin":
      return join3(home, "Library", "Application Support", "claude-code-memory");
    case "win32": {
      const appData = env["APPDATA"];
      return appData !== void 0 && appData.length > 0 ? join3(appData, "claude-code-memory") : join3(home, "AppData", "Roaming", "claude-code-memory");
    }
    default: {
      const xdg = env["XDG_DATA_HOME"];
      return xdg !== void 0 && xdg.length > 0 ? join3(xdg, "claude-code-memory") : join3(home, ".local", "share", "claude-code-memory");
    }
  }
}
var tenantFile = (data, tenant) => join3(data, "tenants", `${tenant}.sqlite`);
var personFile = (data) => join3(data, "person.sqlite");

// src/cli.ts
suppressSqliteExperimentalWarning();
var USAGE = `usage: memory <command>

  init [--tenant <name>=<owner/*|owner/repo>[,...]]... [--bind <tenant>[,...]] [--confirm]
      show the consent plan; with --confirm, save it. --bind binds this Claude Code config.
  remember [--scope repository|organisation|person|global] [--type <type>]
           [--anchor <path>[:<start>[-<end>]]] [--rationale <text>] [--source <ref>] -- <statement>
      remember one statement, active at once
  list
      every item visible here
  recheck [<id>]
      check anchored items against HEAD, searching the whole file: a gone citation makes an item stale,
      one that holds again restores it
  session-start
      the SessionStart hook: the slice for this repository and config, within budget
  purge (--tenant <name> | --repo <owner/repo> | --older-than <days> | --all) [--confirm]
      preview, or with --confirm delete
  --version`;
var Refusal = class extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
  code;
};
var NOT_SET_UP = "memory is not set up, or its configuration changed since you agreed to it; run memory init and confirm the plan";
function setUp(data) {
  const config = loadConfig(data);
  if (!consented(config)) throw new Refusal(NOT_SET_UP);
  return config;
}
function organisationTerms(config, context) {
  const terms = new Set(Object.keys(config.tenants));
  for (const patterns of Object.values(config.tenants)) {
    for (const p of patterns) for (const part of p.split("/")) if (part !== "*") terms.add(part);
  }
  if (context.repository !== null) for (const part of context.repository.split("/")) terms.add(part);
  return [...terms];
}
function visibleItems(data, context, cwd) {
  const out = [];
  if (context.tenant !== null && context.repository !== null && context.owner !== null) {
    const db = openStore(tenantFile(data, context.tenant), false);
    if (db !== null) {
      try {
        recheck(db, context.tenant, context.repository, cwd);
        out.push(...tenantItems(db, context.tenant, context.repository, context.owner));
      } finally {
        db.close();
      }
    }
  }
  const person = openStore(personFile(data), false);
  if (person !== null) {
    out.push(...personItems(person));
    person.close();
  }
  return out;
}
function init(args, data) {
  const { values } = parseArgs({
    args,
    options: { tenant: { type: "string", multiple: true }, bind: { type: "string" }, confirm: { type: "boolean" } }
  });
  const config = loadConfig(data) ?? emptyConfig();
  for (const spec of values.tenant ?? []) {
    const [name = "", patterns = ""] = spec.split("=", 2);
    if (!TENANT_NAME.test(name) || name === "person") {
      throw new Refusal(`tenant name "${name}" must be lower-case letters, digits and dashes, and not "person"`, 2);
    }
    const list2 = patterns.split(",").map((p) => p.trim());
    const bad = list2.find((p) => !TENANT_PATTERN.test(p));
    if (bad !== void 0) throw new Refusal(`"${bad}" is not an owner/* or owner/repo pattern`, 2);
    config.tenants[name] = list2;
  }
  if (values.bind !== void 0) {
    const tenants = values.bind.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    const unknown = tenants.find((t) => !(t in config.tenants));
    if (unknown !== void 0) throw new Refusal(`no tenant named "${unknown}"; add it with --tenant first`, 2);
    config.configs[currentConfigDir()] = tenants;
  }
  const plan = buildConsentPlan(config, data);
  console.log(JSON.stringify(plan, null, 2));
  if (values.confirm !== true) {
    console.error("Nothing was saved. Run the same command with --confirm to agree to this plan.");
    return;
  }
  config.consent = { planHash: planHash(config), grantedAt: (/* @__PURE__ */ new Date()).toISOString() };
  saveConfig(data, config);
  const db = openStore(personFile(data), true);
  recordAudit(db, "consent_granted", null, { planHash: config.consent.planHash });
  db.close();
  console.error("Consent recorded. Memory is on for the tenants this config is bound to.");
}
function anchorAt(cwd, spec) {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(spec);
  const path = m?.[1] ?? "";
  const clean = normalize(path);
  if (!m || isAbsolute(path) || clean.startsWith("..") || clean.split(/[\\/]/).includes("..")) {
    throw new Refusal("an anchor is a path inside the repository, as path or path:start-end");
  }
  const top = git(cwd, "rev-parse", "--show-toplevel")?.trim();
  const commit = top === void 0 ? void 0 : git(top, "rev-parse", "HEAD")?.trim();
  const text = top === void 0 ? null : git(top, "cat-file", "blob", `HEAD:${clean}`);
  if (top === void 0 || commit === void 0 || text === null) throw new Refusal(`${clean} is not in this repository at HEAD`);
  if (m[2] === void 0) return { path: clean, commit, citedHash: sha256(text) };
  const start = Number(m[2]);
  const end = m[3] === void 0 ? start : Number(m[3]);
  const lines = fileLines(text);
  if (start < 1 || end < start || end > lines.length) throw new Refusal(`${clean} has ${lines.length} lines; ${start}-${end} is outside it`);
  return { path: clean, start, end, commit, citedHash: rangeHash(lines, start, end) };
}
function remember(args, data, cwd) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      scope: { type: "string", default: "repository" },
      type: { type: "string", default: "preference" },
      anchor: { type: "string" },
      rationale: { type: "string" },
      source: { type: "string" }
    }
  });
  const scope = values.scope;
  if (!SCOPES.includes(scope)) throw new Refusal(`--scope is one of ${SCOPES.join(", ")}`, 2);
  if (!TYPES.includes(values.type)) throw new Refusal(`--type is one of ${TYPES.join(", ")}`, 2);
  if (positionals.length !== 1) throw new Refusal("give exactly one statement, after --", 2);
  const statement = positionals[0].trim();
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  const personal = scope === "person" || scope === "global";
  if (!personal && context.tenant === null) {
    throw new Refusal(`a ${scope} item needs a tenant, and ${context.reason}; only person and global items can be remembered here`);
  }
  if (values.anchor !== void 0 && scope !== "repository") throw new Refusal("only a repository item can have an anchor");
  const terms = personal ? organisationTerms(config, context) : void 0;
  for (const [what, text] of [
    ["the statement", statement],
    ["the rationale", values.rationale],
    ["the source", values.source],
    ["the anchor", values.anchor]
  ]) {
    if (text === void 0) continue;
    const why = refusal(text, terms);
    if (why !== null) throw new Refusal(`not remembered: ${what} is refused because ${why}`);
  }
  const anchors = values.anchor === void 0 ? [] : [anchorAt(cwd, values.anchor)];
  const tenant = personal ? "" : context.tenant;
  const scopeKey = scope === "repository" ? context.repository : scope === "organisation" ? context.owner : "";
  const db = openStore(personal ? personFile(data) : tenantFile(data, tenant), true);
  try {
    const id = insertItem(db, {
      tenant,
      scope,
      scopeKey,
      type: values.type,
      statement,
      rationale: values.rationale?.trim() ?? null,
      anchors,
      source: values.source?.trim() || "remember"
    });
    recordAudit(db, "item_remembered", { type: "item", id }, { scope });
    console.log(`remembered ${id} (${scope}${scopeKey ? ` ${scopeKey}` : ""}${tenant ? `, tenant ${tenant}` : ""})`);
  } finally {
    db.close();
  }
}
function list(data, cwd) {
  const config = setUp(data);
  process.stdout.write(renderAll(visibleItems(data, resolveContext(cwd, config, currentConfigDir()), cwd)));
}
function recheckCommand(args, data, cwd) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 1) throw new Refusal("give at most one item id", 2);
  const id = positionals[0];
  const config = setUp(data);
  const context = resolveContext(cwd, config, currentConfigDir());
  if (context.tenant === null || context.repository === null) throw new Refusal(`recheck needs a tenant, and ${context.reason}`);
  const db = openStore(tenantFile(data, context.tenant), false);
  if (db === null) throw new Refusal(`no anchored item to check in ${context.repository}`);
  try {
    const result = recheck(db, context.tenant, context.repository, cwd, { id, window: Infinity });
    if (id !== void 0 && result.checked === 0) throw new Refusal(`no anchored item ${id} in ${context.repository}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}
function sessionStart(data) {
  try {
    let cwd = process.cwd();
    try {
      const input = JSON.parse(readFileSync3(0, "utf8"));
      if (typeof input.cwd === "string" && input.cwd.length > 0) cwd = input.cwd;
    } catch {
    }
    const config = loadConfig(data);
    if (!consented(config)) return;
    const items = visibleItems(data, resolveContext(cwd, config, currentConfigDir()), cwd);
    process.stdout.write(renderSlice(items, config.sessionBudget ?? DEFAULT_SESSION_BUDGET));
  } catch {
  }
}
function purge(args, data) {
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: "string" },
      repo: { type: "string" },
      "older-than": { type: "string" },
      all: { type: "boolean" },
      confirm: { type: "boolean" }
    }
  });
  const chosen = [values.tenant, values.repo, values["older-than"], values.all].filter((v) => v !== void 0);
  if (chosen.length !== 1) throw new Refusal("give exactly one of --tenant, --repo, --older-than or --all", 2);
  const days = values["older-than"];
  if (days !== void 0 && !/^\d+$/.test(days)) throw new Refusal("--older-than takes a whole number of days", 2);
  if (values.tenant !== void 0 && !TENANT_NAME.test(values.tenant)) throw new Refusal(`no tenant named "${values.tenant}"`, 2);
  const repository = values.repo?.toLowerCase();
  if (repository !== void 0 && !/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/.test(repository)) {
    throw new Refusal("--repo takes owner/repo", 2);
  }
  const scope = {
    tenant: values.tenant,
    repository,
    before: days === void 0 ? void 0 : new Date(Date.now() - Number(days) * 864e5).toISOString(),
    all: values.all
  };
  const tenantsDir = join4(data, "tenants");
  const tenants = values.tenant !== void 0 ? [values.tenant] : existsSync3(tenantsDir) ? readdirSync(tenantsDir).filter((f) => f.endsWith(".sqlite")).map((f) => f.slice(0, -".sqlite".length)) : [];
  const files = tenants.filter((t) => TENANT_NAME.test(t)).map((t) => tenantFile(data, t));
  if (values.all === true || days !== void 0) files.push(personFile(data));
  const report = {};
  const total = { items: 0, evidence: 0, returnedToProposed: 0 };
  for (const file of files) {
    const db = openStore(file, false);
    if (db === null) continue;
    try {
      const r = values.confirm === true ? executePurge(db, scope) : previewPurge(db, scope);
      report[file.slice(data.length + 1)] = r;
      total.items += r.items;
      total.evidence += r.evidence;
      total.returnedToProposed += r.returnedToProposed;
    } finally {
      db.close();
    }
  }
  console.log(JSON.stringify({ ...total, files: report }, null, 2));
  if (values.confirm !== true) console.error("Nothing was deleted. Run the same command with --confirm to delete.");
}
function main(argv) {
  const [command, ...rest] = argv;
  const data = dataDirectory();
  switch (command) {
    case "--version":
      console.log(pluginVersion());
      return;
    case "init":
      return init(rest, data);
    case "remember":
      return remember(rest, data, process.cwd());
    case "list":
      return list(data, process.cwd());
    case "recheck":
      return recheckCommand(rest, data, process.cwd());
    case "session-start":
      return sessionStart(data);
    case "purge":
      return purge(rest, data);
    case void 0:
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    default:
      throw new Refusal(`unknown command ${command}

${USAGE}`, 2);
  }
}
try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Refusal) {
    console.error(error.message);
    process.exitCode = error.code;
  } else if (error instanceof ConfigError || String(error.code).startsWith("ERR_PARSE_ARGS")) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
