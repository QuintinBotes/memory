# Code anchor provider

A code anchor provider lets memory keep an item pointed at a symbol as the code moves. Memory ships none and names none: a
provider is any executable you name in `config.json`, and memory's own tests use a fake one (`test/fake-provider.mjs`).

```json
{ "impactProvider": { "command": ["/absolute/path/to/provider", "serve"] } }
```

The program is an absolute path. This is the same command that impact-aware diff recall (`memory recall --diff`) uses: one provider, several `op`s. Without
it, anchors are checked by path and hash as before. Naming one needs you to agree to consent plan 9 (`memory init`), which
lists what the anchor refresh sends it.

## Protocol

One shared runner (`src/provider/run.ts`) runs the command for every op, impact recall included: without a shell, in the
repository's working directory, with only `PATH` and `HOME` in its environment, once per request. It is killed with SIGKILL
after 5 seconds, and its output is capped at 4 MiB. The request is one JSON line on its standard input:
`{"op": ..., "repository": "owner/name", ...}`. The answer is the first line of its standard output: `{"status": "ok",
"repository": "owner/name", "snapshot": "<id>", "commit": "<sha>", ...}`, `{"status": "no_snapshot"}` when it has not indexed
this repository yet, or `{"status": "error", "error": "text"}` to refuse one request. Standard error is ignored.

`snapshot` is the id of the index the answer is from, and `commit` the commit that index was made at. Memory computes the
cited-text and file hashes from the file at HEAD, so it only moves or re-anchors onto a snapshot whose `commit` is HEAD
(a full sha, or a prefix of at least 7 characters). A snapshot that is behind HEAD, or does not say, never moves an anchor: a
key it has lost leaves the item stale with the reason `snapshot not at HEAD`.

An answer whose `repository` is not the repository asked about is dropped, whole, before anything in it is read, and
nothing is changed. A refused request (`status: "error"`) skips that one anchor and is logged as `anchor_skipped`; the rest
of the run goes on. Any other failure, whatever its kind (cannot start, exits non-zero, times out, text that is not JSON,
`no_snapshot`, a field missing below), ends the run: memory logs `provider_failed` to `logs/anchors.jsonl`, says so, and
checks that repository's anchors by path until a run for it succeeds. That flag is kept per repository in
`anchors-state.json`; until a run has succeeded for a repository, its anchors are checked by path too.

A symbol is `{ key, kind, signature?, start, end?, hash }`:

- `key` is `path#qualified_name#kind`, stable across edits that leave the symbol where it is. `path` is relative to the
  repository root.
- `start` is the 1-based first line of the declaration at the snapshot. `end` is its last line and defaults to `start`, so a
  provider that gives no end line anchors one line.
- `signature` is the declaration's signature text, optional. A change is seen only when both the anchor and the answer have one.
- `hash` is a content hash of the declaration text with the symbol's own name masked, so the same code under another name or
  in another file has the same hash and an edited body has another. The provider computes it; memory compares hashes and
  never reads symbol text itself, except to count tokens (below).

## Operations

| `op` | Request fields | Response fields |
|---|---|---|
| `key` | `key` | `symbol`: the symbol the key names at the current snapshot, or `null` when it is gone |
| `symbol_at` | `path`, `line` | `symbol`: the innermost symbol enclosing the line, or `null` |
| `changes` | `since`: a snapshot id | `since_found` (false when the provider no longer holds `since`), `files`: the paths changed since, `added`, `removed`, `changed`: symbols |
| `symbol_impact` | `keys`: symbol keys | `dependents`: `[{ path, symbol?, relation, status }]`, the shape `impact` answers with (relation `caller`, `implementer` or `importer`, or ProofMesh's `calls`, `implements`, `overrides`, `inherits` or `imports`; status `changed`, `tested` or `neither`); a dependent naming another `repository` is dropped |
| `tests` | `key` | `tests`: `[{ key, evidence, line? }]`, each test's key (`path#name#kind`), the kind of evidence it has and, optionally, the line it starts at |

`impact` (`range`, `changed` paths) is slice 14's op, answered the way that slice defines it. `memory anchors at|impact|tests`
print the answers to `symbol_at`, `symbol_impact` and `tests`. The last two are defined now so a provider is built once;
point-of-action recall (#14) and test links (#17) use them.

## How memory uses it

`memory remember --anchor path#qualified_name#kind` asks `key` and stores the anchor with the key, signature, line range,
a hash of the cited lines, the content hash, a hash of the file and the snapshot id. With no provider, or one that fails,
the item is anchored to the file and memory says so.

At session start, a detached job (`memory anchors refresh`, never inside a hook) asks `changes` since each snapshot the
anchors were last made at, and re-resolves only anchors in the files named (every anchor when `since_found` is false):

| The provider says | Memory does |
|---|---|
| the key resolves, signature the same, cited text present at the reported lines | the item stays current; its lines and snapshot are updated |
| the signature changed | the item is stale: `signature changed` |
| the key resolves but the cited text is not at the reported lines | the item is stale: `cited text gone` |
| the key is gone and exactly one symbol of the same kind was added with the same `hash`, at a snapshot of HEAD, and its declaration at HEAD has at least 10 tokens (a body that small is the same text under many names) | the anchor moves to it, status and trust unchanged (a stale item stays stale: only a citation that holds again brings one back), and the move is logged with the old and new key, hashes and snapshots |
| the key is gone, and several added symbols share the hash, or none does but an added symbol has the same qualified name | the item is stale: `key gone`, and a re-anchor proposal listing the candidates waits in `memory review` |
| the key is gone and nothing matches | the item is stale: `key gone` |

`memory anchors undo <move-id>` puts the previous anchor back exactly and logs the undo; memory does not make that move
again. `memory anchors adopt <item-id> <key>` is your yes to one candidate of a proposal.

### Tests that prove an item

In the same refresh, memory asks `tests` for each anchored symbol that is not stale, once per snapshot (an anchor already
asked at the current snapshot is not asked again), and keeps the nearest test whose `evidence` executes the symbol:
`call` first, then `dispatch`, `observed` and `transitive_call`, ties in the provider's order. `reference`, `import` and any
other evidence kind never count, so a provider with no such evidence records no test. The anchor keeps `test`
(`name`, `path` and `line` when given) and `testsAt`, the snapshot asked. A recalled row ends `test: name path:line`,
inside the same 60 estimated tokens. Hooks never ask; they show what the job recorded. `memory report` prints how many
active code items name a test, and says so when no provider is configured.

While a provider answers, the hooks leave its anchors to the job. After a failure they check them by path again, so
nothing goes unchecked.

## Writing a ProofMesh adapter

`impact` (slice 14) and the symbol ops answer in different shapes: `impact` answers per changed path (`range`, `changed`)
and the symbol ops per symbol key. An adapter over ProofMesh must supply or synthesise these:

| Field | ProofMesh gives | The adapter |
|---|---|---|
| `key` | `stable_key` | passes it through |
| `hash` | `body_hash` | passes it through |
| `start` | the symbol's first line | passes it through |
| `end` | no end line in a row | optional; supply the end line from the symbol's span for a multi-line anchor, or the anchor cites one line |
| `signature` | not in a lean row | optional; leave it out, or supply it to see signature changes |
| `added`, `removed`, `changed` | `compare_snapshots`; its `paired` rows are not needed, memory pairs by `hash` | maps them to symbols |
| `commit` | the snapshot's commit | supplies it, or memory never moves an anchor |
| dependent `status` | `changed`, `tested: ...` or `neither` | `symbol_impact` needs one per dependent; synthesise `neither` when unknown |
| dependent `repository` | not given | optional; omit for the same repository |
