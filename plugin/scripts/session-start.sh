#!/bin/sh
# SessionStart precedes MCP initialization. Check local prerequisites only;
# discovering tools and calling whoami must use the actual agent session.

root=${CLAUDE_PROJECT_DIR:-$PWD}
directory=$root
solution=false
while [ -n "$directory" ]; do
  if [ -f "$directory/cavelon.yaml" ]; then solution=true; break; fi
  [ "$directory" != / ] || break
  parent=${directory%/*}
  [ "$parent" != "$directory" ] || break
  directory=${parent:-/}
done

# A repository root can contain several solutions, commonly solutions/<name>.
if [ "$solution" = false ]; then
  for file in "$root"/*/cavelon.yaml "$root"/*/*/cavelon.yaml; do
    if [ -f "$file" ]; then solution=true; break; fi
  done
fi
[ "$solution" = true ] || exit 0

if command -v cavelon >/dev/null 2>&1 || command -v npx >/dev/null 2>&1; then
  message='Cavelon: the MCP connection is not yet verified for this session. The agent must check it before instance work; loaded skills alone do not prove a connection.'
else
  message='Cavelon tools cannot start: neither cavelon nor npx is on this session PATH. Install the Dev-Kit, restart Claude Code, then open /mcp to check the Cavelon server. Local file editing remains available.'
fi

# All output is static: no hook input, file content, credential or local path
# can become model instructions or invalid JSON. Never launch npx here.
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Before Cavelon instance work, load cavelon-loop and verify the actual session connection. Discover Cavelon tools using the client tool search, then call whoami through MCP for the selected solution folder. If tools are unavailable or whoami fails, tell the person immediately, distinguish missing login from an unreachable instance, and give a repair step. A separate cavelon setup --check process does not verify this session. Announce any CLI fallback explicitly and check its whoami before using it. Local authoring can continue without claiming live validation, tests or deployment. Report once when readiness is established or changes; do not repeat the same warning on each call."}}\n' "$message"
