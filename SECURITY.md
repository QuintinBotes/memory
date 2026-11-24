# Security

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting on this
repository (Security, then Report a vulnerability). Please do not open a
public issue for it.

The most valuable reports are about isolation: any way an item stored for one
tenant is read or printed in another tenant's repository, in a repository with
no tenant, or in a Claude Code config not bound to that tenant.

## What memory protects, and what it does not

- **Isolation by tenant.** Each tenant has its own SQLite file, and a process
  opens only the tenant its repository's github.com `origin` remote and its
  Claude Code config allow. Anything ambiguous means no tenant. The tenant is
  whatever `origin` says: a directory delivered with its own `.git` (an
  archive, a shared drive) can claim a repository it is not.
- **Refusal at the boundary.** A statement is checked before it is stored, and
  there is no column for raw text. The check recognises credentials by their
  shape (Review Voice's redaction patterns), private key headers, email
  addresses, handles and webhook URLs. Pattern matching cannot recognise a
  credential that does not look like one, such as a plain password written
  in prose. Do not ask memory to remember secrets.
- **Model control tokens.** Text carrying a special token or chat role marker
  (`<|im_start|>`, `[INST]`, `<<SYS>>`, `</s>`, a leading `System:`) is refused
  at every path that stores an item.
- **Red-team suite.** `test/poison.test.mjs` replays the published poisoning
  attacks (query-only injection, planted items that fire later, attacks split
  over items, trust laundered through merged evidence, role spoofing, fence
  escape, planted auto memory) against every capture path, with fixtures only,
  in CI on every pull request. It measures memory's gates, not a model's
  resistance. A source file that stores items with no family in it fails the
  suite. Not yet covered: taint labels for sessions that read external
  content, and refusing automation-started sessions.
- **Organisation-free person items.** Person and global items are refused when
  they name code, a path, a tenant, an owner or a repository. This is a
  heuristic; names of one character are not matched.
- **Advisory only.** Items are printed as cited facts. Memory never blocks a
  tool call or grants a permission.
- **Local store.** Nothing else is uploaded. Files are created with mode 0600 in a 0700
  directory.
- **Embeddings send text out.** With the default
  provider (Voyage AI, `voyage-4`) and `VOYAGE_API_KEY` set, memory sends to
  `api.voyageai.com` over HTTPS: the statement of each active item when you
  `remember` or `approve` it or run `memory embed --backfill`, and the words of
  each `memory_search` query. It sends no paths, evidence, source references or
  proposals, and never the text of an item flagged as reading like an
  instruction. The statements have passed the same refusal check as every
  stored item, which cannot recognise a credential that does not look like one.
  The key is read from the environment, never written to disk, never printed
  and never logged; the Voyage address can be moved with `VOYAGE_BASE_URL`
  (for a proxy), which receives the key too. Vectors come back and are kept in
  the item's own file, deleted with it. Without a key nothing is sent. Sending
  needs your consent to the plan's embeddings category, and the owner picks the
  provider in `config.json`. Voyage's own retention terms apply to what it
  receives.
- **Capture sends text out.** Automatic capture (on by default once you confirm
  the consent plan that lists it, off with `capture.enabled: false`) sends the
  session transcript's user and assistant text, at most 48,000 characters per
  run, to `api.anthropic.com` with your `ANTHROPIC_API_KEY`. Credentials, emails,
  handles and webhook URLs are replaced before it leaves; pattern matching
  cannot catch a secret that does not look like one, such as a password in
  prose, and the transcript can hold your code. Nothing is sent from a
  repository that matches no tenant. The tokens used per run are logged to
  `logs/capture.jsonl`, never the text. What the model keeps is saved as active
  items with agent trust; text that reads as an instruction is quarantined.
  A model's output is data, never a command: it is refused if it carries a
  credential, an email or a handle, and it is shown as a cited fact in the fence.
