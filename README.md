# Memory

Local memory for Claude Code that never crosses organisations.

Memory keeps a small number of short, cited items: a preference you stated, a
convention a repository follows, a decision, a hazard in the code. It recalls
a few of them when they matter, inside a fixed token budget. Items are kept
per organisation (a "tenant"), one SQLite file each, so what you learned in
one client's repositories never reaches another organisation's work.

**Status: under construction.** Nothing is usable yet. The plan is eighteen
slices, each one issue with testable acceptance scenarios, tracked in
[#1](https://github.com/QuintinBotes/memory/issues/1). Slice 1 is the
tenant-isolated store, `remember`, and the slice printed at session start.

## Principles

- **Evidence, not self-written notes.** An item is a one-sentence statement
  with its source: a comment link, a commit, a run, or you saying "remember
  this". A growing file of notes the model writes for itself is not a goal.
  The production coding memory with a published gain
  ([GitHub Copilot's](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/))
  cites code, re-checks it and expires.
- **Isolated by tenant, failing closed.** The tenant comes from the git
  remote's owner through an allowlist you write, for example
  `{"personal": ["your-login/*"], "acme": ["acme/*"]}`. A repository that
  matches no tenant gets your person-scope items only, and nothing is captured
  from it. Each Claude Code config is bound to the tenants it may open.
- **Advisory only.** Items are shown as cited facts inside a fence their text
  cannot close. Memory never blocks a tool call, grants a permission or skips
  a check.
- **You approve.** Only "remember this" is active at once. Everything memory
  proposes on its own waits for your yes in a terminal. Changes that lower an
  item's influence (stale, contradicted, expired) happen on their own.
- **Small and cache-friendly.** Every recall has a budget, whole items are
  dropped rather than cut, and the session slice is byte-identical for the
  same store, so it never breaks the prompt cache.
- **Off until measured.** Each capability ships off and is turned on only when
  its on/off measurement shows it is no worse.
- **Local.** No network calls at read time, no model at read time, no runtime
  dependencies. Node 22 or newer.

## Recall budgets

| Moment | Budget |
|---|---|
| Session start, and after a compaction | 300 tokens |
| Start of an allowed subagent | 300 tokens |
| Reading or editing anchored code | 120 tokens per injection, 600 per agent per session |
| A failing command that matches a known failure | 120 tokens |
| A diff, at review or commit | 600 tokens |

A hook with nothing to say prints nothing.

## Code anchor providers

Items can be anchored to code. Memory ships a provider that anchors by path,
line range and a hash of the cited text. A code graph can plug in through a
small interface: a stable key per symbol, the symbol enclosing a line, what
changed between two snapshots, what a change reaches, and the tests that
prove a symbol. When a provider proves anchored code is identical after a
move or rename, memory moves the anchor and logs the move so it can be undone.

## Development

```bash
npm install     # dev tooling only; the plugin ships with zero dependencies
npm run verify  # typecheck, bundle drift, tests, identity guard, action pins
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT. See [LICENSE](LICENSE).
