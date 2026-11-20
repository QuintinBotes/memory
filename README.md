# Memory

Local memory for Claude Code that never crosses organisations.

Memory keeps a small number of short, cited items: a preference you stated, a
convention a repository follows, a decision, a hazard in the code. It recalls
a few of them when they matter, inside a fixed token budget. Items are kept
per organisation (a "tenant"), one SQLite file each, so what you learned in
one client's repositories never reaches another organisation's work.

**Status: early.** Slice 1 of eighteen is in: the tenant-isolated store,
`remember`, and the slice printed at session start. The plan is tracked in
[#1](https://github.com/QuintinBotes/memory/issues/1), one issue per slice.

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

## Using it

Install it in Claude Code:

```
/plugin marketplace add QuintinBotes/memory
/plugin install memory@memory
```

Memory does nothing until you agree to a plan. In a terminal, name your
tenants and bind the current Claude Code config (`CLAUDE_CONFIG_DIR`, or the
default config) to the tenants it may open:

```bash
M="node ~/.claude/plugins/marketplaces/memory/dist/memory.mjs"   # or your config's plugin path
$M init --tenant 'personal=your-login/*' --tenant 'acme=acme/*' --bind personal,acme
$M init --tenant 'personal=your-login/*' --tenant 'acme=acme/*' --bind personal,acme --confirm
```

The first command prints the plan: tenants, bindings, what is stored, where,
and for how long. The second saves it. Changing tenants, bindings or opt-ins
later makes memory inert until you confirm the new plan.

Then, in a session, `/memory:remember Releases are cut from the main branch
only`, or from a terminal:

```bash
$M remember --scope repository --type convention -- "Releases are cut from the main branch only"
$M remember --scope person --type preference -- "Explain changes in plain English"
$M list
$M purge --repo acme/api            # preview; add --confirm to delete
```

Scopes: `repository` (this repository), `organisation` (every repository of
this GitHub owner), `person` (you, everywhere) and `global` (facts about the
tools). Person and global items must name no code, path, tenant or
repository. Anything carrying a secret, an email address, a handle or a
webhook URL is refused and never stored.

At session start, the items this repository and config may see are printed
in one line each, within `sessionBudget` estimated tokens (300 by default, 0
turns it off, set in `config.json` in the data directory).

An agent can run the command line itself. To be asked before it remembers
anything, add an ask rule such as `Bash(*memory.mjs remember*)` to your
Claude Code permissions.

Data lives in `~/Library/Application Support/claude-code-memory` on macOS,
`$XDG_DATA_HOME/claude-code-memory` (or `~/.local/share/claude-code-memory`)
on Linux, or wherever `MEMORY_DATA_DIR` points: `config.json`, one
`tenants/<name>.sqlite` per tenant, and `person.sqlite`.

## Recall budgets

| Moment | Budget |
|---|---|
| Session start, and after a compaction | 300 tokens |
| Start of an allowed subagent | 300 tokens |
| Reading or editing anchored code | 120 tokens per injection, 600 per agent per session |
| A failing command that matches a known failure | 120 tokens |
| A diff, at review or commit | 600 tokens |

A hook with nothing to say prints nothing. Only the session-start slice
exists so far; the other moments arrive with later slices.

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
