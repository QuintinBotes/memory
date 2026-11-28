---
name: doctor
description: Say why memory does or does not recall or capture in this directory, with the command that fixes each failure. When the person asks why memory is quiet, missing items or not capturing.
disable-model-invocation: true
---

# Why memory is quiet here

1. Run, from the directory the person is asking about:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/memory.mjs" doctor
   ```

2. Report each `fail` line with its `fix:` command, then any `off` line that
   explains what the person asked about. Say nothing about the `ok` lines
   unless asked.
3. Do not run a fix yourself: `memory init ... --confirm` records the
   person's consent, and only they give it, from a terminal.
