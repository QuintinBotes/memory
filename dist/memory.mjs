#!/usr/bin/env node

// src/version.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
function pluginVersion() {
  const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof parsed.version === "string" ? parsed.version : "0.0.0-unknown";
}

// src/cli.ts
var USAGE = `usage: memory <command>

  --version   print the version`;
var [command] = process.argv.slice(2);
if (command === "--version") {
  console.log(pluginVersion());
} else {
  console.error(USAGE);
  process.exitCode = command === void 0 || command === "--help" ? 0 : 2;
}
