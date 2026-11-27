# Contributing to Memory

## Three hard rules

**1. Never commit anything credential-shaped.** Memory refuses secrets, so its
tests need credential-shaped strings. They assemble them from fragments at
runtime, so no literal matching a provider's token format exists in any file.
CI runs a secret scan; the rule holds whether or not the scanner catches a
case.

**2. Never commit real data.** Every fixture is synthetic. Examples use
made-up tenants such as `acme` and `personal`, and made-up repositories such
as `acme/api`.

**3. Never name a real organisation, person or private repository.** Memory
serves whoever runs it. No employer, client, login, home directory or private
repository name belongs in the source, the docs, the tests, the issues or the
pull requests. `npm run guard:identity` checks structural patterns, and reads
extra terms from `.identity-guard.local`, a gitignored file for anything
specific to you. The guard lists no names itself, because a guard that lists
what it hides publishes it.

## Getting set up

```bash
git clone https://github.com/QuintinBotes/memory.git
cd memory
npm install
npm run verify
```

`npm run verify` drives the CLI and the MCP server directly. `npm run e2e` runs
real Claude Code sessions with this checkout loaded by `--plugin-dir`, against
a throwaway data folder and a synthetic `acme/api` repository: it checks the
session-start slice, that an
anchored item reaches an agent reading the file, that `memory_search` and
`memory_propose` work over MCP (an automation session's proposal refused until
`--automation on`), and that the plugin validates and the review pane's tests
pass. It needs a signed-in `claude` and spends a few small requests, so CI does
not run it; run it before any change to hooks, MCP or the mod, and before a
release.

Try your working copy in Claude Code:

```
/plugin marketplace add /path/to/your/clone
/plugin install memory@memory
```

## The build artifact is committed

`dist/memory.mjs` is checked in, because plugins install by git clone with no
install step. If you change anything under `src/`, run `npm run build` and
commit the result. CI fails on a stale bundle.

Third-party packages are fine as `devDependencies`; esbuild inlines them. They
never become runtime dependencies.

## How work is done

- Each change implements one slice issue. Write its tests first and watch them
  fail, then make them pass.
- Commit titles are plain sentences ("Refuse a remembered item that holds a
  secret"), not prefixed.
- Update `CHANGELOG.md` under Unreleased for anything a user would notice.
- Every GitHub Action is pinned to a full commit SHA with a version comment.
  `npm run check:pins` enforces it.

## Code copied from Review Voice and Orbit

Some modules are copied from [Review Voice](https://github.com/QuintinBotes/review-voice)
and [Orbit](https://github.com/QuintinBotes/orbit), both MIT. Each copied file
says so in its header, with the path it came from. Keep that header when you
change the file.
