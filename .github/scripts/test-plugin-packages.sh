#!/usr/bin/env bash
# The plugin packages as their clients read them, in a throwaway home: render
# them (packaging/render.mjs plugins), let Gemini CLI validate and install each
# platform's extension and list its skills and MCP server, and compare the
# Agent Plugins schemas kept in contracts/clients/ with the published ones.
# Nothing logs in anywhere. Run it from the repository's root:
#
#   bash .github/scripts/test-plugin-packages.sh
set -euo pipefail

GEMINI_CLI_VERSION="${GEMINI_CLI_VERSION:-0.63.0}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

node packaging/render.mjs plugins --out "$work/packages"
version="$(node -p "require('./cli/package.json').version")"

# The schemas the tests validate against, against what agent-plugins.org publishes now.
for name in plugin mcp; do
  if curl -fsS --max-time 20 -o "$work/$name.schema.json" "https://agent-plugins.org/schemas/1.0.0/$name.schema.json"; then
    if ! cmp -s "$work/$name.schema.json" "contracts/clients/agent-plugins-1.0.0/$name.schema.json"; then
      echo "::warning::agent-plugins.org now publishes another $name.schema.json for 1.0.0; refresh contracts/clients/agent-plugins-1.0.0/ (contracts/README.md)."
    fi
  else
    echo "::warning::agent-plugins.org could not be reached; the kept $name.schema.json was not compared."
  fi
done

# Gemini CLI in a home of its own; its install scripts never run.
export HOME="$work/home" GEMINI_CLI_HOME="$work/home" npm_config_ignore_scripts=true npm_config_cache="$work/npm"
mkdir -p "$HOME" "$work/cwd"
gemini() { (cd "$work/cwd" && npx -y "@google/gemini-cli@$GEMINI_CLI_VERSION" "$@" < /dev/null); }

for platform in darwin linux win32; do
  dir="$work/packages/unpacked/$platform.cavelon-gemini-extension"
  gemini extensions validate "$dir"
done

# The extension of this platform, installed as a person would from a download:
# a local folder asks whether to trust it, which only a person answers.
case "$(uname -s)" in Darwin) platform=darwin ;; *) platform=linux ;; esac
dir="$work/packages/unpacked/$platform.cavelon-gemini-extension"
(cd "$work/cwd" && echo y | npx -y "@google/gemini-cli@$GEMINI_CLI_VERSION" extensions install "$dir" --consent)
# Gemini CLI 0.63 writes this JSON to stderr, and through a pipe only its first 64 KiB: into files, then.
gemini extensions list --output-format json > "$work/list.out" 2> "$work/list.err"
# shellcheck disable=SC2016 # JavaScript, not the shell, reads the ${…} in it.
node -e '
const fs = require("node:fs");
const [out, err, version] = process.argv.slice(1);
const text = [out, err].map((f) => fs.readFileSync(f, "utf8").trim()).find((t) => t.startsWith("["));
if (!text) throw new Error("Gemini CLI listed no extensions as JSON");
const list = JSON.parse(text);
const mine = list.find((e) => e.name === "cavelon");
if (!mine || mine.version !== version || !mine.isActive) throw new Error(`cavelon ${version} is not installed and active: ${JSON.stringify(list)}`);
const skills = (mine.skills ?? []).map((s) => s.name).sort().join(",");
if (skills !== "cavelon-authoring,cavelon-long-running,cavelon-loop,cavelon-testing") throw new Error(`Gemini CLI lists the skills ${skills}`);
if (!mine.mcpServers?.cavelon) throw new Error("Gemini CLI lists no cavelon MCP server");
console.log(`Gemini CLI lists cavelon ${version} with ${skills} and the cavelon MCP server.`);
' "$work/list.out" "$work/list.err" "$version"
gemini extensions uninstall cavelon
