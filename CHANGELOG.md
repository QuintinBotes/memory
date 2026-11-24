# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
