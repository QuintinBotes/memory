---
name: remember
description: Remember one statement for later sessions, in the scope the person chooses. Only when the person asks to remember something.
disable-model-invocation: true
argument-hint: <statement>
---

# Remember one statement

The person asked memory to remember: `$ARGUMENTS`

1. Write it as one short factual sentence, the way a colleague would state a
   fact: "Releases are cut from the main branch only", not "Always cut
   releases from main". Keep the person's meaning; do not add to it.
2. Pick the scope:
   - `repository`: true of this repository only (the default).
   - `organisation`: true of every repository of this GitHub owner.
   - `person`: the person's own preference, true everywhere. It must name no
     code, path, organisation or repository, or memory refuses it.
   - `global`: a fact about the tools themselves, with the same rule.
3. Pick the type: `preference`, `convention`, `decision`, `hazard`,
   `precedent`, `failure-pattern` or `repair-recipe`.
4. If the statement is about specific lines, add `--anchor <path>:<start>-<end>`
   (repository scope only). If it came from a link, add `--source <url>`.
5. Run, from the repository the statement is about:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/memory.mjs" remember --scope <scope> --type <type> -- "<statement>"
   ```

6. Report the output line. If memory refused the statement, say why in one
   sentence and offer a rewording without what it refused. Never retry with a
   different scope to get around a refusal.
