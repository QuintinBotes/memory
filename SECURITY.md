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
- **Instruction files.** Memory reads `CLAUDE.md`, `AGENTS.md` and the other
  files an agent loads, read-only, to leave out what they repeat and what they
  contradict. A file or import that resolves outside the repository (or, for
  the user's own file, the home directory) through a link or a path is not
  read, and what they say is never an item or evidence, so planted text in
  them cannot gain owner trust. Memory writes an instruction file only when
  the owner runs `memory conflicts apply <id> --confirm`: it refuses unless
  stdin is a terminal or `--yes-non-interactive` is passed, so an agent with a
  shell can run it; add an ask rule such as `Bash(*memory.mjs*conflicts apply*)`,
  as for `approve`. It writes the exact stored edit, atomically, only to a file
  it loaded or the repository's or user's `CLAUDE.md`, only if the line is
  unchanged, the file is valid UTF-8 under 256 KB, and it resolves inside the
  repository (the user's file must not be a symbolic link), and never commits
  or pushes. No MCP tool, hook or other command writes one. A stored edit holds the
  instruction line and the item's statement, and is deleted with the item.
- **Rules and Codex memories.** Recall also reads `.claude/rules` and the
  files or directories `instructionFiles` names, under the same rules as
  `CLAUDE.md`: an absolute or `..` entry makes the configuration invalid, and
  a file or directory that resolves outside the repository through a link is
  not read. `memory import` reads Codex's `MEMORY.md` and
  `memory_summary.md` under `$CODEX_HOME` (`~/.codex`), its own consent
  category: model-written, so agent trust, with text that reads as an
  instruction quarantined, and a statement naming a tenant this config is not
  bound to is reported and not stored. A task group's working directory is
  only looked up with `git config`, never run.
- **Review Voice store.** `decisions` under `imports` opens another tool's
  SQLite store, which holds findings for every repository it reviewed; memory
  filters to one repository only after reading. It is its own consent category
  and is skipped until the plan is confirmed. The owner's decision keeps owner
  trust, but the finding text is model-written, so text that reads as an
  instruction is quarantined with agent trust.
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
- **Embeddings stay on this machine for a tenant.** No embedder is configured
  by default. A local Ollama (`"provider": "ollama"`, at a loopback address)
  keeps the text on this machine. A tenant's text is sent only to an embedder
  at `127.0.0.1`, `localhost` or `[::1]`; any other address, Voyage's
  included, is refused for it and gets the person file's text only (#28). The
  optional reranker (`rerank` in `config.json`, off by default) sends the
  query and the found rows' statements to a generative model under the same
  rule: loopback only for a tenant.
  With Voyage AI (`voyage-4`) named and `VOYAGE_API_KEY` set, memory sends to
  `api.voyageai.com` over HTTPS: the statement of each active item when you
  `remember` or `approve` it or run `memory embed --backfill`, for the person
  file only. It sends no paths, evidence, source references or
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
- **The review pane runs inside Claude Code.** `hooks/panel.tsx` is a mod:
  it runs in Claude Code's process, unsandboxed, like any mod. It only runs
  `node dist/memory.mjs` with `review --json`, `review`, `approve <id>` or
  `reject <id>`, reads no store or file itself, makes no network request and
  registers no tool, so an agent cannot press its buttons. Statements are drawn
  with control and bidi characters removed. `claude plugin validate .` lists
  every call it makes.
- **Capture sends text out.** Automatic capture (on by default once you confirm
  the consent plan that lists it, off with `capture.enabled: false`) sends the
  session transcript's user and assistant text, at most 48,000 characters per
  run, to `api.anthropic.com` with your `ANTHROPIC_API_KEY`, or without one through
  `claude -p` on your Claude Code login. Credentials, emails,
  handles and webhook URLs are replaced before it leaves; pattern matching
  cannot catch a secret that does not look like one, such as a password in
  prose, and the transcript can hold your code. Nothing is sent from a
  repository that matches no tenant. The tokens used per run are logged to
  `logs/capture.jsonl`, never the text. What the model keeps is saved as active
  items with agent trust; text that reads as an instruction is quarantined.
  A model's output is data, never a command: it is refused if it carries a
  credential, an email or a handle, and it is shown as a cited fact in the fence.
- **SCF export sends proposals out.** `memory export --to scf` sends a tenant's
  proposed repository and organisation items to the SCF address configured for
  that tenant (`memory init --scf <tenant>=<url>`, https only, or http to this
  machine), with `SCF_API_KEY` as a bearer token: each item's statement, type,
  scope, repository name, rationale, anchored paths and symbols, and each
  evidence's source reference, role and time. An item holding text redaction
  would change is not sent. Person-file items and other tenants' items never
  leave. `memory import --scf` reads decisions and run outcomes back from the
  same address. Redirects are refused, so the key reaches no other host, and
  answers are read up to 5 MB. Nothing is sent without an address, a key and
  your consent to the plan's scf category.
