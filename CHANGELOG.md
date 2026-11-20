# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `memory import [--dry-run]` reads the silos and stores each statement as a
  proposal, never active: the auto memory of every bound Claude Code config,
  and per repository checkout the review-standards file, the record of
  rejected retro proposals, a Review Voice policy file and a notes file, at
  paths set under `imports` in `config.json`. An auto memory statement goes to
  the tenant of the repository it names, if its own config is bound to that
  tenant, or to person scope when it is organisation-free; it carries agent
  trust, because a model wrote it with no approval step. The other silos carry
  owner trust. A rejected retro proposal arrives as a tombstone. Notes of kind
  `gotcha`, `invariant` and `decision` arrive with their symbol anchor; other
  kinds are counted and skipped. The report lists every file with its
  statement count, dangling index links, skipped files (such as a symbolic
  link out of its folder) and refused statements by source and reason, never
  by their text. A statement already known, or rejected before, is not
  proposed again. (#4)
- `memory review` lists the proposals of this repository's tenant and the
  person file, with their evidence, scope, trust and what the shadow gate
  would have decided. `memory approve <id> [--scope]` makes one active;
  `memory reject <id> [--reason]` keeps it as a tombstone. Both record the
  owner's decision beside the shadow gate's.
- Rejected and expired items are reduced to a hash of their statement and
  their type 30 days after rejection; the hash still blocks the statement.

### Fixed

- `memory purge --older-than` no longer turns a rejected item back into a
  proposal.

## [0.2.0] - 2026-11-20

### Added

- Anchored items are re-checked against the file at HEAD before they are
  shown, at session start and in `memory list`. A deleted file (`path gone`)
  or cited lines no longer found within 50 lines of their place (`cited text
  gone`) make the item stale, out of recall, with the reason stored and an
  audit entry. Lines that moved keep the item active and move its anchor; the
  nearest copy wins, and each move is audited with the old and new lines. An
  uncommitted edit changes nothing. A stale item comes back at the next
  session start once its citation holds again, so switching branches does
  not lose it. A bare clone is checked against its own HEAD; a repository
  with no HEAD, or a file git cannot read, changes nothing. (#3)
- `memory recheck [<id>]` checks this repository's anchored items, searching
  the whole file, restores those whose citation holds again, and lists the
  stale ones with their reason.

### Fixed

- Opening a store whose schema is behind migrates under a write lock, so two
  sessions upgrading at once no longer fail. git run by memory never waits on
  a credential prompt.

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
