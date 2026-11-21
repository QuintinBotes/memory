import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const bundle = join(root, 'dist/memory.mjs');

/** Estimated tokens, as the spec defines them: characters divided by four, rounded up. */
export const tokens = (text) => Math.ceil(text.length / 4);

/** Credential-shaped strings are assembled at runtime so no literal exists in this file. */
export const assemble = (...parts) => parts.join('');

export function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'memory-test-'));
  const data = join(base, 'data');
  const configA = join(base, 'config-a');
  const configB = join(base, 'config-b');
  mkdirSync(configA);
  mkdirSync(configB);
  return { base, data, configA, configB };
}

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** A git repository with one commit, and `origin` set to `remote` when given. */
export function repo(base, name, remote) {
  const dir = join(base, 'repos', name.replace('/', '-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  writeFileSync(join(dir, 'src', 'ledger.ts'), 'export function consume() {\n  return 1;\n}\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, ...gitEnv }, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  if (remote) git('remote', 'add', 'origin', remote);
  return dir;
}

/** Writes (or, for null, deletes) files in `dir` and commits them. */
export function commit(dir, files, message = 'change') {
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, ...gitEnv }, stdio: 'pipe' });
  for (const [path, text] of Object.entries(files)) {
    if (text === null) git('rm', '-q', path);
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      git('add', path);
    }
  }
  git('commit', '-q', '-m', message);
}

/** Runs the bundle with a clean environment: only what the test names reaches it. */
export function run(args, { cwd, data, config, input } = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...gitEnv };
  if (data) env.MEMORY_DATA_DIR = data;
  if (config) env.CLAUDE_CONFIG_DIR = config;
  const r = spawnSync(process.execPath, [bundle, ...args], { cwd, env, input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The SessionStart hook as Claude Code calls it. */
export function sessionStart(cwd, data, config) {
  const input = JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd });
  return run(['session-start'], { cwd, data, config, input });
}

export function remember(cwd, data, config, statement, ...flags) {
  return run(['remember', ...flags, '--', statement], { cwd, data, config });
}

/** Every byte memory wrote, to prove a value is absent from disk. */
export function storeBytes(data) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p));
    }
  };
  walk(data);
  return Buffer.concat(out);
}

/** Two tenants, config A bound to both, config B bound to beta only. */
export function setup() {
  const s = sandbox();
  const r1 = run(['init', '--tenant', 'acme=acme/*', '--tenant', 'beta=beta/*', '--bind', 'acme,beta', '--confirm'], {
    cwd: s.base, data: s.data, config: s.configA,
  });
  if (r1.status !== 0) throw new Error(`init A failed: ${r1.stderr}`);
  const r2 = run(['init', '--bind', 'beta', '--confirm'], { cwd: s.base, data: s.data, config: s.configB });
  if (r2.status !== 0) throw new Error(`init B failed: ${r2.stderr}`);
  return {
    ...s,
    acmeApi: repo(s.base, 'acme/api', 'https://github.com/acme/api.git'),
    // An SSH remote; assembled so the identity guard does not read it as an email.
    acmeWeb: repo(s.base, 'acme/web', assemble('git', '@github.com:acme/web.git')),
    betaWeb: repo(s.base, 'beta/web', 'https://github.com/beta/web'),
    loose: repo(s.base, 'loose/tool', 'https://github.com/loose/tool.git'),
    noRemote: repo(s.base, 'local/none'),
  };
}

/** Runs the MCP server over stdio with these JSON-RPC messages, after the handshake; returns each response by id. */
export function rpc(cwd, data, config, messages) {
  const all = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...messages,
  ];
  const r = run(['mcp'], { cwd, data, config, input: all.map((m) => JSON.stringify(m)).join('\n') + '\n' });
  const responses = r.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  return { ...r, responses, byId: (id) => responses.find((x) => x.id === id) };
}

/** Calls tools in order; each result is `{ text, isError }`. */
export function tools(cwd, data, config, calls) {
  const r = rpc(cwd, data, config, calls.map(([name, args], i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } })));
  return calls.map((_, i) => {
    const res = r.byId(i + 1);
    if (res === undefined) throw new Error(`no response to call ${i + 1}: ${r.stderr}`);
    if (res.error) return { text: res.error.message, isError: true, rpcError: res.error };
    return { text: res.result.content.map((c) => c.text).join(''), isError: res.result.isError === true };
  });
}

/** The lines strictly inside the one advisory fence of `text`, or a failure if the fence is not intact. */
export function fenced(text) {
  const lines = text.split('\n');
  const marks = lines.map((l, i) => (/^\s{0,3}(?:~{3,}|`{3,})/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (marks.length !== 2) throw new Error(`expected one fence, found ${marks.length} fence lines in:\n${text}`);
  return lines.slice(marks[0] + 1, marks[1]);
}
