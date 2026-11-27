#!/bin/bash
# End-to-end (#112): real Claude Code sessions with this checkout's plugin, a throwaway data folder and a synthetic
# acme/api repository. Needs a signed-in `claude`; not run in CI. Exits non-zero on the first check that fails.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="$ROOT/dist/memory.mjs"
BASE=$(mktemp -d "${TMPDIR:-/tmp}/memory-e2e-XXXX")
trap 'rm -rf "$BASE"' EXIT
export MEMORY_DATA_DIR="$BASE/data"
REPO="$BASE/api"
mkdir -p "$REPO/src"
cd "$REPO"
git init -q -b main
git remote add origin https://github.com/acme/api.git
printf 'export function consume(amount) {\n  return amount;\n}\n' > src/ledger.ts
git add -A
git -c user.email=e2e@example.com -c user.name=e2e commit -qm init

fail() { echo "FAIL $1" >&2; exit 1; }
ask() { claude -p "$1" --plugin-dir "$ROOT" --allowedTools "$2" --max-turns 4 < /dev/null 2>&1; }

echo "== SC4 the plugin validates and the review pane's tests pass"
claude plugin validate "$ROOT" --strict > /dev/null || fail "SC4 claude plugin validate --strict"
claude plugin test "$ROOT" > /dev/null || fail "SC4 claude plugin test"

node "$CLI" init --tenant 'acme=acme/*' --bind acme --confirm > /dev/null
ID=$(node "$CLI" remember --anchor src/ledger.ts:1-3 -- 'consume() must stay idempotent: a retried call must not charge twice' | grep -o 'm-[0-9a-f]*' | head -1)
[ -n "$ID" ] || fail "remember printed no id"

echo "== SC1 the item anchored to src/ledger.ts reaches an agent that reads it"
out=$(ask "Read src/ledger.ts. Then print the id of every memory item you were shown about it, or NONE." Read)
grep -q "$ID" <<< "$out" || fail "SC1 $ID not shown: $out"

echo "== SC2 memory_search over MCP finds it"
out=$(ask "Call the memory_search tool with query 'retried charge'. Print the item ids it returns, or NONE." 'mcp__plugin_memory_memory__memory_search')
grep -q "$ID" <<< "$out" || fail "SC2 $ID not found: $out"

echo "== SC3 memory_propose: refused for automation until opted in, then in review naming the agent"
PROPOSE="Call memory_propose with statement 'Ledger amounts are integers in cents', scope repository, type convention, evidence source 'e2e-check'. Print the result."
ask "$PROPOSE" 'mcp__plugin_memory_memory__memory_propose' > /dev/null
[ "$(node "$CLI" review --json | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).proposals.length)')" = 0 ] || fail "SC3 an automation session proposed without the opt-in"
node "$CLI" init --automation on --confirm > /dev/null
ask "$PROPOSE" 'mcp__plugin_memory_memory__memory_propose' > /dev/null
node "$CLI" review --json | node -e '
  const { proposals } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const p = proposals.find((x) => x.statement === "Ledger amounts are integers in cents");
  if (!p || !p.evidence.some((e) => e.agent)) { console.error("FAIL SC3 proposal missing or names no agent: " + JSON.stringify(proposals)); process.exit(1); }
'
echo "PASS end to end"
