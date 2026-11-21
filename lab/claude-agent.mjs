#!/usr/bin/env node
/**
 * The session lab's agent for real Claude Code, on the owner's machine only: it needs a Claude Code login, calls a
 * model and spends money, so CI never runs it.
 *
 *   memory eval lab --model <name> --agent 'node <plugin>/lab/claude-agent.mjs'
 *
 * One headless session on $MEMORY_LAB_MODEL, the prompt on stdin, the memory plugin loaded only on the on arm. No
 * settings file is read, so the owner's own hooks and plugins stay out of both arms. The stream goes to stdout; the
 * session transcript Claude Code keeps, with its subagents' transcripts, is copied to $MEMORY_LAB_OUT/session.jsonl
 * for the hooks' durations.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { MEMORY_LAB_MODEL: model, MEMORY_LAB_PLUGIN: plugin, MEMORY_LAB_OUT: out, CLAUDE_CONFIG_DIR } = process.env;
const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--setting-sources', '', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash'];
if (plugin) args.push('--plugin-dir', plugin);
const r = spawnSync('claude', args, { input: readFileSync(0), stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
process.stdout.write(r.stdout ?? '');

const session = (r.stdout ?? '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((e) => typeof e.session_id === 'string')?.session_id;
const projects = join(CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
for (const project of session && existsSync(projects) ? readdirSync(projects) : []) {
  const main = join(projects, project, `${session}.jsonl`);
  if (!existsSync(main)) continue;
  const subagents = join(projects, project, session, 'subagents');
  for (const file of [main, ...(existsSync(subagents) ? readdirSync(subagents).map((f) => join(subagents, f)) : [])]) {
    appendFileSync(join(out, 'session.jsonl'), readFileSync(file));
  }
}
process.exit(r.status ?? 1);
