# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `memory list` with nothing visible says so on stderr, naming the tenant this directory resolves to, instead of printing nothing (#122). Stdout is unchanged.
- An owner decision on a long Review Voice finding is no longer dropped by `memory import` (#120): the statement is cut between words to 300 characters with an ellipsis, where before it was refused as too long; the pull request link holds the whole finding.
- The Review Voice workflow posts again (#116): pinned to review-voice main at 98ad060, unreleased, which carries the fixes for its #508 (a clean review exited 4 without posting, the action's own job counted as pending CI), #520 (a failed post names its reason) and #525 (the post's thread re-check failed with 403 under the Actions token). Moves to a release tag once one exists.

### Added

- `npm run e2e` (#112): real Claude Code sessions with the checkout loaded by `--plugin-dir` check the session-start slice (#114), point-of-action recall, `memory_search` and `memory_propose` over MCP (refused for automation until `--automation on`), and that the plugin validates and the review pane's tests pass. Not run in CI.
- Review Voice reviews this repository's pull requests (#110): a pinned workflow posts its verified findings, and the owner's answers flow back through `/review-voice:sync` into `memory import` as proposals. Not a required check; it skips without an `ANTHROPIC_API_KEY` secret.

## [0.9.0] - 2026-11-27

Installed copies update to this release: everything since 0.8.0 shipped without a version change, so `/plugin update` kept 0.8.0 (#108). The consent plan is at version 13; memory stays off until you agree to it again with `memory init --confirm`.

### Added

- A review pane and a waiting-proposals band, as a Claude Code mod (#104). `/memory-review` opens a pane listing this repository's tenant's and the person file's proposals, each with its evidence, the agent that proposed it and the shadow gate, with Approve and Reject buttons; a band above the prompt counts the proposals waiting. Both run the bundled CLI and nothing else (`memory review --json`, new, and `memory approve` / `memory reject`), register no tool the model can call, and strip control and bidi characters from what they draw. Needs Claude Code v2.1.287 or later; settings hooks, MCP and the CLI are unchanged, so other agents lose nothing.
- `memory_search` takes an optional `as_of`, an ISO date (#102). It searches the versions valid at that time instead of the current ones, so a superseded version is found as of a date before it was replaced, and each row says when its version was valid and when it was replaced. Tenant isolation, quarantine, taint and ranking are unchanged, rejected items are never returned, and without `as_of` the results are exactly as before. A date memory cannot read is refused with a clear error. The head-to-head memory arm asks temporal questions as of their date: on the synthetic `acme` fixture its temporal recall at 5 goes from 0 to 1, and no other category changes. No schema change.
- Transcripts outside a tenant, and a model pass (#80). Consent plan version 12 adds two categories; until you agree again neither runs. With the transcripts opt-in on, a session whose directory matches no tenant records its transcript path in the person file, and the next session start or `memory sweep` turns a correction about your own habits into a person proposal quoting you verbatim; one that names a path, code or a repository is not kept. `memory corrections` is an offline model pass, never in a hook and off unless `transcriptModel` is set in `config.json`: by default a local Ollama at `http://127.0.0.1:11434` with Inkling 2 Mini (`inkling-2-mini`), which you install; memory never downloads it. It runs through the shared provider runner (120-second limit, SIGKILL, capped output), stops asking after the first failure, and keeps only quotes found verbatim in your redacted messages. A tenant's messages go only to a model on this machine; with a remote address the pass skips every tenant and says so.
- Toolset items and routing (#46). `memory remember --scope global --type toolset` keeps a tool's purpose as a global item that names no repository; `memory outcome <id> accepted|rejected [--cost <n>] [--source <run>]` records a run's outcome as evidence on it (schema 18 adds `outcome` and `cost` to evidence); `memory route -- <task>` ranks the toolsets against a task by the search's own points, equal points going to more accepted outcomes, each row with its accepted and rejected counts and total cost. `memory_propose` does not take a toolset.
- `memory eval head-to-head --since <date> --history <file>` (#25): memory scored against the alternatives on questions built from the tenant's own corrections, decisions and failures after the cut-off, in seven categories (single fact, multi-source, knowledge update, temporal, abstention, code-anchored hazard, stale citation), every arm ingesting only the evidence before it. Arms: this plugin, memory off, Claude Code auto memory (the first 200 lines of a `MEMORY.md`), the whole history in context, and Mem0, Graphiti, Basic Memory and a community memory plugin run from your local install by the command you name in `--arms`, with telemetry off or not at all; an arm that is missing or crashes scores zero and says so, and an arm that sends evidence off the machine is skipped for a client tenant. The FR-006 bars are printed first; then recall at 1 and 5, abstention, stale recall, tokens and p50/p95 latency per arm and category, graded without a model; then the verdict, the matcher's precision from 30 hand-checked grades (`--checked`) and the vocabulary-miss share, kept in `eval/head-to-head/<tenant>/last.json` in the data directory with the replay set and every per-question result. A synthetic 315-question `acme` fixture and the script that writes it ship in `test/fixtures/head-to-head/`. No schema change.

- A local semantic search leg (#28), off by default. Name an embedder in `config.json`: `{"provider": "ollama", "model": "bge-m3", "url": "http://127.0.0.1:11434"}` uses a local Ollama's `/api/embed` with a model you install (memory never downloads one). `memory_search` and `memory recall --diff` use it, never a hook; when the embedder is absent or fails, search ranks by words and says the semantic leg was skipped and why. The head-to-head scorecard's vocabulary-miss share is information for that choice, not a gate.
- An optional local reranker (#28): `"rerank": {"model": "inkling-2-mini", "url": "http://127.0.0.1:11434"}` in `config.json` has a generative model on the same Ollama reorder the rows `memory_search` and `memory recall --diff` found; each row adds `rerank <place>`. Off unless named; Inkling 2 Mini is the documented default, not pinned and never downloaded by memory. A tenant's text goes only to a loopback address; a failure, a refusal or a 3-second timeout keeps the fused order and says the rerank was skipped. Never in a hook.
- No schema change and no new consent version for either; the embeddings category's wording now covers both.

### Fixed

- Opening the repository in Claude Code no longer starts a broken `memory` MCP server (#106). The plugin's server is declared in `.claude-plugin/plugin.json` instead of a root `.mcp.json`, which Claude Code also read as the project's own config, where `${CLAUDE_PLUGIN_ROOT}` is unset. The session lab copies `types/` into its plugin instead of `.mcp.json`.

### Changed

- Search fuses the keyword ranking and the semantic leg by reciprocal rank fusion (k = 60) instead of adding semantic points to the keyword sum; the `graph` bonus is now a third list in that fusion, of items sharing an anchored path with one of the top three keyword or top three semantic hits. Each row keeps its points, `graph 1` among them, and ends with `rrf`.
- Embeddings are off unless `embeddings` in `config.json` names a provider; voyage-4 is no longer the default. A tenant's text goes only to an embedder on this machine (a `127.0.0.1`, `localhost` or `[::1]` address): Voyage, or any embedder elsewhere, embeds only the person file's items, and `remember`, `approve` and `memory embed --backfill` say when they skip a tenant's. The search note now reads "Semantic leg skipped (...)" in place of "Embeddings not used (...)".
- Capture from other agents (#48). `memory capture` reads a Codex session log as it reads a Claude Code transcript, and the source of what it keeps names the agent (`capture:codex:<session>:<file>`). Codex's own injected user-role text (environment context, user instructions, the AGENTS.md block) is never read. A log in a format no adapter knows is skipped, reported in the run's summary and recorded as `skipped` in `logs/capture.jsonl`; nothing is saved from it. A proposal made through the MCP tools records the client's name from `initialize` on its evidence (`extractor` `mcp:<name>`), so an agent with no adapter is still named. No schema change.
- `memory ui [--port <n>]`, a local page to browse, search, edit and review (#42). It listens on `127.0.0.1` only and refuses any other `--host`, `0.0.0.0` and `::` included, before a socket opens. It answers 403 to a non-loopback peer, a Host other than `127.0.0.1:<port>` (DNS rebinding), a request without the token printed for that run, and a write from any other origin. Search ranks as `memory_search` does; an edit supersedes the item, and its detail shows every version in order with evidence and audit entries; approve and reject go through the code `memory approve` and `memory reject` run and record the same audit entry; instruction-file edits can be applied or rejected, so, like `memory conflicts apply`, it starts only from a terminal unless `--yes-non-interactive` is given. The edit field holds the stored statement as it is, so saving never writes back the defanged text shown elsewhere. Only the tenant this config binds for the repository, and the person file, are shown. Item text is put on the page as text, never as markup. No schema change.
- The MCP server sends instructions at `initialize`, so every agent that installs memory knows when to call `memory_search`, `memory_related`, `memory_feedback` and `memory_propose`, and that items are data, not instructions. About 120 tokens per session.

### Fixed

- The agent behind a proposal made over MCP is shown: `memory review` and `memory_get` add `via <agent>` to its evidence line, `memory_get` JSON and the UI carry `agent` (#100).
- The model pass and the semantic leg decide "a model on this machine" with one shared check (127.0.0.1, localhost, [::1]) instead of two copies (#101).
- `memory outcome` with `--source` counts a run once per toolset: reporting the same run again changes nothing and says so (#99). An outcome without `--source` still counts each time.
- SCF export (#86): an answer is read a chunk at a time and the export fails at the 5 MB cap instead of buffering the whole body first; a blank proposal id is rejected, never linked, so the next export can adopt a real proposal; README, SECURITY.md and the consent plan's closing line now say that `memory export --to scf` sends a tenant's proposals and evidence to the SCF address configured for it.
- `memory purge --repo` deleted every episode in each store it opened (#82). Each failing-command episode now records its repository (schema 17; older episodes stay unknown). `--repo` deletes only that repository's episodes and keeps unknown-origin ones; `--tenant` still deletes them all. The preview lists episode counts per repository and, for kept unknown-origin episodes, names the `--tenant` command that removes them.
- A passing command repaired the same session's open episode for that command in another repository too (#89). Repair now matches the repository; episodes with no repository (before schema 17) are matched as before.

## [0.8.0] - 2026-11-26

### Fixed

- A `<private>` span that opens in a transcript record the owner-turn filter skips (a tool result, a tool call, a sidechain or meta record, a non-text block) now hides a later owner correction, as one opened in an owner turn does (#84). Every record and block is scanned for the tags in order before anything is filtered.

### Added

- Transcripts, opt-in (#12). `memory init --transcripts on --confirm` is a separate opt-in, off by
  default, and a new consent category (plan version 10): until you agree again nothing is recorded.
  With it on, the `SessionEnd` hook (`memory transcript`) records only the transcript's path in the
  session's tenant file (schema 15, table `transcripts`); the next session start or `memory sweep`
  reads that file on this machine, takes the owner's own messages (never agent output, subagent
  records or tool results; `<private>` spans and a `DO NOT INDEX THIS CHAT` transcript are skipped),
  redacts them, and turns each correction sentence into one proposal that quotes the words verbatim,
  owner trust, with the session and line as its source. A quote that is not verbatim is dropped; a
  transcript deleted first is skipped and counted in the audit log. Only quote and source are kept;
  records are deleted after 30 days and by `memory purge`. A session in no tenant records nothing.
  `PostCompact` keeps the redacted compaction summary as an episode, only under this opt-in.
  `<private>` spans are tracked across the whole transcript and a sentence touching one is never quoted; the transcript is only opened at processing (SessionEnd reads the environment, not the file); `memory purge --repo` deletes only that repository's records; expiry runs on every sweep whatever the opt-in and each deletion is audited once (`transcripts_expired`); whether a transcript reads as automation is decided from its recording environment and its own entrypoint, never the sweeping process. Corrections are found by deterministic cues first; the offline small-model batch is not built yet.
- Export memory as SCF. `memory export --to scf [--repo | --all-repos]` posts a
  tenant's proposed repository and organisation items to the SCF set for it
  (`memory init --scf <tenant>=<url>`, key in `SCF_API_KEY`) as world proposals
  with layer `memory` and their evidence, once each; `memory import --scf` brings
  back SCF's approvals and rejections and counts run outcomes as helped and wrong.
  Schema 16 adds `scf_links` and `scf_feedback`. The person file and other tenants
  are never sent, text redaction would change is withheld, and an unreachable SCF
  changes nothing. New consent category `scf` (plan version 11).

- Filter memory by repository, and record where each item came from. Schema 14
  adds `origin_repository` (null = unknown) to every item; `remember`, `capture`,
  `memory_propose` and `memory import` fill it from the repository they ran in
  (a silo's person and global statements stay unknown), and the migration backfills repository items from their scope key.
  `memory list` and `memory export --markdown` take `--repo <owner/repo>` (that
  repository's items, its owner's organisation items, and person or global items
  learned in it) or `--all-repos` (the tenant bound here and the person file);
  `memory_search` takes an optional `repository`, skipping anchor-path matching
  for a repository other than the checkout and saying so. Only a repository of
  the tenant bound here is reachable: another tenant's, one matching no tenant,
  or no tenant here is refused before any store is opened, and `--all-repos`
  never opens another tenant's file. `memory purge --repo` also deletes the
  person and global items learned in that repository. A person or global item
  learned in the current repository gains 0.5 in ranking. No consent change.
- Promotion into checks (#19). `memory promote --propose` stores and lists
  proposals: a well-supported item (support 3 or more, no contradiction) as one
  line of the review-standards file, and an item on a symbol no test executes as
  "write a test for <symbol>". `--apply <id>` (terminal only) writes the line,
  sets `promoted` and `promoted_to` and removes the item from recall; it refuses
  a secret, email, handle or committer's name, and a symbolic link or a path
  outside the repository, and never commits or pushes. `--reject <id>` keeps a
  tombstone so it is not proposed again. Schema 13 adds `promotions`; no consent
  change. The Review Voice policy and Orbit check targets are not built yet.
- Symbol anchors that follow the code (#10). A code anchor provider is the
  command named under `impactProvider` in `config.json` (the one command, run
  without a shell with one JSON line in and one out, that diff recall uses too;
  `docs/provider.md`: a stable key per symbol, the symbol at a line, changes
  between snapshots, impact and proving tests). `memory remember
  --anchor path#name#kind` stores the key, signature, lines, hashes and
  snapshot. At session start a detached `memory anchors refresh` re-resolves
  only anchors in changed files: a moved or renamed symbol with an identical
  content hash is re-anchored on its own, logged, and reversible with `memory
  anchors undo <move-id>`; a changed signature or lost citation is stale; an
  uncertain key loss is stale with a re-anchor proposal in `memory review`
  (`memory anchors adopt`). An answer about another repository is dropped; a
  failing provider changes nothing and anchors are checked by path. Consent
  plan 9 adds the `symbols` category. No schema change.

- Items name the tests that prove them (#17). The anchor refresh asks the code
  anchor provider's `tests` op for each anchored symbol, once per snapshot, and
  keeps the nearest test whose evidence executes it (`call`, `dispatch`,
  `observed`, `transitive_call`; never `reference` or `import`). A recalled row
  ends `test: name path:line` within the same 60 estimated tokens; `memory
  report` says how many code items name a test. Nothing is looked up inside a
  hook. A run makes at most `MEMORY_TESTS_PER_RUN` lookups (default 50) and the
  next continues; a failing `tests` op ends the lookups for the run without
  costing any anchor its move; invalid entries are dropped. No consent or
  schema change (consent plan stays 9).

## [0.7.0] - 2026-11-24

### Added

- Impact-aware diff recall (#16): with `impactProvider` in `config.json` (a
  command, run without a shell, speaking one JSON line each way),
  `memory recall --diff` also recalls items on the depth-1 dependents a change
  reaches: 2 points (`dependent` in the why), 1 more for a dependent neither
  changed nor tested, within the same 600 tokens. No snapshot, a failing
  provider or no consent to the new plan item falls back to path overlap and
  says so. Dependents of another repository are dropped. Consent plan version
  8 adds the `impact` category; no schema change.
- Failures and reverts become proposals (#18). `memory ci` reads this
  repository's GitHub Actions runs with `gh`: a failed run followed by a
  passing run on another commit gives a `repair-recipe` proposal whose evidence
  names the fingerprint, the fix commit and both runs, with a
  `passed-after:<sha>` marker so failure recall labels it verified once
  approved. Its signature is one scrubbed, normalised line of the failed log
  that failure recall can match; none that can means no proposal.
  `memory import --orbit` does the same for a check Orbit's run-end
  observations show failing and then passing. A new `PostToolUse` hook on Bash
  (`command-passed`) turns a command that fails and then passes in a session
  into a proposal, only with the new opt-in `memory init --failing-commands on`:
  the failed command's program and subcommand (never its arguments) are kept as a scrubbed episode for 30 days (removed by the
  sweep, by the next failure and by `memory purge`). The hook also links a
  `git commit` to the items shown in the session and counts a `git revert` of
  that commit once as a contradiction of them; `memory reverts` does the same
  scan on demand. Two such reverts within seven days turn recall off
  (`recallOff` in config.json) until `memory init --recall on`. Consent plan 7
  adds the `failures` category; schema 12 adds `episodes`, `commit_items` and
  `reverts`.
- Failure recall at the failing command (#15): a `PostToolUseFailure` hook on
  Bash shows the failure patterns and repair recipes whose signature (the
  statement up to ` => `, at least two words that are not common or
  placeholders) is in one line of the error, within 120 tokens, once per item
  per fingerprint per agent. The error is fingerprinted with a copy of Orbit's
  failure fingerprint, check id fixed to `bash`. A recipe whose evidence has a
  `passed-after:<ref>` source is labelled `verified`. A repeat in the same
  session and agent counts once per session as a contradiction. Interrupts
  print nothing, and a failure with nothing to show takes no write lock. Needs
  no opt-in and no new consent category: it stores no error text, and its
  ledger is made on first use.

## [0.6.0] - 2026-11-24

### Added

- Orbit adapter, both ways (#11). `memory import --orbit` reads each listed
  checkout's Orbit knowledge store read-only: validated repository lessons
  (run as evidence), contradictions (raise the item's count, never lower it) and
  run-end failure fingerprints, as agent-trusted proposals in the checkout's
  tenant. `memory recall --orbit [--path] [--fingerprint] [--check]
  [--max-tokens]` gives Orbit's retrieval at most three lean rows, and nothing
  unless `.orbit/config.yaml` has `knowledge.lessons_in_prompts: true`; an Orbit
  lesson unsupported for 28 days is not offered. Consent plan version 6 adds the
  `orbit` category; schema version 11 adds `item_keys` (fingerprints and check
  ids, deleted with their item); a fingerprint or check match scores 2 in ranking.
- Related items and open questions (#39): `memory_related(path_or_symbol,
  depth?)` and `memory related <path> [--depth n]` return the active items
  anchored at or under a path or symbol prefix, read through the anchor-path
  index, as whole rows within the session budget. A new item type,
  `open_question`, can be proposed by an agent and is inactive until the owner
  approves it; `memory close <id>` (owner only, no MCP tool) closes it and
  removes it from recall. No schema change and no new consent category.
- `memory report [--tenant <name>]` (#41) ranks each bound tenant's active
  items by helped minus wrong minus stale, then confidence, then id, with items
  that have no feedback listed apart. Per tenant, never across tenants;
  quarantined items show no text; read only.
- Instruction files are the source of truth (#26, #40): recall reads
  `CLAUDE.md`, `AGENTS.md`, their `@`-imports and the user's `CLAUDE.md`
  read-only, leaves out an item that repeats a loaded line (counted as
  `withheld` in the injection log; `memory_propose` of a repeat is refused
  naming file and line) and one that contradicts a line (the file wins). A
  contradiction stores a proposed edit shown as a diff in `memory review`; an
  owner-approved item with support of 3 or more is proposed for promotion into
  the file. `memory conflicts [apply <id> --confirm | reject <id>]` is the only
  writer of an instruction file; reject resolves without writing. Apply
  writes atomically and only inside the repository (never through a symbolic
  link), refuses non-UTF-8 or over-256 KB files, needs a terminal or
  `--yes-non-interactive`, and a scoped exception ("only when", "unless",
  "for ...") is never read as a contradiction.
- Recall at the point of action (#14), off unless `"pointOfAction": true` is
  in `config.json`: a `PreToolUse` hook on Read, Edit, Write, MultiEdit and
  NotebookEdit adds the items anchored where the call lands, once per agent
  per session, within 120 tokens per injection and 600 per agent per session,
  and never returns a permission decision. A busy store is skipped and logged.
  With it on, anchored items leave the session-start slice, which counts them;
  `PreCompact` prints at most 1,000 characters of what was shown, and a
  session start after a compaction resets the main agent's ledger. The ledger
  is a table in the tenant file, created on first use.
  The hook finds items through an indexed anchor-path table (schema version 9,
  kept by triggers and backfilled on open), so it loads only the items anchored
  at the touched path or a directory above it, and none for an unanchored path.
- Review precedents reach every reviewer (#9): `memory import` reads Review
  Voice's store read-only (`decisions` under `imports`) and proposes a
  `precedent` for each owner `keep`, `dismiss`, `never_flag` and `rewrite`,
  anchored to the finding's directory with the pull request link as source; a
  teammate's strong dismissal arrives with team trust and one with no
  `decided_by` with agent trust. Reading the store is a new `decisions` consent
  category (plan version 5): until you confirm the plan again, import skips it
  and says why. The decision keeps its trust, but finding text a model wrote
  that reads as an instruction arrives quarantined with agent trust. `memory recall --diff
  <base>..<head>` prints the precedents and hazards for the changed paths in
  600 estimated tokens. Review Voice's agents still never receive the slice.

## [0.5.0] - 2026-11-24

### Added

- `memory export --markdown <dir>` (#27): this repository's tenant and the
  person file as a deterministic Markdown folder, one file per item and an
  index by status, for reading and diffing. Read only; strings are code spans;
  quarantined text is withheld and a tombstone shows its hash; refuses a folder
  inside another tenant's repository.
- Standing red-team suite (#22): `test/poison.test.mjs` replays one test per
  published poisoning attack class against every capture path (owner
  `remember`, `memory_propose`, automatic capture, auto memory and silo
  import) and runs in CI with `npm test`: imperative text from non-owner
  sources, query-only injection, a delayed trigger over 100 sessions, attacks
  split over several items, instructions in captured text, fence escape with
  homoglyphs and invisible or bidirectional characters, trust laundering
  through merged evidence, role spoofing, planted auto memory, credentials and
  emails, cross-tenant reads and writes, and secrets or quarantined text
  reaching an embedding provider. A registry test fails when a new source file
  stores items without a family. The 50 benign owner items are all recalled.
- `memory eval poison` (#22, FR-001 to FR-004): the red-team families offline
  in a throwaway store, one JSON line per family with attacks attempted,
  reached active, rendered outside the fence and raised support, then the 50
  benign owner items and a summary; exit 1 when any attack got through.
- Taint labels (#22, FR-006): evidence records the external content its session
  read (migration 8). `memory_propose` takes `evidence.tainted_by` and names an
  `external` or `bot` source itself; capture reads web fetches, searches and
  MCP tool calls from the transcript and labels what it keeps; the items stay
  active, and imperative text is quarantined as before. The label shows in review, `memory_get`, search
  and the session slice, and survives merges and supersession.
- Automation sessions (#22, FR-008): a session started by automation (headless
  entrypoint, GitHub Actions; a bare `CI=true` is not read) neither captures nor proposes unless the consent plan names
  it (`memory init --automation on`); the plan shows `automationSessions`.
  Consent given before this stays valid.

### Fixed

- Text carrying a model control token (`<|im_start|>`, `[INST]`, `<<SYS>>`,
  `</s>`) or a leading `System:` or `Assistant:` was stored by every capture
  path; the refusal check now refuses it. Code spans are ignored, and your own
  `memory remember` is refused only a full chat-template sequence.
- Review fixes on #24. `memory purge` checks the write-ahead log checkpoint: while another process holds a read snapshot it retries for 5 s, then
  fails with a clear message instead of reporting success with the purged text still in the `-wal` file, and the other store files are still purged.
  The injection log is rewritten and appended under one lock, so a purge no longer drops a line a subagent writes meanwhile. A subagent hook that cannot
  read the store prints nothing and logs a `skipped` line. `memory sweep` reads its rows under the write lock, and the tombstone checks of an import and of
  a proposal run under it too, so two writers cannot propose one pair twice or write a statement the owner just rejected. A macOS mount point containing
  " on " is read whole, so an smbfs share there is refused at `memory init`.

### Changed

- Many writers and 10,000 items (#24). Every store file now runs in write-ahead
  log mode, so a reader never waits for a writer, and writers queue on one lock
  for up to 5 s instead of failing on a lock upgrade. A statement proposed by
  two sessions at once is one item with both pieces of evidence: the exact-match
  check is repeated under the write lock, and the same source arriving twice is
  one piece of evidence. The SessionStart and SubagentStart hooks wait at most
  250 ms for a lock; a hook that cannot get the store prints nothing and exits 0.
  Recall's narrower-scope-wins rule compared every pair of visible items (about
  2.7 s at 10,000); it now compares a statement only with the narrower-scope
  items that share its rarest words, with the same result. New tests cover the
  eight-writer, killed-writer, held-lock and 10,000-item scenarios by the work
  done, and `node scripts/bench-hook.mjs` measures hook latency on demand.
  `memory init` refuses a data directory on a network file system (NFS, SMB,
  AFP and similar, read from /proc/mounts or `mount`), where SQLite's locking is
  not reliable, and names the reason. The anchor refresh (session start,
  `memory recheck`, the MCP re-check) takes its own lock file beside the store,
  `<store>.refresh.lock`: a refresh that finds it held skips and never waits, so
  it cannot hold up the slice or a writer, and two refreshes never apply the
  same change twice. A lock older than 30 s is taken over.

## [0.4.0] - 2026-11-24

### Added

- Hybrid recall (#44, implementing #43). Embeddings sit behind a provider
  interface (`name`, `model`, `dims`, `embed`); `voyage` (default, `voyage-4`,
  a plain `fetch` with `VOYAGE_API_KEY`, no SDK) and an offline `fake` for
  tests, chosen by `embeddings` in `config.json`. Vectors live in the item's
  own SQLite file (migration 7) and a purge deletes them. `remember` and
  `approve` embed the item they activate, never quarantined text, and
  `memory embed --backfill` fills the rest. `memory_search` adds a `semantic`
  and a `graph` part to the fixed sum, with their points in `why`; with no
  key, no network or no vectors it ranks as before and says so once, and its
  one network call times out after 1.5 s. Embeddings are consent plan
  version 4 (capture is 3): they stay off until `memory init` is confirmed again. The tests
  call no host but this machine, and a guard fails a test that does.
- Automatic capture (#45, decision #43). A Stop and SessionEnd hook runs
  `memory capture`, which detaches and returns at once. A filter model, Claude
  Haiku over the Messages API by plain `fetch` (`ANTHROPIC_API_KEY`) or a
  deterministic `fake` for tests, reads the redacted transcript and keeps
  lessons and decisions. Each goes through the repeat and conflict matcher and
  is saved active with agent trust and provenance; instruction-like text is
  quarantined; nothing is captured in a repository that matches no tenant. It
  is consent plan version 3, so it stays off until `memory init` is confirmed
  again, and `capture: { enabled, model, maxCandidates }` turns it off. Tokens
  per run go to `logs/capture.jsonl`. The test harness now fails any test that
  would call `fetch`.
  Only one capture per session runs at a time (an exclusive lock file, taken
  over when stale); a run that finds it held exits and the next Stop reads the
  text. The watermark moves only after a successful run, by temp file and
  rename, merged per session. The default filter model is `claude-haiku-5-5`.

## [0.3.0] - 2026-11-23

### Added

- Repeats and conflicts (#21). A statement that repeats an active item or a
  pending proposal from a new source is merged into it as evidence, with its
  own trust; only the owner's evidence raises support, and nothing merged
  activates a proposal. A statement that conflicts with an active item
  becomes a supersession the owner approves in `memory review`: the older
  item gets `valid_to` and the `superseded` status, keeps its text and
  evidence, and is no longer recalled. `memory remember --supersedes <id>`
  supersedes at once, and `memory undo <audit-id>` reverses a merge or a
  supersession. Notes may carry `at`, the time of their evidence, which
  decides which conflicting statement is newer. The import report counts
  `merged` and `supersessions`. No item is rewritten or deleted.
- `memory sweep`, and the same sweep at session start at most once a day per
  store: of two active items that repeat each other, the newer is queued as a
  supersession of the older in `memory review`. Nothing is applied. A
  conflict between items of different scopes supersedes nothing, and recall
  shows only the narrower scope's item when the two repeat or conflict, never
  when their numbers differ. A store above 1,000 active items is left to
  `memory sweep` at session start, which prints its slice first. A 200-statement labelled fixture
  checks the repeat and conflict bars of #21 offline.
- The `memory purge --source` preview and result list `returnedToProposedIds`,
  the id of every item returned to proposed, so a follow-up `--item` can
  reach it.

- The session slice in every context window: printed again, byte-identical,
  after a compaction (`SessionStart` with the `compact` matcher), and given
  to `general-purpose` subagents at their start (`SubagentStart`), resolved
  from the subagent's working directory and within 300 tokens.
  `subagentTypes` in `config.json` adds other agent types; `Explore`, `Plan`
  and Review Voice's agents never get it, and naming one is refused. Each
  item a subagent is shown is logged in `logs/injections.jsonl` by item id,
  with its anchored file paths, the session and agent ids and its estimated
  tokens, never its text.
- `memory eval`, the evaluation harness, prints scorecard rows with memory
  off and on: the review replay (restated owner-declined findings after a
  cut-off, with memory built only from the pull requests before it), the
  false-recall report from the injection log, and Orbit's benchmark arm.
  Each row states its bar, the capabilities on in its arm and its sample
  sizes. Orbit's arm, and Review Voice's seeded-defect recall beside the
  replay, report `not run` with the reason, since both need a model. The
  harness calls no model, posts nothing and never opens the memory store.
  The README documents the pull request file and the injection log format.
- `memory eval lab`, the session lab: six fixture tasks run by the agent
  command you name, memory's plugin off and on, three runs per arm, each in a
  temporary copy with its own data directory and graded by hidden tests the
  agent is never given. Rows report pass rate, tokens, cache reads, turns,
  memory's hook durations and the injection log. `lab/replay-agent.mjs`
  replays transcripts with no model, as CI does; `lab/claude-agent.mjs` runs
  real Claude Code on the owner's machine. `memory eval verdict` says whether
  auto memory may be switched off, only when the scorecard and the lab both
  show memory no worse, and changes no setting.

### Changed

- A `--source` purge cuts a rejected or expired item it touched to its hash,
  type and scope, without waiting 30 days; its text is gone from the files.
- A purge leaves no recoverable bytes. Every store is opened with SQLite's
  secure deletion, so deleted text is overwritten, and a store written before
  this release is rewritten once (`VACUUM`) on its next open. `memory purge`
  also takes `--item <id>` and `--source <ref>`: a source reaches only this
  repository's tenant and the person file, deletes that source's evidence,
  and returns an item left with none to proposed, or deletes it with
  `--with-derived`. The preview lists promoted checks built from an affected
  item. The injection log loses the lines of purged items, lines older than
  `--older-than`'s cut-off, and its file with `--all`; each line now carries
  its time. A purge's audit entry never names the source, and a purged
  item's own audit entries go with it.
- The consent plan has a version, and each kind of data it lists the
  version that added it. A consent covers only the kinds of data its plan
  listed: a newer one stays off, and `memory init` lists it and asks again,
  while the rest keep working. A consent from before the injection log
  leaves the log off until the owner confirms the plan again.
- An agent's `memory_feedback(id, stale)` no longer hides the item. It
  re-checks the item's citation at HEAD at once: a citation that fails makes
  the item stale, as the re-check would, and it comes back when the citation
  holds again. Otherwise the item stays active, and the report is counted and
  shown in `memory review`, where `memory approve` clears the reports and
  `memory reject` takes the item out. Any agent could otherwise suppress any
  item the owner approved. An item an agent hid before this change comes back
  active with one report counted.

## [0.2.0] - 2026-11-21

The second release: slices 1 to 4 of eighteen. Slices 5 to 18 are still to
come; the plan is tracked in
[#1](https://github.com/QuintinBotes/memory/issues/1). Installing the plugin
recalls nothing: memory stays off, at session start and in every tool, until
you run `memory init --confirm`, and goes off again whenever tenants,
bindings or opt-ins change until you confirm the new plan.

### Added

- Anchored items are re-checked against the file at HEAD before they are
  shown, at session start and in `memory list`. A deleted file (`path gone`)
  or cited lines no longer found within 50 lines of their place (`cited text
  gone`) make the item stale, out of recall, with the reason stored and an
  audit entry. Lines that moved keep the item active and move its anchor; the
  nearest copy wins, and each move is audited with the old and new lines. An
  uncommitted edit changes nothing. An item the re-check made stale comes
  back at the next session start once its citation holds again, so
  switching branches does not lose it. A bare clone is checked against its
  own HEAD; a repository with no HEAD, or a file git cannot read, changes
  nothing. (#3)
- `memory recheck [<id>]` checks this repository's anchored items, searching
  the whole file, restores those whose citation holds again, and lists the
  stale ones with their reason.
- An MCP server with four tools for agents (#5). `memory_search(query,
  paths?)` returns ranked rows of at most 60 estimated tokens, each with a
  `why` listing its points; `memory_get(id)` returns the item with its
  evidence and anchor status, as rows or JSON; `memory_propose` only
  proposes, storing the origin's trust (agent, team, external or bot, never
  owner); `memory_feedback(id, helped|wrong|stale)` changes only the counts
  behind confidence, or takes an item out of recall. No tool approves,
  rejects, purges or configures. An agent's stale report holds until the
  owner restores the item with `memory approve`, from the list in
  `memory review`.
- Text from a non-owner source that Orbit's authority rules read as an
  instruction is stored as a quarantined proposal: never searched, flagged in
  `memory review` and at approval, and counted by `memory import`.
- Confidence is computed on read and shown as low, medium or high; an item
  with no reinforcement for 90 days reads as expired and leaves recall.
- A full-text index of statements, with FTS5 secure-delete on (#23).
- `memory import [--dry-run]` reads the silos and stores each statement as a
  proposal, never active: the auto memory of every bound Claude Code config,
  and per repository checkout the review-standards file, the record of
  rejected retro proposals, a Review Voice policy file and a notes file, at
  paths set under `imports` in `config.json`. An auto memory statement goes to
  the tenant of the repository it names, if its own config is bound to that
  tenant, or to person scope when it is organisation-free; it carries agent
  trust, because a model wrote it with no approval step, and is stored with
  its file name and line, not the folder. A notes file also carries agent
  trust, because tools write it; the other silos carry owner trust. A
  rejected retro proposal arrives as a tombstone. Notes of kind `gotcha`,
  `invariant` and `decision` arrive with their symbol anchor; other kinds are
  counted and skipped. The report lists every file with its
  statement count, dangling index links, skipped files (such as a symbolic
  link out of its folder) and refused statements by source and reason, never
  by their text. A statement already known, or rejected before, is not
  proposed again. (#4)
- `memory review` lists the proposals of this repository's tenant and the
  person file, with their evidence, scope, trust and what the shadow gate
  would have decided. `memory approve <id> [--scope]` makes one active;
  `memory reject <id> [--reason]` keeps it as a tombstone. Both record the
  owner's decision beside the shadow gate's.
- Rejected and expired items are reduced to a hash of their statement, their
  type and their scope 30 days after rejection; the hash still blocks the
  statement.
- A person statement shaped like `owner/repo` is refused as not
  organisation-free, even when no tenant names that owner.

### Changed

- The session slice, `memory list`, `memory review` and every tool result sit
  inside one advisory fence that item text cannot close. `memory review`
  quotes each statement.

### Fixed

- Opening a store whose schema is behind migrates under a write lock, so two
  sessions upgrading at once no longer fail. git run by memory never waits on
  a credential prompt.
- `memory purge --older-than` no longer turns a rejected item back into a
  proposal.

## [0.1.0] - 2026-11-20

### Added

- A store per tenant: one SQLite file per tenant beside one person file. The
  tenant is resolved from the github.com `origin` remote through an allowlist,
  and each Claude Code config is bound to the tenants it may open. No match,
  two matches, another host or an unbound tenant means no tenant: only person
  and global items apply, and nothing tenant-scoped can be stored. (#2)
- `memory init` shows a consent plan (tenants, bindings, what is stored,
  where, retention, and the transcript and failing-command opt-ins, both off)
  and saves it with `--confirm`. Any later change to tenants, bindings or
  opt-ins makes memory inert until the new plan is confirmed.
- `memory remember` stores one active item with scope, type, optional anchor
  (path, lines, commit, cited-text hash) and source, with provenance evidence.
  It refuses credentials that match Review Voice's redaction patterns,
  private key headers, email addresses, handles in any case, webhook URLs and
  multi-line text, and refuses person and global items, their source
  included, that are not organisation-free (Orbit's code-free check, plus
  every tenant, owner and repository name of two or more characters).
- The `SessionStart` hook prints the visible items, one line each, ranked by
  scope, support and id, whole items only, within `sessionBudget` (300
  estimated tokens by default, 0 turns it off). The output is byte-identical
  for the same store, and the hook prints nothing on any error.
- `memory list` and `memory purge --tenant | --repo | --older-than | --all`,
  which previews first, deletes only with `--confirm`, returns items left
  without evidence to proposed, and keeps its audit entry.
- `/memory:remember`, which only the person can invoke.
- SECURITY.md: how to report a vulnerability, and what the isolation and the
  refusal do and do not protect. Node 22.13 or newer is required, where
  `node:sqlite` needs no flag.
- The repository: build, tests, CI on Ubuntu and macOS with Node 22 and 24,
  and the plugin and marketplace manifests.
