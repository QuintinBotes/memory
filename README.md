# Memory

Local memory for Claude Code that never crosses organisations.

Memory keeps a small number of short, cited items: a preference you stated, a
convention a repository follows, a decision, a hazard in the code. It recalls
a few of them when they matter, inside a fixed token budget. Items are kept
per organisation (a "tenant"), one SQLite file each, so what you learned in
one client's repositories never reaches another organisation's work.

**Status: early.** Slices 1 to 4 of eighteen are in: the tenant-isolated
store, `remember`, the slice printed at session start, the re-check of every
cited file and line before an item is shown, the import of what your
existing silos already hold, as proposals you approve, and four MCP tools
through which agents search, read, propose and give feedback. The plan is tracked in
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
- **You approve.** "Remember this" is active at once, and so is what automatic
  capture keeps from a session (see below); everything else memory proposes
  on its own, and any captured text that reads as an instruction, waits for
  your yes in a terminal. Changes that lower an
  item's influence (stale, contradicted, expired) happen on their own.
- **Small and cache-friendly.** Every recall has a budget, whole items are
  dropped rather than cut, and the session slice is byte-identical for the
  same store, so it never breaks the prompt cache.
- **Off until measured.** Each capability ships off and is turned on only when
  its on/off measurement shows it is no worse.
- **Hybrid recall.** Recall is lexical, vector and graph, behind a provider
  interface; the default provider is voyage-4. Vectors are kept in the
  tenant's own file. Without a key or a network, recall falls back to words
  and paths and says so.
- **Local where it counts.** The store never leaves this machine. What does
  leave is listed in [SECURITY.md](SECURITY.md): the text sent to the embedding
  provider, and, at the end of a session, the redacted transcript sent to the
  capture model. No runtime dependencies: both calls are a plain `fetch`. Node
  22.13 or newer, where `node:sqlite` needs no flag.

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
memory() { node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/memory/dist/memory.mjs" "$@"; }
memory init --tenant 'personal=your-login/*' --tenant 'acme=acme/*' --bind personal,acme
memory init --tenant 'personal=your-login/*' --tenant 'acme=acme/*' --bind personal,acme --confirm
```

The first command prints the plan: tenants, bindings, what is stored, where,
and for how long. The second saves it. Changing tenants, bindings or opt-ins
later makes memory inert until you confirm the new plan. A release that adds
a kind of data keeps it off until you run `memory init` again, which lists
what is new, and confirm; what you agreed to before keeps working.

Then, in a session, `/memory:remember Releases are cut from the main branch
only`, or from a terminal:

```bash
memory remember --scope repository --type convention -- 'Releases are cut from the main branch only'
memory remember --scope person --type preference -- 'Explain changes in plain English'
memory list
memory recheck                          # re-check anchored items, stale ones included
memory embed --backfill                 # embed active items that have no vector
memory sweep                            # queue merges of active repeats for review
memory purge --repo acme/api            # preview; add --confirm to delete
```

A purge also takes `--item <id>`, or `--source <ref>` for everything learned
from one source, such as a pull request URL. `--source` reaches only this
repository's tenant and the person file: evidence from the source is
deleted, and an item left with none returns to proposed, or with
`--with-derived` is deleted too. The preview lists any promoted check built
from an affected item, for you to review; memory does not edit it, and it
lists the id of every item that would return to proposed, so a follow-up
`--item` can reach it. A rejected or expired item the source touched is cut
to its hash, type and scope at once, so its text is gone but the statement is
still not proposed again. Every
store is opened with secure deletion, so what a purge deletes is overwritten
and cannot be read back from the files memory keeps; a store written by an
earlier version is rewritten once when it is next opened. Backups, file-system
snapshots and swap are outside memory's reach.

Scopes: `repository` (this repository), `organisation` (every repository of
this GitHub owner), `person` (you, everywhere) and `global` (facts about the
tools). Person and global items must name no code, path, tenant or
repository. Anything carrying a credential that matches a known pattern, a
private key header, an email address, a handle or a webhook URL is refused
and never stored. Pattern matching cannot recognise a credential that does
not look like one (see [SECURITY.md](SECURITY.md)).

An item anchored with `--anchor path:start-end` is re-checked against the
file at HEAD before it is shown. If the file is gone, or the cited lines are
no longer within 50 lines of where they were, the item goes stale and is not
shown; if they moved, the anchor follows them, and the move is audited. An
uncommitted edit changes nothing. A stale item comes back by itself at the
next session start once its citation holds again, for example when you
switch back to a branch where it holds. `memory recheck` lists the stale
items with the reason, searches the whole file rather than 50 lines, and
restores what holds.

At session start, the items this repository and config may see are printed
in one line each, within `sessionBudget` estimated tokens (300 by default, 0
turns it off, set in `config.json` in the data directory). The same bytes are
printed again after a compaction, which summarises the first copy away, and
at the start of a `general-purpose` subagent, which never saw it, as context
for that subagent, resolved from its own working directory. A subagent's
slice is chosen within 300 tokens, so with a `sessionBudget` above 300 it
holds fewer items than the session's. To give the slice to other subagent types, such as an editing agent,
list them in `config.json`: `"subagentTypes": ["my-plugin:implementer"]`.
`Explore`, `Plan` and Review Voice's agents never get it, not even in a
session started as one with `--agent`, and naming one there is refused. Each item a subagent is shown is logged in
`logs/injections.jsonl` in the data directory, by item id with its anchored
file paths, the session and agent ids, its estimated tokens and the time,
never its text. A purge removes the lines of the items it deletes;
`--older-than` removes lines older than its cut-off, and `--all` the file.

An agent can run the command line itself. To be asked before it remembers
anything, add an ask rule such as `Bash(*memory.mjs*remember*)` to your
Claude Code permissions.

Data lives in `~/Library/Application Support/claude-code-memory` on macOS,
`$XDG_DATA_HOME/claude-code-memory` (or `~/.local/share/claude-code-memory`)
on Linux, or wherever `MEMORY_DATA_DIR` points: `config.json`, one
`tenants/<name>.sqlite` per tenant, and `person.sqlite`.

## Importing what you already have

`memory import --dry-run` lists every file it would read with the number of
statements each holds, the index links that point at nothing, and what it
would refuse; `memory import` stores each statement as a proposal. It reads
the auto memory of every Claude Code config bound in the plan (one statement
per topic file, its `description`, and the list items of an index that are
not links), and, for each checkout listed under `imports` in `config.json`,
the files you name there:

```json
"imports": {
  "/path/to/acme-api": {
    "standards": ".stack/review-standards.md",
    "rejections": ".git/stack/retro-rejected.jsonl",
    "policy": ".review-voice/policy.yaml",
    "notes": "notes.jsonl"
  }
}
```

A notes file holds one JSON object per line, `{"kind": "gotcha", "text":
"...", "symbol": "path#qualified_name#kind"}`; only `gotcha`, `invariant` and
`decision` notes are imported. A line of the rejections file arrives as a
tombstone. An auto memory statement goes to the tenant of the repository it
names, as `owner/repo`, when the config it came from is bound to that tenant,
or to person scope when it is organisation-free; anything else is reported
and not stored. Auto memory and notes carry agent trust, since a model or a
tool wrote them; standards, rejections and policies carry owner trust. A
statement with agent trust that reads as an instruction arrives quarantined
(see below), and the report counts it.

```bash
memory review                          # proposals for this repository's tenant and you
memory approve m-1a2b3c4d5e            # add --scope organisation to widen it
memory reject m-1a2b3c4d5e --reason 'too broad'
```

A rejected statement is kept as a tombstone and never proposed again; after
30 days only its hash, type and scope remain. Approve and reject are terminal
commands. To be asked before an agent runs one, add ask rules such as
`Bash(*memory.mjs*approve*)` and `Bash(*memory.mjs*reject*)`.

## Repeats and conflicts

Nothing is stored twice, and nothing is rewritten or deleted. When a statement
arrives (`remember`, an import, `memory_propose`) it is compared with the
active items and pending proposals of the same type and scope, by its
normalised text, word overlap and cited files:

- **A repeat** (same words, same file or no file) from a new source is merged
  into the item or proposal as evidence, and the owner is not asked again.
  Evidence keeps its own trust (`owner`, `agent`, `external`, `bot`); only
  your own evidence raises `support`, and merged evidence never activates a
  proposal. The same words anchored in different files are a new statement.
  A repeat of a rejected statement is still dropped.
- **A conflict** (mostly the same subject, different words) becomes a
  supersession: an agent's or an import's statement is a proposal that names
  the older item, and `memory review` shows both statements with their
  evidence. `memory approve` makes the new one active and ends the older
  item's validity: it gets `valid_to` and the `superseded` status, is no
  longer recalled, and `memory_get` names its successor. Its text and evidence
  stay. `memory reject` on a supersession of an active item keeps both.
- `memory remember --supersedes <id> -- <statement>` replaces an item at
  once. `remember` without it, on a conflict, is active and queues the
  supersession.
- An imported note's `at` (when the evidence happened) decides which of two
  conflicting statements is newer, not when memory captured it: older
  evidence arrives already superseded by the active item.
- A conflict across scopes (a repository decision against an organisation
  one, a person preference against a repository one) supersedes nothing: both
  stay, and recall shows only the narrower scope's item, unless the two
  differ in a number ("Step 1" and "Step 2" are different rules).
- `memory sweep` runs the same matching over the active items of this
  repository's tenant and the person file, and queues the newer of two
  repeats as a supersession of the older, which `memory review` shows. It
  applies nothing. The session start runs it after printing the slice, at most once a day
  per store and only for a store of up to 1,000 active items; there is no
  background process.
- Each merge and supersession prints an audit id; `memory undo <audit-id>`
  reverses it.

## Automatic capture

At Stop and SessionEnd a hook runs `memory capture`. It hands the work to a
detached process and returns at once, and it never fails the session. The
process reads the session transcript (user and assistant text, newest 48,000
characters, and at a Stop only once 4,000 new characters have come in), takes
credentials, emails, handles and webhook URLs out of it, and asks a small model
for lessons and decisions only: one sentence each, with the transcript line
that shows it. At most `maxCandidates` (5) are kept per run.

Each kept statement goes through the repeat and conflict matcher above: a
repeat adds evidence (agent evidence never raises support), a conflict becomes
a supersession proposal, and a new one is saved active with agent trust and
the session, agent `claude-code` and transcript name as its source. Text that
reads as an instruction is quarantined as any non-owner proposal is. A
repository that matches no tenant is skipped: no model call, nothing written.

- **What leaves the machine:** the redacted transcript text, to
  `api.anthropic.com`, and nothing else. Redaction is pattern based, so a
  secret that does not look like one (a password in prose) is not caught.
- **The key:** `ANTHROPIC_API_KEY` in the environment of Claude Code. Without
  it capture reports the missing key and does nothing.
- **Cost:** one call per SessionEnd and per Stop with enough new text; each
  run's tokens go to `logs/capture.jsonl` in the data directory (never the
  transcript). Read it to see what capture costs you.
- **Consent:** capture is a data category of the consent plan. `memory init`
  proposes it on, but a consent given before it stays off for it until you run
  `memory init` and confirm.
- **Off:** `"capture": { "enabled": false }` in `config.json`.

```json
{ "capture": { "enabled": true, "model": "haiku", "maxCandidates": 5, "apiModel": "claude-haiku-5-5" } }
```

`model` is `haiku` (the Messages API by plain `fetch`, no SDK) or `fake`, the
deterministic filter the tests use; `apiModel` is the Claude Haiku alias.

## What agents can do

The plugin runs an MCP server with four tools. None of them can approve,
reject, purge or change the configuration, and nothing they write is active.

- `memory_search(query, paths?)` returns at most 10 rows,
  `[id] type · name path:line · statement (source) · why: points`, each at
  most 60 estimated tokens; a long statement is cut in the row. An item is a
  hit only when it shares an anchored path or words with the search. Its
  score is a fixed sum: 4 per anchor in the paths (at most 8), scope
  (repository 2, organisation or person 1, global 0.5), full-text relevance up
  to 2 (none below 20% of the best match), confidence up to 2, and minus 1 per
  contradiction. Ties go to support, then id. `why` lists every point.
  With embeddings (below) the sum gains two parts: `semantic`, up to 4 points
  for the cosine of the item's vector with the query's (nothing under 0.35, so
  a close vector alone makes an item a hit), and `graph`, 1 point for an item
  sharing an anchored path with one of the three best hits, which may enter
  the results that way. Both are provisional until the evaluation slice
  tunes them. Budgets, the 10-row limit and the advisory fence do not change.
- `memory_get(id, format?)` returns one item whole, with its evidence and
  anchor status, as rows or as JSON with `format: "json"`.
- `memory_propose(statement, scope, type, evidence)` stores a proposal for
  `memory review`. `evidence` is `{source, origin}`, where origin is `agent`
  (the default), `team`, `external` or `bot`; only your own `remember` gives
  owner trust. A proposal that Orbit's authority rules read as an instruction
  ("always skip tests") is quarantined: never searched, shown in review with
  the rule that flagged it, and active only if you approve it.
  `test/poison.test.mjs` is the standing red-team suite for these gates (see
  SECURITY.md); it runs in CI on every pull request.
- `memory_feedback(id, helped|wrong|stale)` changes only the counts behind an
  item's confidence. `stale` re-checks the item's citation at HEAD at once: if
  it fails, the item goes stale as the re-check would make it, and comes back
  when the citation holds again. Otherwise the item stays active, because an
  agent's word alone must not hide what you approved, and `memory review`
  lists it with the number of reports: `memory reject` takes it out,
  `memory approve` clears the reports.

## Embeddings

`memory_search` embeds its query and compares it with the vectors of the
items it may see. Embeddings come from a provider named in `config.json`:

```json
"embeddings": { "provider": "voyage", "model": "voyage-4" }
```

`voyage` (the default) calls Voyage AI's embeddings endpoint with
`VOYAGE_API_KEY` from the environment of the process; `fake` is a
deterministic offline provider for tests. Changing the key swaps the provider
with no code change; a vector from another model is not used until
`memory embed --backfill` embeds the item again. Each vector sits in the
same SQLite file as its item, with its model and size, and a purge deletes it
with the item. `remember` and `memory approve` embed the item they make
active; a proposal is embedded only when approved, and an item flagged as
reading like an instruction never is. `memory embed --backfill` embeds every
active item that has no vector.

Embeddings are part of the consent plan: they stay off until you run
`memory init` and confirm it. With no key, no network, or no vectors, search
ranks by words and paths as before and prints one line saying embeddings were
not used and why. A search waits at most 1.5 seconds for the provider. The
session-start slice has no query and never calls it. Similarity is computed in
memory over the tenant's vectors, which is fine to about 50,000 items.

Confidence is computed on read as `min(1, 0.5^(age/90 days) × 1.1^helped ×
0.8^wrong)`, age counted from the last approval, `remember` or `helped`, and
shown as low (below 0.4), medium or high (0.7 or more). These constants are
provisional until the evaluation slice
([#8](https://github.com/QuintinBotes/memory/issues/8)) tunes them. An item
with no reinforcement for 90 days reads as expired and leaves every recall.

Everything memory renders sits inside one fence, `~~~text memory...`, that
item text cannot close: each item is one line, invisible characters are
removed and any run of backticks or tildes is broken. `memory review` shows
each proposal's statement in quotes.

## Recall budgets

| Moment | Budget |
|---|---|
| Session start, and after a compaction | 300 tokens |
| Start of an allowed subagent | 300 tokens |
| Reading or editing anchored code | 120 tokens per injection, 600 per agent per session |
| A failing command that matches a known failure | 120 tokens |
| A diff, at review or commit | 600 tokens |

A hook with nothing to say prints nothing. The slice at session start, after
a compaction and at a subagent's start exists so far; the other moments
arrive with later slices.

## Measuring memory

Memory stays off by default until it measures no worse. `memory eval` prints
scorecard rows, one JSON object per line, each measure with memory off and on.
Every row carries the plugin version, the capabilities on in its arm
(`switches`), its sample sizes and its bar. A measure that cannot run says
`not run` and why; it never carries a number. The harness calls no model,
posts nothing, never opens the memory store, and prints the same rows for the
same inputs.

```bash
memory eval replay --since 2026-03-01 --pulls pulls.json
memory eval false-recall --log injections.jsonl
memory eval orbit
memory eval --since 2026-03-01 --pulls pulls.json --log injections.jsonl   # every row
```

| Measure | What it counts | Bar |
|---|---|---|
| `review-replay` | Findings after the cut-off that restate one the owner declined. Memory is built only from pull requests reviewed before it, and a repeat is held when a search for its statement and path, ranked as `memory_search` ranks, returns the declined item | Repeats halved |
| `review-voice-seeded-recall` | Reported beside the replay. Not run: it needs Review Voice's reviewer, a model | Unchanged with memory on |
| `false-recall` | Recalled items later marked wrong or stale, or anchored where nothing under the anchor was touched later in that session | Under 10% |
| `orbit-benchmark` | Pass rate, cost per accepted task, false-done rate and attempts to first green, three runs per goal. Not run until Orbit's benchmark has a memory switch ([orbit#233](https://github.com/QuintinBotes/orbit/issues/233)); it says whether Orbit is installed | No fall in pass rate, no rise in cost |

The replay reads pull requests from a JSON file. `restates` labels a finding
that says again what an earlier one said, naming the finding that first said
it, so repeats are counted without a model:

```json
{"pulls": [{"number": 12, "reviewed_at": "2026-03-04", "findings": [
  {"id": "12-1", "path": "src/ledger.ts", "statement": "consume runs without the lock", "owner": "declined"},
  {"id": "12-2", "path": "src/api.ts", "statement": "...", "owner": "accepted", "restates": "9-1"}]}]}
```

The false-recall report reads the injection log: one JSON object per line, in
the order things happened. The subagent hook writes its `injected` events
already; the recall hooks will add `touched` events (slice 10), and until then
a log without them judges every anchored recall untouched, so a fixture
stands in. It reads three events and ignores other fields and
other events; the session lab also sums an `injected` event's `tokens`, its
estimated tokens, when present:

```json
{"event": "injected", "session": "s1", "item": "m-1a2b3c4d5e", "via": "session-start", "anchors": ["src/ledger.ts"]}
{"event": "touched", "session": "s1", "paths": ["src/ledger.ts"]}
{"event": "feedback", "session": "s2", "item": "m-1a2b3c4d5e", "signal": "wrong"}
```

### The session lab

Orbit's workers load no hooks, so what memory delivers through a hook is
measured in the session lab. `memory eval lab` runs each fixture task under
`lab/tasks` with memory's plugin off and on, three runs per arm, and grades
each run with the task's hidden tests, run only after the agent exits and
never given to the agent: not in its directory, its environment or its
plugin copy. Each run gets a temporary copy of
the task's repository and its own empty data directory; on the on arm that
directory is consented and holds the task's items, so no run reads or writes
your store. The six tasks: a seeded hazard on a symbol the task must change
(`hazard-change`) and on one it must not (`hazard-keep`), the
[orbit#133](https://github.com/QuintinBotes/orbit/issues/133) environment
(`failure-env`), a task long enough to compact (`compaction`), one that
spawns a subagent (`subagent`), and a change-reach task (`change-reach`).

```bash
# Run from a memory checkout. The agent runs in each run's copy, so its paths are absolute: $PWD expands here.
memory eval lab --model claude-sonnet-5 --agent "node $PWD/lab/claude-agent.mjs"    # real Claude Code: a login, a model, money
memory eval lab --task hazard-change --model fixture --agent "node $PWD/lab/replay-agent.mjs $PWD/test/fixtures/lab"   # no model
memory eval verdict --scorecard scorecard.jsonl --lab lab.jsonl
```

The lab runs only the agent command you name, under `/bin/sh` in the run's
copy, with the prompt on stdin and `MEMORY_LAB_TASK`, `MEMORY_LAB_ARM`,
`MEMORY_LAB_RUN`, `MEMORY_LAB_MODEL`, `MEMORY_LAB_OUT` and, on the on arm,
`MEMORY_LAB_PLUGIN` (a copy of the plugin without the lab) in its
environment. Its stdout is read as Claude Code's `stream-json`: tokens, cache
reads and turns come from the `result` line's `modelUsage` and `num_turns`.
Hook durations come from `$MEMORY_LAB_OUT/session.jsonl`, the session
transcript Claude Code keeps, from its `hook_success` records of memory's
own hooks. A run whose agent exits non-zero counts as failed, and then the
task's bar is not judged (`meets_bar` is null) until the lab runs again.
`lab/claude-agent.mjs` removes each run's project folder from your Claude
Code config afterwards, so nothing a run wrote there reaches `memory import`. Each task row
reports pass rate, mean input and cache-read tokens and turns, hook counts
and 95th percentiles, and the `injected` events memory's injection log
recorded in the run, with their summed `tokens`; its bar is a pass
rate with memory on no lower than off.

`lab/replay-agent.mjs` stands in for Claude Code and calls no model, which is
how CI runs the lab. It replays a transcript per task and arm, one JSON
object per line: `attachment` records go to `session.jsonl`, every other line
is printed as a `stream-json` event, and each `Write` and `Edit` tool call in
an `assistant` event is applied to the working directory. Recorded
transcripts replay too: absolute paths are re-rooted from the `cwd` of the
`system` init event, and no path may leave the working directory.

`memory eval verdict` reads `memory eval`'s rows and the lab's, and prints
`auto memory may be switched off in <config>` only when each shows memory no
worse: at least one measured row that holds its bar, and none that misses
it. Otherwise it names the measure and arm that missed. It changes no
setting; you do.

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
