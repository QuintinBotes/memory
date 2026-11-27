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
existing silos already hold, as proposals you approve, and five MCP tools
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
- **Measured before it is on.** Automatic capture is on by default (decision
  #43); every other capability ships off and is turned on only when its on/off
  measurement shows it is no worse. The semantic leg and the reranker (#28)
  are off until you name a model for them.
- **Hybrid recall, opt-in.** A semantic leg, behind a provider interface, is
  fused with the keyword ranking when you name an embedder in `config.json`
  (off by default; a local Ollama is the one a tenant may use), and a local
  generative model may rerank the top rows (#28). Vectors are kept in the
  tenant's own file. Without it, recall uses words and paths and,
  when the leg was asked for, says why it was skipped.
- **Local where it counts.** The store never leaves this machine. What does
  leave is listed in [SECURITY.md](SECURITY.md): the text sent to the embedding
  provider; at the end of a session, the redacted transcript sent to the
  capture model; and, when you run `memory export --to scf`, a tenant's
  proposals with their evidence sent to the SCF address configured for that
  tenant. No runtime dependencies: every call is a plain `fetch`. Node
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

`memory init` refuses a data directory on a network file system (NFS, SMB, AFP
and similar), because SQLite's locking is not reliable there; point
`MEMORY_DATA_DIR` at a local disk.

Then, in a session, `/memory:remember Releases are cut from the main branch
only`, or from a terminal:

```bash
memory remember --scope repository --type convention -- 'Releases are cut from the main branch only'
memory remember --scope person --type preference -- 'Explain changes in plain English'
memory list
memory list --repo acme/web             # that repository's items, its owner's organisation items, and person/global items learned in it
memory list --all-repos                 # every item of the tenant bound here, and the person file
memory recheck                          # re-check anchored items, stale ones included (skips if another refresh is running)
memory embed --backfill                 # embed active items that have no vector
memory sweep                            # queue merges of active repeats for review
memory purge --repo acme/api            # preview; add --confirm to delete
```

A purge of `--repo` also deletes the person and global items learned in that
repository (the preview counts them under `person.sqlite`); items of unknown
origin are never touched by it. A purge also takes `--item <id>`, or `--source <ref>` for everything learned
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

### Recall at the point of action

Off by default. With `"pointOfAction": true` in `config.json`, a `PreToolUse`
hook on Read, Edit, Write, MultiEdit and NotebookEdit adds the items anchored
where the call lands, as context before the tool runs. A Read matches the
lines it reads (the whole file when it reads all of it), an Edit the lines of
its `old_string`, and a Write or NotebookEdit the whole file, including a new
file under a directory anchor. If the file changed since the item was
anchored, so its line numbers mean nothing, a Read matches the whole file's
items and an Edit the symbols its `old_string` names. Each item is shown once
per agent per session, a subagent counting as its own agent, within 120
tokens per injection and 600 per agent per session; `Explore`, `Plan` and
Review Voice's agents get nothing. The hook never returns a permission
decision and prints nothing for code with no anchored item. The lookup is
local (the file's repository, its tenant, the tenant's active items), with no
model, network or code anchor provider. If the store is busy past 250 ms, the
hook prints nothing and logs a `skipped` line. Each injection is logged in
`logs/injections.jsonl` as for a subagent. The ledger of what was shown lives
in the tenant's file, by item id, and goes with the item on a purge. With the
switch on, anchored items leave the session-start slice, which keeps the
unanchored ones and a count of the anchored. `PreCompact` prints at most 1,000
characters of the items shown this session, and a session start after a
compaction lets the main agent be shown its items again. Edits made through
Bash bypass the hook; diff recall still sees them at review.

### Recall at a failing command

No switch and no extra consent: it stores no error text. A `PostToolUseFailure`
hook on Bash shows the active `failure-pattern` and `repair-recipe` items whose
signature the error carries, beside the error, within 120 tokens. An item's
signature is its statement up to ` => `, or all of it without one, so write a
recipe as `ERR_MODULE_NOT_FOUND esbuild => run npm ci in the repository root`.
It matches when all its words are in one normalised line of the error's last
2,000 lines, whether or not the line reads as an error (`ENOSPC: no space left
on device`, `command not found`, `npm ERR! code`). Words are compared after
Unicode normalisation; placeholders of normalised lines (paths, numbers,
times, hashes) and the words error, failed, fail, warning, exit and code do not
count, and a signature with fewer than two other words matches nothing
(`memory remember` says so for these types).

The error is also fingerprinted with a copy of Orbit's failure fingerprint
(line selection, normalisation and silent-failure fallback as Orbit's at
6407296). One difference: Orbit hashes its check's id into the fingerprint, and
a Bash command has none, so the id is fixed to `bash`; a fingerprint here
never equals one Orbit stored for another check. The fingerprint and the item
id make the ledger key: each item is shown once per agent per fingerprint, so a
newly added item can still show. A recipe whose evidence has a source with the
token `passed-after:<ref>` (the command passed after the fix at that ref) is
labelled `(verified)`; no other text, such as "not passed", sets it.

An item shown for a fingerprint that fails again, in the same session by the
same agent, counts once as a contradiction of that item for the session. A
repeat in a later session adds nothing. An interrupted command prints
nothing. The hook reads first and takes the write lock only to show an item or
count a contradiction. The ledger holds the fingerprint's hash and item ids,
never the error, and goes with an item on a purge. Shown items are logged by
id as for point-of-action recall.

An agent can run the command line itself. To be asked before it remembers
anything, add an ask rule such as `Bash(*memory.mjs*remember*)` to your
Claude Code permissions.

Data lives in `~/Library/Application Support/claude-code-memory` on macOS,
`$XDG_DATA_HOME/claude-code-memory` (or `~/.local/share/claude-code-memory`)
on Linux, or wherever `MEMORY_DATA_DIR` points: `config.json`, one
`tenants/<name>.sqlite` per tenant, and `person.sqlite`.

### Failures and reverts become proposals

A fixed failure is worth remembering, so memory proposes it. These are always
proposals: `memory review` and `memory approve` as ever.

- `memory ci` reads this repository's runs with `gh run list`. A failed run
  followed by a passing run on another commit (same workflow and branch) gives
  a repair recipe whose evidence names the fingerprint, the fix commit and both
  runs (`passed-after:<sha>`). Its signature is one line of the failed log,
  scrubbed of credentials, emails, handles and the repository's committers'
  names, and normalised; no line fit to recall by means no proposal. A failure
  with no later pass gives nothing.
- `memory import --orbit` proposes the same for a check Orbit's observations
  show failing and then passing. Orbit stores a fingerprint hash, not error
  text, so these are keyed by it: they are recalled only through
  `memory recall --orbit` (by fingerprint or check), never at a Bash failure.
- `memory init --transcripts on --confirm` is a separate opt-in, off by default: memory records each
  session's transcript path, and at the next session start turns your corrections in it into proposals that
  quote your words verbatim (see the consent plan). A session outside every tenant is recorded in the person
  file, and a correction about your own habits there becomes a person proposal; one that names a path, code
  or a repository is not kept.
- `memory corrections` is an offline model pass over those transcripts, never run by a hook and off unless
  `transcriptModel` is set in `config.json`: `{"transcriptModel": {}}` uses a local Ollama at
  `http://127.0.0.1:11434` and the model `inkling-2-mini` (Inkling 2 Mini), which you install with Ollama;
  memory never downloads a model. `url` and `model` change them, and `command` names a program speaking the
  [provider protocol](docs/provider.md) (op `corrections`) in place of memory's own Ollama client. Only a quote
  found verbatim in your own redacted message is kept. A tenant's messages go only to a model at 127.0.0.1,
  localhost or [::1]; with any other address the pass runs for the person file only, and says so. The first
  failure, time-out (120 seconds) or oversized answer ends the run.
- `memory init --failing-commands on --confirm` is a separate opt-in, off by
  default. With it, a failed Bash command is kept as an episode (scrubbed error
  line, the command's program and subcommand only such as `npm run build`, never
  its arguments, flags, paths or environment, a hash of that and the directory
  it ran in, fingerprint, session, HEAD) for 30 days, and the same command in the
  same directory passing later in that session, after a new commit, becomes a
  proposal with `passed-after:<sha>`. A pass at the commit it failed at is a retry,
  not a repair: no proposal, and the episode stays open. User names and home
  directories are normalised out of every kept line. Pushes, commits, `gh pr`, `gh issue`,
  `gh api` and memory's own commands are never captured. With it off, nothing
  from a session command is stored.
- Commits and reverts need no opt-in. A `git commit` is linked to the items shown
  in that session (at a failing command or at the point of action). A revert of
  that commit counts as a contradiction of each, once per session however many
  of its commits are reverted, and a revert that is itself reverted takes it back.
  Only a commit by the local git user whose subject is `Revert "..."` (or git's
  `Reapply "..."`) and whose body names the hash counts, and only a command that
  is a `git revert` triggers the scan. Two such reverts first seen less than
  seven days apart turn recall off in every recall path (the hooks, `memory_search`,
  `memory_get`, `memory_related`, `memory recall`, `memory related`); proposing and
  feedback still work. Memory says why, `memory init` repeats it and
  `memory init --recall on` turns it back on. `memory reverts` scans on demand,
  for reverts made outside a session.

The `PostToolUse` hook on Bash runs after every command: it opens no store for
one that is not a `git commit`, a `git revert` or (with the opt-in) a command
with an open episode, and takes the write lock only to write.

## Filtering by repository

Every item records the repository it was learned in (`origin_repository`,
`owner/repo`, empty when unknown). `remember`, `capture`, `memory_propose` and
`memory import` fill it from the repository they ran in; a person or global
item remembered outside a github.com checkout has none, a person or global
statement taken in by `memory import` from a silo has none (a silo names no
repository), and items stored before schema 14 keep none, except repository
items, which take it from their scope. An item with no origin is never reached
by `--repo` or `purge --repo`; `--all-repos` lists it.

`memory list` and `memory export --markdown` take `--repo <owner/repo>` for that
repository's items, its owner's organisation items and the person and global
items learned in it, or `--all-repos` for everything in the tenant bound here
plus the person file. They exclude each other; without either, behaviour is as
before. `memory_search` takes the same as an optional `repository`; paths are
then not matched against anchors, and the result says so.

Only a repository of the tenant bound to the current checkout can be named:
`matchingTenants` must return exactly that tenant. A repository of another
tenant, one that matches no tenant, or a checkout with no tenant is refused
before any store is opened, and `--all-repos` never opens another tenant's file.
In recall, a person or global item learned in the current repository gains
0.5 (`this repository` in `why`); unknown origins gain nothing.

## Reading memory as files

`memory export --markdown <dir>` writes this repository's tenant and the person
file as Markdown: `index.md` lists every item by status, and `items/<id>.md`
holds one item with its type, scope, status and why, trust, validity dates,
anchors, evidence with its trust, and supersession links. The same store gives
the same bytes, so two exports diff to exactly what changed. Every string is a
code span, so a viewer never turns it into a link or HTML. The text of a
quarantined item is withheld, a tombstone shows its hash and type, and vectors
are not exported. The folder is read only: nothing reads it back, and editing
it changes nothing in memory. Export needs confirmed consent, and refuses a
folder inside a git repository that belongs to another tenant.

## Moving proposals to SCF and back

Memory's items are shaped like Swarm Code Factory's world facts, so SCF can later
be the backend. `memory init --scf <tenant>=<url> --confirm` sets the SCF a tenant
may send to (https, or http to this machine; no credentials in the address; the
key is `SCF_API_KEY`, never stored). Without an address a tenant sends nothing.
`memory export --to scf [--repo <owner/repo> | --all-repos]` posts this
repository's tenant's proposed repository and organisation items to
`POST /world/proposals` as proposals of a `world_fact` with layer `memory`: the
statement is the fact's value, and the item id, type, scope, anchors, trust and
evidence rows (source, role, time) ride in its `qualifiers`. The person file and
other tenants are never read, quarantined items are not sent, and an item whose
text redaction would change is withheld. Run twice it sends nothing new: each
item is linked to its proposal, and SCF's own list is read first, so a lost
local link adopts the existing proposal. An unreachable SCF leaves memory as it
was. `memory import --scf` applies SCF's decisions (accepted makes the item
active, rejected rejects it; an accepted item whose evidence was purged here stays proposed and `memory review` lists it as accepted in SCF, evidence purged here, for you to decide) and counts each run outcome on the accepted fact
once, `reinforced` as helped and `weakened` as wrong. It reads
`GET /world/proposals` and `GET /world/facts/<id>/feedback`; SCF does not serve
the second yet (its `world_fact_feedback` rows have no read route), so that route
is what this asks of SCF.

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
    "notes": "notes.jsonl",
    "decisions": "/home/you/.local/share/review-voice/review-voice.db"
  }
}
```

`decisions` names Review Voice's store (an absolute path, or one relative to
the checkout). Memory opens it read-only, with no second sync of GitHub, and
turns the owner's decisions on findings of this repository into `precedent`
proposals: `keep`, `dismiss`, `never_flag` and `rewrite`, with owner trust
for the decision, the finding's directory as the path glob and the pull
request link as the source. The store holds every repository's findings, so
reading it is its own consent category (`decisions`, plan version 5): import
skips it, and says why, until you run `memory init --confirm` again. Finding
text was written by a model, so text that reads as an instruction arrives
quarantined with agent trust. A strong dismissal a teammate made, with no owner
row for it, arrives with team trust, and one with no `decided_by` with agent
trust. Review Voice keeps its own precedents; memory never writes
back, and never imports the review comments other tools made.

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
memory review [--json]                 # proposals for this repository's tenant and you
memory report [--tenant <name>]        # which items help and which mislead, per bound tenant
memory approve m-1a2b3c4d5e            # add --scope organisation to widen it
memory reject m-1a2b3c4d5e --reason 'too broad'
memory ui [--port <n>]                 # the same, and browse, search and edit, in a local page
```

`memory ui` serves one page on `127.0.0.1` only (any other `--host`, `0.0.0.0`
and `::` included, is refused before a socket opens) and prints its address
with a token made for that run. It answers only a loopback peer that sends
that token and names `127.0.0.1:<port>` as its Host, and takes a write only
from the page's own origin. It reads and writes through the code the commands
use: search ranks as `memory_search` does, an edit is a supersession (the
prior version stays in the item's history), and approve and reject record the
audit entry `memory approve` and `memory reject` record. Applying an
instruction-file edit there writes the file as `memory conflicts apply
--confirm` does, so `memory ui` starts only from a terminal (stdin a TTY), as
that command writes only from one; from a pipe or script it is refused unless
`--yes-non-interactive` is added, and an ask rule should cover it
(`Bash(*memory.mjs*ui*)`). It shows only this repository's bound tenant and
the person file.

In Claude Code (v2.1.287 or later, where plugins may run mods) memory also
draws in the session: `/memory-review` opens a review pane beside the
transcript with each proposal's evidence and an Approve and a Reject button,
and while proposals wait a band above the prompt counts them. The pane runs
`memory review --json`, `memory approve <id>` and `memory reject <id>` and
nothing else; it registers no tool, so only your press decides. Where a pane
cannot be drawn, `/memory-review` prints `memory review` instead. Codex and
`claude -p` sessions are unchanged. To turn it off, disable mods
(`disableAllHooks`, which also stops memory's other hooks) or the plugin.

A rejected statement is kept as a tombstone and never proposed again; after
30 days only its hash, type and scope remain. Approve and reject are terminal
commands. To be asked before an agent runs one, add ask rules such as
`Bash(*memory.mjs*approve*)`, `Bash(*memory.mjs*reject*)` and
`Bash(*memory.mjs*close*)` (an agent's shell can run `memory close`).

### Orbit, both ways

Orbit keeps its own lessons and its workers load no hooks. `memory import --orbit`
reads each checkout listed under `imports` in `config.json` (its `orbit` key names
the store; the default is `.orbit/knowledge.sqlite`) read-only and proposes, in the
checkout's tenant with agent trust: Orbit's validated repository lessons with the
run that last supported them as evidence, the contradictions Orbit counted (the
item's contradiction count only rises), and the check ids and failure fingerprints
of runs that ended without succeeding. Stale lessons, candidates and the global
graph are not read. Reading the store is its own consent category (plan version 6).

```bash
memory recall --orbit --fingerprint <fp> --check <id> --path <file> --max-tokens 800
```

is the command Orbit's retrieval calls from the run's repository root. It prints at
most three lean rows, one per line, for Orbit to put inside its own advisory fence,
and nothing unless `.orbit/config.yaml` has `knowledge.lessons_in_prompts: true`. An
Orbit lesson no run supported for 28 days is not offered. Rows carry no scores, so
a retry of one attempt reads the same text. Orbit's side of the call is a change in
the Orbit repository.

### Precedents for every reviewer

An approved precedent reaches reviewers that are not Review Voice when they
ask. Review Voice's agents never get the session slice (a reviewer primed with
your preferences is no longer independent), so nothing is pushed to them:

```bash
memory recall --diff origin/main..HEAD
```

prints the precedents and hazards for the paths that range changes, ranked as
`memory_search` ranks them, with their citations re-checked first, as lean rows
inside the advisory fence and within 600 estimated tokens, whole rows only. A
precedent anchored to a directory covers every path under it. A range that does
not resolve exits 2 with the reason.

#### Items on what the change reaches

A hazard on a caller the change did not touch is where breakage hides. With a
code anchor provider set in `config.json`,

```json
"impactProvider": { "command": ["/absolute/path/to/provider", "arg"] }
```

`memory recall --diff` runs that command once per call, without a shell, with
only `PATH` and `HOME` in its environment and 5 seconds to answer (it is then
killed with SIGKILL). `command[0]` must be an absolute path: a relative one would
resolve inside the repository, which could then supply the program. Memory names
no provider; a code graph adapts to this protocol, one JSON line each way.

The request, on standard input, with `range` exactly as given to `--diff` and
`changed` the paths the range changes:

```json
{"op": "impact", "repository": "owner/repo", "range": "<base>..<head>", "changed": ["src/core.ts"]}
```

The answer, on standard output, at most 4 MiB, exit status 0:

```json
{"status": "no_snapshot"}
{"status": "ok", "dependents": [{"path": "src/service.ts", "relation": "caller", "status": "neither", "symbol": "optional", "repository": "optional owner/repo"}]}
```

- `relation` is `caller`, `implementer` or `importer`. ProofMesh's words are accepted
  too: `calls` is a caller; `implements`, `overrides` and `inherits` are
  implementers; `imports` is an importer; `references` and any other relation are
  ignored.
- `status` is `changed`, `tested` or `neither`; a status that starts `tested: `
  (ProofMesh's `tested: <test> <path>:<line> ...`) is `tested`.
- A ProofMesh adapter must map its `pending` answer (no snapshot yet) to
  `no_snapshot`, and may start an index job to answer; the consent text of the
  `impact` category says so.

Items on a changed path score 4 as before. Items on a depth-1 dependent score 2
(`dependent 2` in the row's why), and 1 more (`neither changed nor tested 1`) when
the change neither edits nor tests that dependent. A `changed` dependent adds
nothing. Only a file the head of the range holds can boost, so a directory, an
absolute path, a path with `..` or one the repository lacks is skipped
(a backslash path is read as a slash path). A malformed entry is skipped and the
others still count, and at most the first 1000 entries are read. Dependents in other
repositories are dropped, siblings in the same tenant included: items are kept
per repository, so a dependent's path in another repository would match the wrong
items. The answer is not stored.

The budget stays 600 estimated tokens, the note below included. With no provider,
or a failing one, recall is path overlap as before; when a provider could not help
(no snapshot yet, it failed, or you have not agreed to plan version 8 with `memory
init`), one line after the rows says why.

### Choosing a toolset

A toolset item describes a tool an agent can use for a kind of task, and keeps
its record. It is always global and names no repository:

```bash
memory remember --scope global --type toolset -- "review toolset: reviews a pull request diff and reports defects"
memory outcome <id> accepted --source run-12
memory outcome <id> rejected --cost 1.5 --source run-13
memory route -- "review the open pull request"
```

`memory outcome` records one run's outcome as evidence on the toolset: its
accepted or rejected count rises by one and the cost is added. `memory route`
ranks the toolsets against the task with the points `memory_search` uses; equal
points go to more accepted outcomes. Each row carries the accepted and rejected
counts and the total cost. Agents do not propose toolsets.

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

## Instruction files

`CLAUDE.md`, `AGENTS.md` and the like are loaded whole by the agent, so they
are the source of truth and memory never repeats them. At every recall (the
session slice, a subagent's slice, `memory_search`, `memory recall --diff`)
memory reads, read-only, the files an agent in this directory loads: the
`CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` from here up to the
repository root, the root's `AGENTS.md`, `GEMINI.md` and
`.github/copilot-instructions.md`, your `CLAUDE.md` in the Claude Code config
directory, and every `@path` import of those (five deep). A file, link or
import that leaves the repository (for your own file, your home directory) is
not read. Their text is matched, never stored as an item or evidence.

- **A repeat** (the same statement as a line, by the consolidation matcher: same
  normalised text, or a word overlap of 80% with the same numbers) is left out
  of recall. The drop is logged as `withheld` in the injection log, by item id
  and the tokens saved. A partial overlap does not drop an item, and a deleted
  line brings the item back at the next session. `memory_propose` of a
  statement a loaded line already says is refused, naming the file and line.
- **A contradiction** (a line and an item that share a subject, two content
  words covering 80% of the shorter, and differ in polarity, "must" against
  "must not", "run" against "optional", with no scoping word such as when,
  only, unless, except, if or "for ..." in either) is also left out: the file wins. Memory
  stores a proposed edit that replaces the line with the item's statement.
  `memory review` shows it as a diff, `memory conflicts` lists every edit, and
  no MCP tool or hook writes it, and `memory conflicts apply <id> --confirm`
  does only from a terminal (stdin a TTY); from a pipe or script it is refused
  unless `--yes-non-interactive` is added. An agent with a shell can still run
  it, so add an ask rule for it, as for `approve` (for Claude Code,
  `Bash(*memory.mjs*conflicts apply*)`). It writes exactly the diff shown and
  marks the item superseded by the file; `memory conflicts reject <id>` marks
  it resolved. Without `--confirm`, apply writes nothing. The edit is refused if the
  line changed since it was proposed. After a reject the item stays out of
  recall for as long as the file contradicts it.
- **A promotion**: an active convention, preference or decision with no anchor,
  and support of 3 or more (only your own evidence raises support), is
  proposed for the file: appended to the repository's `CLAUDE.md` (or `AGENTS.md`
  when there is no `CLAUDE.md`), or to your own `CLAUDE.md` for a person or
  global item. Apply writes the line, and the item becomes `promoted` and
  leaves recall.
- **Promotion into checks**: `memory promote --propose` stores and lists
  proposals. An active repository item with support of 3 or more, no
  contradiction and a convention, preference or decision type is proposed as one
  line of the review-standards file (the `standards` path under `imports` in
  `config.json`, else `docs/review-standards.md`). An item anchored at a symbol
  that no test executes (slice 15 looked it up and found none) is proposed as
  "write a test for <symbol>" instead. `memory promote --apply <id>` runs from a
  terminal (or with `--yes-non-interactive`, with an ask rule on it), appends
  exactly the line shown, marks the item `promoted` with `promoted_to` set and
  takes it out of recall. A line with a secret, an email, a handle or a
  committer's name, and a target that is a symbolic link or resolves outside the
  repository, are refused. Nothing is committed, pushed or opened as a pull
  request. `memory promote --reject <id>` keeps the proposal as a tombstone.
  A test proposal cannot be applied. No Review Voice policy or Orbit check target yet.

Matching is by words, with no model: a contradiction in other words is missed,
and a shared-word pair can read as one subject. `memory list` shows every item,
withheld ones included. No MCP tool writes an instruction file, and a
file is never committed or pushed.

## Automatic capture

At Stop and SessionEnd a hook runs `memory capture`. It hands the work to a
detached process and returns at once, and it never fails the session. The
process reads the session transcript (user and assistant text, newest 48,000
characters, and at a Stop only once 4,000 new characters have come in; a Stop
before that says so and is recorded in `logs/capture.jsonl` as skipped), takes
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
- **Tainted sessions:** when the transcript shows the session read a web page
  or search (`WebFetch`, `WebSearch`) or called a tool of any MCP server but
  memory's own, what capture keeps is still saved active, labelled `tainted
  by web:<host>` or `mcp:<server>` in recall and review. Imperative text from
  such a session is quarantined as usual.
- **Automation sessions:** a session started by automation (`claude -p`, the
  SDK, a GitHub Actions job) neither captures nor proposes unless the consent plan names
  them: `memory init --automation on --confirm`. See SECURITY.md for how a
  session is told apart and what that cannot see.
- **Other agents:** capture reads a Codex session log
  (`~/.codex/sessions/.../rollout-*.jsonl`) as it reads a Claude Code
  transcript, and names the agent in the source (`capture:codex:...`). Run
  `memory capture` from the agent's own end-of-session hook with JSON on stdin
  that names `transcript_path`, `session_id` and `cwd`. A log in a format no
  adapter knows is skipped, never guessed at: the run reports it and
  `logs/capture.jsonl` records it as `skipped`. An agent with no adapter can
  still write through the MCP tools; each proposal's evidence names the client
  that wrote it (`mcp:<clientInfo name>`).

```json
{ "capture": { "enabled": true, "model": "haiku", "maxCandidates": 5, "apiModel": "claude-haiku-5-5" } }
```

`model` is `haiku` (the Messages API by plain `fetch`, no SDK) or `fake`, the
deterministic filter the tests use; `apiModel` is the Claude Haiku alias.

## What agents can do

The plugin runs an MCP server with five tools. None of them can approve,
reject, purge or change the configuration, and nothing they write is active.

- `memory_search(query, paths?, repository?, as_of?)` returns at most 10 rows,
  `[id] type · name path:line · statement (source) · why: points`, each at
  most 60 estimated tokens; a long statement is cut in the row. An item is a
  hit only when it shares an anchored path or words with the search. Its
  score is a fixed sum: 4 per anchor in the paths (at most 8), scope
  (repository 2, organisation or person 1, global 0.5, plus 0.5 for a person or global item learned in the current repository), full-text relevance up
  to 2 (none below 20% of the best match), confidence up to 2, and minus 1 per
  contradiction. Ties go to support, then id. `why` lists every point.
  With `as_of`, an ISO date such as `2026-03-01` (midnight UTC), the versions
  valid then are searched instead of the current ones, a superseded version
  among them, and each row adds `valid <from> to <replaced>` (`to now` while
  current). Everything else is the same search.
  With the semantic leg on (Embeddings, below), the keyword ranking above and
  the leg's ranking (items whose vector's cosine with the query's is 0.35 or
  more, closest first) and the graph list (items sharing an anchored path with
  one of the three best keyword or three best semantic hits, by support) are
  fused by reciprocal rank fusion with k = 60: each item scores the sum of
  1 / (60 + its rank) over the lists it is in. A row keeps every keyword
  point, adds `semantic`, up to 4 points for its cosine, and `graph 1` when it
  is in the graph list, and ends with its fused score as `rrf`. With the
  reranker on (below), each row also ends with its new place as `rerank`. Budgets, the 10-row limit and the
  advisory fence do not change.
- `memory_get(id, format?)` returns one item whole, with its evidence and
  anchor status, as rows or as JSON with `format: "json"`.
- `memory_related(path_or_symbol, depth?)` returns every active item anchored
  at or under a path of this repository (a directory matches everything below
  it; a symbol key `path#name#kind` matches that symbol and what it prefixes),
  as the same rows the session slice prints, within the session budget: whole
  rows are dropped, never cut, with a `+N more` line. `depth` limits the path
  segments matched below the prefix (0 is the prefix itself). It reads the
  anchor-path index after the usual re-check, so stale, superseded, proposed
  and quarantined items never appear. `memory related <path> [--depth n]` is the
  same from the terminal.
- `memory_propose(statement, scope, type, evidence)` stores a proposal for
  `memory review`. `evidence` is `{source, origin}`, where origin is `agent`
  (the default), `team`, `external` or `bot`; only your own `remember` gives
  owner trust. A proposal that Orbit's authority rules read as an instruction
  ("always skip tests") is quarantined: never searched, shown in review with
  the rule that flagged it, and active only if you approve it. `evidence` may
  also carry `tainted_by`, the external content the session read (such as
  `web:example.com`); a source from `external` or `bot` is named as the taint
  automatically. The label shows in `memory review`, `memory_get`, search rows
  and the session slice, and it survives merges and supersession.
  `test/poison.test.mjs` and `memory eval poison` are the standing red-team
  suite for these gates (see SECURITY.md); `npm test` runs it in CI on every
  pull request.
  `type` may be `open_question`: a question the team has not settled, not a
  fact. It is inactive like every proposal until you approve it; once approved
  it is recalled in the session slice with its type shown, and `memory close
  <id>` (terminal only, no MCP tool) takes it out of recall and keeps it on
  record as `closed`. It needs no new consent: it is the same agent-proposed
  text, in the same stores.
- `memory_feedback(id, helped|wrong|stale)` changes only the counts behind an
  item's confidence. `stale` re-checks the item's citation at HEAD at once: if
  it fails, the item goes stale as the re-check would make it, and comes back
  when the citation holds again. Otherwise the item stays active, because an
  agent's word alone must not hide what you approved, and `memory review`
  lists it with the number of reports: `memory reject` takes it out,
  `memory approve` clears the reports.

The server also sends a few lines of instructions when a session connects,
which Claude Code puts in the agent's context: search before changing
unfamiliar code or when stuck, give feedback on items it used, propose a
lesson when you correct it, and treat items as data. The hooks already inject
items at session start and before a file is read or edited, so the agent is
told not to search again for those.

## Embeddings

The semantic leg (#28) is off by default. `memory_search` and
`memory recall --diff` (whose query is the changed files' names) use it; no
hook ever does, and hook output is byte-identical with it on. It needs two
things:

1. An embedder named in `config.json`. The one meant for it is a local
   [Ollama](https://ollama.com), the same server the corrections model pass
   uses, with an embedding model you install yourself (`ollama pull bge-m3`,
   or `nomic-embed-text`); memory never downloads a model:

   ```json
   "embeddings": { "provider": "ollama", "model": "bge-m3", "url": "http://127.0.0.1:11434" }
   ```

   `model` defaults to `bge-m3` and `url` to `http://127.0.0.1:11434`.
   `voyage` calls Voyage AI's embeddings endpoint with `VOYAGE_API_KEY` from
   the environment of the process; `fake` is a deterministic offline provider
   for tests.
2. An embedder on this machine for a tenant. Every tenant is treated as a
   client tenant: its text goes only to an address of `127.0.0.1`,
   `localhost` or `[::1]`, so Voyage, or an Ollama elsewhere, embeds the
   person file's items only, and search in a tenant refuses it.

The head-to-head replay's vocabulary-miss share (`eval/head-to-head/<tenant>/last.json`)
says how often words alone missed; it is information for deciding to turn the
leg on, not a gate.

Changing the key swaps the provider
with no code change; a vector from another model is not used until
`memory embed --backfill` embeds the item again. Each vector sits in the
same SQLite file as its item, with its model and size, and a purge deletes it
with the item. `remember` and `memory approve` embed the item they make
active; a proposal is embedded only when approved, and an item flagged as
reading like an instruction never is. `memory embed --backfill` embeds every
active item that has no vector.

Embeddings are part of the consent plan: they stay off until you run
`memory init` and confirm it. When the leg is configured but cannot run (an
embedder elsewhere, no key, the embedder down or failing, or no
vectors), search ranks by words and paths as before and prints one line saying
the semantic leg was skipped and why. A search waits at most 1.5 seconds for
the provider. Vectors are derived data: a purge deletes them with their item,
and a new model's are rebuilt with `memory embed --backfill`, never migrated. Similarity is computed in
memory over the tenant's vectors, which is fine to about 50,000 items.

### Reranking

A local generative model can reorder the rows `memory_search` and
`memory recall --diff` found, on the same Ollama server. It is off unless
`config.json` names it:

```json
"rerank": { "model": "inkling-2-mini", "url": "http://127.0.0.1:11434" }
```

`model` defaults to Inkling 2 Mini (`inkling-2-mini`), not pinned: you install
it, and memory never downloads a model. `url` defaults to the loopback Ollama.
The query and the rows' statements are sent to `/api/generate`; for a tenant
only to an address of `127.0.0.1`, `localhost` or `[::1]`. The model answers
an order, each row adds its new place as `rerank`, and a row it leaves out
keeps its place after the ones it ranked. No hook ever calls it. When it is
refused, fails, answers no order or takes more than 3 seconds, the rows keep
their fused order and one line says the rerank was skipped and why. It falls
under the embeddings consent category.

Confidence is computed on read as `min(1, 0.5^(age/90 days) × 1.1^helped ×
0.8^wrong)`, age counted from the last approval, `remember` or `helped`, and
shown as low (below 0.4), medium or high (0.7 or more). These constants are
provisional until the evaluation slice
([#8](https://github.com/QuintinBotes/memory/issues/8)) tunes them. An item
with no reinforcement for 90 days reads as expired and leaves every recall.

`memory report [--tenant <name>]` ranks the active items of each tenant bound to
this Claude Code config by net score (`helped` minus `wrong` minus agents'
`stale` reports), then by the confidence above, then by id, so the same store
always prints the same bytes. Items with no feedback are listed apart under
"No feedback", by id. Each tenant is read from its own store only: with
`--tenant`, no other store is opened, and an unbound tenant is refused. A
quarantined item is listed without its statement. It needs the consent plan
and changes nothing.

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
a compaction and at a subagent's start, a diff at review, a failing
command and, with `pointOfAction` on, reading or editing anchored code exist so far; the other
moments arrive with later slices.

## Measuring memory

Memory stays off by default until it measures no worse. `memory eval` prints
scorecard rows, one JSON object per line, each measure with memory off and on.
Every row carries the plugin version, the capabilities on in its arm
(`switches`), its sample sizes and its bar. A measure that cannot run says
`not run` and why; it never carries a number. The harness calls no model,
posts nothing, never opens the memory store, and prints the same rows for the
same inputs.

`memory eval poison` is the red-team report, offline, in a throwaway store of
its own: one JSON line per attack family (external comments, query-only
injection, delayed triggers over 100 sessions, compositional attacks, command
output, fence escape, trust laundering, role spoofing) with `attempted`,
`active` (reached active without the owner's trust), `outside_fence` and
`raised_support`, then the owner's 50 benign items accepted and recalled, then
a summary. It exits 1 when any attack got through; it is not part of the
no-measure run.

```bash
memory eval poison
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

### Head to head

`memory eval head-to-head --since <date> --history <file>` scores memory
against the alternatives on your own work (#25). Questions come from the
history's corrections, decisions and failures after `--since`, each labelled
with one category: single fact, multi-source, knowledge update (only the newer
decision is right), temporal (what applied at a date), abstention (nothing
applies, so silence is right), code-anchored hazard, or stale citation (the
cited code was rewritten, so the item must not be recalled). A question whose
answer was only recorded after the cut-off is dropped; no arm ingests
anything dated after it.

Arms: this plugin (a throwaway store, searched as `memory_search` searches),
memory off, Claude Code auto memory (a `MEMORY.md` of one line per note, of
which Claude Code loads the first 200 lines), the whole history in context,
and Mem0, Graphiti, Basic Memory and a community memory plugin, each run from
your local install. The bars are printed first, before any arm runs; then per
arm and category recall at 1 and 5 against the answer keys, the share it
stayed silent, stale recall (a stale or superseded item in the top five),
tokens per question and per correct item (characters divided by four, for
every arm) and p50 and p95 latency on this machine; then the verdict against
the best alternative, the categories memory misses, the matcher's precision,
and the vocabulary-miss share: of memory's misses that another arm found,
those whose item shares no word with the question. Grading is a match of the
answer key's words in the hit, no model. Every row but latency is the same
for the same inputs.

The replay set, every per-question result, the scorecard and `last.json`
(with `vocabulary_miss_share`) stay in `eval/head-to-head/<tenant>/` in the
data directory. `sample.jsonl` there holds 30 of the run's matches: mark each
`correct` true or false and pass the file back with `--checked` to report the
matcher's precision. The synthetic fixture reproduces the plugin's own rows:

```bash
node test/fixtures/head-to-head/generate.mjs   # rewrites acme.json, 315 questions
memory eval head-to-head --since 2026-06-01 --history test/fixtures/head-to-head/acme.json \
  --checked test/fixtures/head-to-head/checked.jsonl [--arms arms.json]
```

The history file:

```json
{"tenant": "acme", "repository": "acme/api", "client": true,
 "evidence": [{"id": "e1", "at": "2026-01-05", "kind": "decision", "statement": "Store ledger amounts as floats", "key": "amounts as floats"},
              {"id": "e2", "at": "2026-02-05", "kind": "decision", "statement": "Store ledger amounts as integer cents", "key": "amounts as integer cents", "supersedes": "e1"},
              {"id": "e3", "at": "2026-02-08", "kind": "code-change", "statement": "Rewrote src/ledger/legacy.ts", "path": "src/ledger/legacy.ts"}],
 "events": [{"id": "q1", "at": "2026-03-04", "kind": "correction", "question": "How do we store ledger amounts?", "answers": ["e2"]}]}
```

Evidence kinds are `decision`, `correction`, `lesson`, `hazard`, `failure`
and `code-change`; `key` is the phrase that shows a hit holds the item, and
`path` anchors it. An event may name a `path` (the file being edited) and an
`asOf` date (a temporal question). A tenant is a client tenant unless
`client` is false.

An alternative runs only through the command you name in the arms file, as
its own process; no code of it is in this repository:

```json
{"arms": {"mem0": {"command": ["python3", "/path/to/mem0-arm.py"], "modelBacked": true},
          "graphiti": {"command": ["graphiti-arm"], "offMachine": true}}}
```

The command gets only `PATH`, `HOME`, `DO_NOT_TRACK=1` and the arm's own
switch (`MEM0_TELEMETRY=False`, `GRAPHITI_TELEMETRY_ENABLED=false`) in its
environment, and speaks one JSON object per line: it answers
`{"op": "hello"}` with `{"telemetry": "off"}`, `{"op": "ingest", "evidence":
[...]}` with `{"ok": true}`, and `{"op": "answer", "question": "...",
"path"?: "..."}` with `{"hits": ["best first", ...]}` (an empty list is
silence). An arm with no command, one that is not installed, crashes, or does
not confirm its telemetry is off scores zero and the scorecard says why; it
is sent no evidence until it confirms. A `modelBacked` arm runs three times
and reports its spread. An `offMachine` arm, one that sends evidence to a
hosted model or service, is skipped for a client tenant, with the reason. Any
other name adds an arm.

## Code anchor providers

Items can be anchored to code. Memory ships a provider that anchors by path,
line range and a hash of the cited text. A code graph can plug in through a
small interface (a stable key per symbol, the symbol enclosing a line, what
changed between two snapshots, what a change reaches, and the tests that
prove a symbol): the command named under `impactProvider` in `config.json`,
run without a shell with one JSON line in and one out. Memory names no
provider; the interface is in [docs/provider.md](docs/provider.md).

`memory remember --anchor src/a.ts#Ledger.consume#method` anchors an item to a
symbol. At session start a detached job follows the anchors: when the provider
proves the anchored code is identical after a move or rename (the same content
hash), memory moves the anchor, keeps the item's status and logs the move;
`memory anchors undo <move-id>` puts the old anchor back exactly. A changed
signature or a lost citation makes the item stale. When the key is gone and
the answer is not certain (two candidates with the hash, or a candidate of the
same name with another), the item goes stale and `memory review` lists a
re-anchor proposal; `memory anchors adopt <item-id> <key>` accepts one. With
no provider, or one that fails or times out, anchors are checked by path and
hash and memory says so. The provider is named in the consent plan (version 9).

The same job asks the provider for the tests of each anchored symbol and keeps the
nearest one whose evidence executes it (a call, a dispatch, an observation; never a
reference or an import). A recalled code item then ends its row with
`test: name path:line`, so one command confirms it. `memory report` says how many
active code items name a test. Tests are never looked up inside a hook. A run makes at
most `MEMORY_TESTS_PER_RUN` lookups (50 by default) and the next run continues; a failing
`tests` op is skipped for the rest of the run without costing any anchor its move.

## Development

```bash
npm install     # dev tooling only; the plugin ships with zero dependencies
npm run verify  # typecheck, bundle drift, tests, identity guard, action pins
npm run e2e     # real Claude Code sessions with this checkout (needs a signed-in claude)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

Every pull request here is reviewed by the [Review Voice](https://github.com/QuintinBotes/review-voice)
action (`.github/workflows/review-voice.yml`, configured by `.review-voice/config.yaml`
at the base commit), which posts only verified findings. It needs an
`ANTHROPIC_API_KEY` Actions secret scoped to an Anthropic Console workspace,
and skips without one; it is not a required check. Answer a finding there by
replying, resolving or dismissing it. The Action's review run stays in the
runner's store, so locally run `review-voice outcomes --recover` (review-voice
after 1.30.0; [review-voice#529](https://github.com/QuintinBotes/review-voice/issues/529))
to record the Action's reviews as runs and follow each finding to its outcome.
What memory reads from Review Voice's store, with it named as `decisions` under
`imports` (above): a finding you keep, dismiss or reword with
`/review-voice:feedback`, and a finding dismissed on the pull request (a strong
dismissal in `review-voice outcomes`), whether the review ran locally or was
recovered from the Action. `memory import` turns those into precedent proposals.
Accepting, fixing or resolving a finding on GitHub records nothing memory reads.

## Licence

MIT. See [LICENSE](LICENSE).
