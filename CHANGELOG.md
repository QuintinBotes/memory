# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
