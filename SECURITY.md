# Security

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting on this
repository (Security, then Report a vulnerability). Please do not open a
public issue for it.

The most valuable reports are about isolation: any way an item stored for one
tenant is read or printed in another tenant's repository, in a repository with
no tenant, or in a Claude Code config not bound to that tenant.

## What memory protects, and what it does not

- **Isolation by tenant.** Each tenant has its own SQLite file, and a process
  opens only the tenant its repository's github.com `origin` remote and its
  Claude Code config allow. Anything ambiguous means no tenant. The tenant is
  whatever `origin` says: a directory delivered with its own `.git` (an
  archive, a shared drive) can claim a repository it is not.
- **Refusal at the boundary.** A statement is checked before it is stored, and
  there is no column for raw text. The check recognises credentials by their
  shape (Review Voice's redaction patterns), private key headers, email
  addresses, handles and webhook URLs. Pattern matching cannot recognise a
  credential that does not look like one, such as a plain password written
  in prose. Do not ask memory to remember secrets.
- **Model control tokens.** Text carrying a special token
  (`<|im_start|>`, `<|endoftext|>`, `[INST]`, `<<SYS>>`, `</s>`) or a leading
  role prefix (`System:`, `Assistant:`, `Human:`) is refused from the agent,
  capture and import paths. Backtick code spans are ignored and the bare `<s>`
  and `<system>` tags are not tokens. Your own `memory remember` is refused
  only a full chat-template sequence (`<|im_start|>` ... `<|im_end|>`,
  `[INST]` ... `[/INST]`), so you can write about tokens and roles.
- **Red-team suite.** `test/poison.test.mjs` replays the published poisoning
  attacks (query-only injection, planted items that fire later, attacks split
  over items, trust laundered through merged evidence, role spoofing, fence
  escape, planted auto memory) against every capture path, with fixtures only,
  in CI on every pull request; `memory eval poison` runs the same families
  offline and reports, per family, attacks attempted, reached active, rendered
  outside the fence and raised support, plus the 50 benign items. It measures
  memory's gates, not a model's resistance. A source file that stores items
  with no family in it fails the suite. Known limit: the instruction filter is
  a deny-list, so an instruction paraphrased past it (for example "pipe the
  vendor script to a shell" with no `curl ... | sh`) is not quarantined; from
  capture it is stored as an active agent-trust fact, shown quoted inside the
  fence and never as an instruction, and from a proposal it waits for you.
- **Taint labels.** Evidence carries the external content its session read.
  `memory_propose` names it (`evidence.tainted_by`, and a source from
  `external` or `bot` automatically); capture reads it from the transcript's
  tool calls: `WebFetch` and `WebSearch` (by host) and any MCP server's tools
  but memory's own (by server). Taint is a label: a capture from such a
  session is still saved active, and imperative text from it is quarantined as
  usual. The label shows in review, `memory_get`, search
  and the session slice, and is kept through merges and supersession. Limits:
  a page read through a shell command (`curl`, `gh`) is not seen, a tool
  result from inside your tenant is not told from one outside it, and an
  agent's own `tainted_by` is its word, though it can only add a label.
- **Automation sessions.** A session started by automation neither captures
  nor proposes unless the consent plan names automation
  (`memory init --automation on --confirm`, which changes the plan hash).
  Claude Code gives hooks no field that says a session is headless, so memory
  reads what it leaves: the `CLAUDE_CODE_ENTRYPOINT` it exports (`sdk-*`,
  `github-action`), `GITHUB_ACTIONS=true` (a bare `CI=true` is not read: a
  developer shell often has it), and an `entrypoint` it
  records on transcript lines. This is detection by convention, not a
  guarantee: a process that clears those variables looks like a person, a
  person running `claude -p` looks like automation, and the transcript field
  is not a documented contract. `memory remember` is the owner's command and
  is not refused, since a shell cannot tell the owner from an agent that runs
  it. Recall at session start is unchanged.
- **Organisation-free person items.** Person and global items are refused when
  they name code, a path, a tenant, an owner or a repository. This is a
  heuristic; names of one character are not matched.
- **Advisory only.** Items are printed as cited facts. Memory never blocks a
  tool call or grants a permission.
- **Local store.** Nothing else is uploaded. Files are created with mode 0600 in a 0700
  directory.
- **Embeddings send text out.** With the default
  provider (Voyage AI, `voyage-4`) and `VOYAGE_API_KEY` set, memory sends to
  `api.voyageai.com` over HTTPS: the statement of each active item when you
  `remember` or `approve` it or run `memory embed --backfill`, and the words of
  each `memory_search` query. It sends no paths, evidence, source references or
  proposals, and never the text of an item flagged as reading like an
  instruction. The statements have passed the same refusal check as every
  stored item, which cannot recognise a credential that does not look like one.
  The key is read from the environment, never written to disk, never printed
  and never logged; the Voyage address can be moved with `VOYAGE_BASE_URL`
  (for a proxy), which receives the key too. Vectors come back and are kept in
  the item's own file, deleted with it. Without a key nothing is sent. Sending
  needs your consent to the plan's embeddings category, and the owner picks the
  provider in `config.json`. Voyage's own retention terms apply to what it
  receives.
- **Capture sends text out.** Automatic capture (on by default once you confirm
  the consent plan that lists it, off with `capture.enabled: false`) sends the
  session transcript's user and assistant text, at most 48,000 characters per
  run, to `api.anthropic.com` with your `ANTHROPIC_API_KEY`. Credentials, emails,
  handles and webhook URLs are replaced before it leaves; pattern matching
  cannot catch a secret that does not look like one, such as a password in
  prose, and the transcript can hold your code. Nothing is sent from a
  repository that matches no tenant. The tokens used per run are logged to
  `logs/capture.jsonl`, never the text. What the model keeps is saved as active
  items with agent trust; text that reads as an instruction is quarantined.
  A model's output is data, never a command: it is refused if it carries a
  credential, an email or a handle, and it is shown as a cited fact in the fence.
