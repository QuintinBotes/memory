import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// Requests no test asked to see land here; the helper that started the bundle fails the test when any did.
const netDefault = join(tmpdir(), `memory-netlog-${process.pid}.log`);
writeFileSync(netDefault, '');

/** Fails a test that made the bundle reach a host outside this machine, unless `net` says the test is about exactly that. */
function assertNoNetwork({ net, netLog }) {
  if (net === true || netLog !== undefined) return;
  const reached = readFileSync(netDefault, 'utf8');
  writeFileSync(netDefault, '');
  if (reached !== '') throw new Error(`a test reached the network: ${reached}`);
}

/**
 * Runs the bundle with a clean environment: only what the test names reaches it. `fetch` is replaced in the child
 * (test/no-network.mjs): a call to a host but this machine is refused, and fails the test unless `net` says the test
 * is about exactly that attempt, when `netLog` names the file that receives each request's URL and body.
 */
export function childEnv({ data, config, path, env: extra, netLog }) {
  const env = { PATH: path ?? process.env.PATH, HOME: process.env.HOME, ...gitEnv, MEMORY_TEST_HARNESS: '1', ...extra };
  env.NODE_OPTIONS = `--import ${pathToFileURL(join(root, 'test', 'no-network.mjs')).href}`;
  // WORK_LOG names the file that receives this run's SQLite work (test/work-count.mjs).
  if (env.WORK_LOG || env.LOCK_WAIT_LOG || env.FILE_LOCK_LOG || env.OPEN_LOG) env.NODE_OPTIONS += ` --import ${pathToFileURL(join(root, 'test', 'work-count.mjs')).href}`;
  env.NO_NET_LOG = netLog ?? netDefault;
  if (data) env.MEMORY_DATA_DIR = data;
  if (config) env.CLAUDE_CONFIG_DIR = config;
  return env;
}

export function run(args, { cwd, data, config, input, path, env: extra, net, netLog } = {}) {
  const env = childEnv({ data, config, path, env: extra, netLog });
  const r = spawnSync(process.execPath, [bundle, ...args], { cwd, env, input, encoding: 'utf8' });
  assertNoNetwork({ net, netLog });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Like run, but does not wait: resolves with the same shape when the child exits, so runs can overlap. */
export function runAsync(args, { cwd, data, config, input, path, env: extra, net, netLog } = {}) {
  const child = spawn(process.execPath, [bundle, ...args], { cwd, env: childEnv({ data, config, path, env: extra, netLog }) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(input ?? '');
  return new Promise((ok, fail) => child.on('close', (status) => {
    try {
      assertNoNetwork({ net, netLog });
    } catch (error) {
      return fail(error);
    }
    ok({ status, stdout, stderr });
  }));
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

/** Waits until `done()` is true. The limit only ends a hung run: a slow machine just takes longer. */
export async function until(done, limitMs = 120_000) {
  for (const end = Date.now() + limitMs; !done() && Date.now() < end;) await new Promise((ok) => setTimeout(ok, 20));
}
