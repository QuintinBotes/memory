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

The command is run without a shell, in the repository's working directory, with only `PATH` and `HOME` in its environment,
once per request, and stopped when it has answered or after 5 seconds. The request is one JSON line on its standard input:
`{"op": ..., "repository": "owner/name", ...}`. The answer is the first line of its standard output: `{"status": "ok",
"repository": "owner/name", "snapshot": "<id of the index the answer is from>", ...}`, `{"status": "no_snapshot"}` when
it has not indexed this repository yet, or `{"status": "error", "error": "text"}`. Standard error is ignored.

An answer whose `repository` is not the repository asked about is dropped, whole, before anything in it is read, and
nothing is changed. A provider that cannot start, exits or times out without answering, answers text that is not JSON, answers
`no_snapshot` or `error`, or leaves out a field below, counts as a failure: memory changes no anchor, logs it to
`logs/anchors.jsonl`, says so, and checks anchors by path until the provider answers again.

A symbol is `{ key, kind, signature, start, end, hash }`:

- `key` is `path#qualified_name#kind`, stable across edits that leave the symbol where it is. `path` is relative to the
  repository root.
- `signature` is the declaration's signature text. `start` and `end` are its 1-based line range at the snapshot.
- `hash` is a content hash of the declaration text with the symbol's own name masked, so the same code under another name or
  in another file has the same hash and an edited body has another. The provider computes it; memory compares hashes and
  never reads symbol text itself.

## Operations

| `op` | Request fields | Response fields |
|---|---|---|
| `key` | `key` | `symbol`: the symbol the key names at the current snapshot, or `null` when it is gone |
| `symbol_at` | `path`, `line` | `symbol`: the innermost symbol enclosing the line, or `null` |
| `changes` | `since`: a snapshot id | `since_found` (false when the provider no longer holds `since`), `files`: the paths changed since, `added`, `removed`, `changed`: symbols |
| `symbol_impact` | `keys`: symbol keys | `dependents`: `[{ path, symbol?, relation, status }]`, the shape `impact` answers with (relation `caller`, `implementer` or `importer`, or ProofMesh's `calls`, `implements`, `overrides`, `inherits` or `imports`; status `changed`, `tested` or `neither`); a dependent naming another `repository` is dropped |
| `tests` | `key` | `tests`: `[{ key, evidence }]` |

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
| the key is gone and exactly one symbol of the same kind was added with the same `hash` | the anchor moves to it, status and trust unchanged, and the move is logged with the old and new key, hashes and snapshots |
| the key is gone, and several added symbols share the hash, or none does but an added symbol has the same qualified name | the item is stale: `key gone`, and a re-anchor proposal listing the candidates waits in `memory review` |
| the key is gone and nothing matches | the item is stale: `key gone` |

`memory anchors undo <move-id>` puts the previous anchor back exactly and logs the undo; memory does not make that move
again. `memory anchors adopt <item-id> <key>` is your yes to one candidate of a proposal.

While a provider answers, the hooks leave its anchors to the job. After a failure they check them by path again, so
nothing goes unchecked.
