# Cursor

Cursor reads the Cavelon skills and MCP server in two ways. Choose one:

- **`cavelon setup`** (recommended): the skills in `~/.cursor/skills/` and the
  server in `~/.cursor/mcp.json`, for your user. Works in every Cursor plan, in
  the editor and in the `agent` CLI.
- **The plugin package** (`cavelon-agent-plugin.tar.gz`), in
  [Agent Plugins](https://agent-plugins.org) format, which
  [Cursor loads](https://cursor.com/docs/plugins) as a local plugin. Cursor
  lists it as one plugin you turn on and off.

The kit is not listed in the Cursor Marketplace, and Cursor's plugin install
from a git repository needs its own marketplace file, which this repository
does not have; the local plugin folder is the way in. Other clients:
[Install the kit in your coding agent](README.md).

## Install

**With `cavelon setup`:** install `cavelon` ([Installation](../installation.md#install-the-cli))
and run `cavelon setup`, or `cavelon setup --agents cursor` for Cursor alone.

**As a local plugin:** download the package of your system
([The packages](README.md#the-packages)) and unpack it into
`~/.cursor/plugins/local/cavelon`:

```bash
mkdir -p ~/.cursor/plugins/local/cavelon
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/cavelon-agent-plugin.tar.gz \
  | tar -xz -C ~/.cursor/plugins/local/cavelon
```

On Windows, in PowerShell:

```powershell
$dir = "$HOME\.cursor\plugins\local\cavelon"
New-Item -ItemType Directory -Force $dir | Out-Null
curl.exe -fsSL -o "$env:TEMP\cavelon-agent-plugin.tar.gz" https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/cavelon-agent-plugin-windows.tar.gz
tar -xzf "$env:TEMP\cavelon-agent-plugin.tar.gz" -C $dir
```

Then restart Cursor, or run **Developer: Reload Window**. On a Teams or
Enterprise plan, local plugins load only when an admin turned on **Allow Local
Plugin Imports**. The `agent` CLI loads the folder with
`agent --plugin-dir ~/.cursor/plugins/local/cavelon`.

## Log in

Once, in a terminal of your own: `cavelon login --instance https://cavelon.example.com`
([The first login](README.md#the-first-login)).

## Check

- **Editor:** **Customize** in the sidebar lists the plugin with its four
  skills and the `cavelon` MCP server (with `cavelon setup`: the server under
  MCP, the skills under skills). The MCP logs are in the Output panel, under
  **MCP Logs**.
- **`agent` CLI:** `agent mcp list` lists the server of `~/.cursor/mcp.json`
  (`cavelon setup`); in a session, `/mcp list` lists every server, the plugin's
  too, and `/mcp list-tools cavelon` its tools.
- `cavelon setup --check --agents cursor` checks what `cavelon setup` wrote,
  that the server starts, and the login.

## Update

With `cavelon setup`: update `cavelon` ([Updating](../installation.md#updating))
and run `cavelon setup` again. The plugin: unpack the new release's package over
the same folder, as above, and reload the window.

## Remove

`cavelon setup --remove` takes out what `setup` wrote. The plugin: delete
`~/.cursor/plugins/local/cavelon` and reload the window.

## What was verified

The package's `plugin.json` and `mcp.json` are checked against the Agent
Plugins 1.0 schemas in CI. The kit's tests do not run Cursor itself: the
`agent` CLI loads plugins only in a signed-in session.
