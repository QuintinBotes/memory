#!/usr/bin/env node
/**
 * The session lab's stand-in for Claude Code: it calls no model. It replays one transcript, chosen by the task and
 * arm the lab names, in the working directory the lab gives it:
 *
 *   node lab/replay-agent.mjs <transcripts-dir>     replays <transcripts-dir>/$MEMORY_LAB_TASK/$MEMORY_LAB_ARM.jsonl
 *
 * A transcript is one JSON object per line, in the shapes Claude Code writes:
 *
 *   - session records, `{"type": "attachment", "attachment": {"type": "hook_success", "hookEvent": ..., "command": ...,
 *     "durationMs": ...}}` and `{"type": "system", "subtype": "stop_hook_summary", "hookInfos": [{"command": ...,
 *     "durationMs": ...}]}`, as in the session transcript Claude Code keeps, are appended to $MEMORY_LAB_OUT/session.jsonl;
 *   - every other line is a `--output-format stream-json` event, printed to stdout as Claude Code prints it. In an
 *     `assistant` event, each `Write` (`file_path`, `content`) and `Edit` (`file_path`, `old_string`, `new_string`,
 *     `replace_all`) tool call is applied to the working directory; other tools are printed and not run.
 *
 * A relative `file_path` is read from the working directory. An absolute one, as a recorded run has, is re-rooted
 * from the `cwd` of the transcript's `system` init event. A path that leaves the working directory stops the replay.
 * A missing transcript exits 1, which the lab counts as a run that failed to start.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const [dir] = process.argv.slice(2);
const { MEMORY_LAB_TASK: task, MEMORY_LAB_ARM: arm, MEMORY_LAB_OUT: out } = process.env;
let lines;
try {
  lines = readFileSync(join(dir, task, `${arm}.jsonl`), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
} catch (error) {
  console.error(`replay-agent: no transcript for ${task} ${arm}: ${error.message}`);
  process.exit(1);
}

const cwd = process.cwd();
let recorded = null;
const inside = (path) => {
  const target = resolve(cwd, isAbsolute(path) && recorded !== null ? relative(recorded, path) : path);
  const rel = relative(cwd, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`replay-agent: ${path} is outside the working directory`);
  return target;
};

for (const line of lines) {
  if (line.type === 'attachment' || line.subtype === 'stop_hook_summary') {
    appendFileSync(join(out, 'session.jsonl'), `${JSON.stringify(line)}\n`);
    continue;
  }
  if (line.type === 'system' && line.subtype === 'init' && typeof line.cwd === 'string') recorded = line.cwd;
  for (const block of line.type === 'assistant' ? (line.message?.content ?? []) : []) {
    if (block.type !== 'tool_use') continue;
    const { file_path, content, old_string, new_string, replace_all } = block.input ?? {};
    if (block.name === 'Write') {
      const path = inside(file_path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    } else if (block.name === 'Edit') {
      const path = inside(file_path);
      const text = readFileSync(path, 'utf8');
      if (!text.includes(old_string)) throw new Error(`replay-agent: ${file_path} does not hold the text an Edit replaces`);
      writeFileSync(path, replace_all === true ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string));
    }
  }
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
