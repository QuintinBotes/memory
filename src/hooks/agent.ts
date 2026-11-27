/**
 * Hook payloads of agents other than Claude Code, read as the Claude Code payload the hooks already handle. Codex's
 * fields are its documented ones (developers.openai.com/codex/hooks) and were checked against codex-cli 0.172.
 */

type Input = Record<string, unknown>;

/** The agent name a Codex payload is logged and ledgered under, in place of Claude Code's `main`. */
export const CODEX = 'codex';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * An apply_patch envelope as the Claude Code tool it does: an update as a MultiEdit whose old strings are each hunk's
 * removed and context lines, an added or deleted file as a Write. Null when it names no file.
 */
function fromPatch(patch: string): { tool_name: string; tool_input: Input } | null {
  const lines = patch.split('\n');
  const at = lines.findIndex((l) => /^\*\*\* (?:Update|Add|Delete) File: /.test(l));
  if (at < 0) return null;
  // shortcut: only the patch's first file is read; a multi-file patch recalls for that one. Upgrade by claiming each file.
  const [, kind, file] = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(lines[at]!)!;
  if (kind !== 'Update') return { tool_name: 'Write', tool_input: { file_path: file!.trim() } };
  const edits: Input[] = [];
  let old: string[] = [];
  const flush = () => {
    if (old.length > 0) edits.push({ old_string: old.join('\n') });
    old = [];
  };
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('*** ') && !line.startsWith('*** End of File')) break;
    if (line.startsWith('@@')) flush();
    else if (line.startsWith('-') || line.startsWith(' ')) old.push(line.slice(1));
  }
  flush();
  return { tool_name: 'MultiEdit', tool_input: { file_path: file!.trim(), edits } };
}

/**
 * Codex's payload as Claude Code's, under the agent `codex`: apply_patch becomes the edit it makes, and a Bash
 * PostToolUse that did not exit 0 carries its output as Claude Code's `error`. Null for a shape this does not know.
 */
export function fromCodex(input: Input): Input | null {
  const event = str(input['hook_event_name']);
  if (event === undefined || str(input['session_id']) === undefined || str(input['cwd']) === undefined) return null;
  const out: Input = { ...input, agent_id: CODEX };
  if (event === 'PreToolUse' && input['tool_name'] === 'apply_patch') {
    const patch = (input['tool_input'] as Input | undefined)?.['command'];
    const edit = typeof patch === 'string' ? fromPatch(patch) : null;
    return edit === null ? null : { ...out, ...edit };
  }
  if (event === 'PostToolUse' && input['tool_name'] === 'Bash') {
    const response = input['tool_response'];
    if (typeof response !== 'string') return null;
    // Some Codex shells head the output with its exit code; codex-cli 0.172's Bash does not, so a bare output is read
    // as an error and the recipe's signature is what decides.
    const head = /^Exit code: (\d+)\n(?:Wall time: [^\n]*\n)?(?:Output:\n)?/.exec(response);
    if (head?.[1] === '0') return out;
    return { ...out, error: head === null ? response : `Exit code ${head[1]}\n${response.slice(head[0].length)}` };
  }
  return out;
}
