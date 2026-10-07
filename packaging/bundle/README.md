# The Cavelon dev-kit, offline

This folder is a release of the Cavelon dev-kit for a machine that reaches
neither GitHub, npm nor PyPI: the `cavelon` CLI and MCP server for every
platform, the Cavelon plugin for Claude Code and Codex, the skills, and the
plugin packages for other clients. `manifest.json` lists every file with its
size and SHA-256, the version, and the instance contract versions this release
understands.

Check the bundle before you use it; the format and every step are in
[docs/offline-bundle.md](https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/offline-bundle.md)
in the dev-kit's repository.

| Path | What |
|---|---|
| `manifest.json` | the files, their sizes and SHA-256, the version and the instance contract versions |
| `bin/` | `cavelon-<os>-<arch>[.exe]`, `checksums.txt`, `install.sh` and `install.ps1` |
| `plugin/` | the plugin for Claude Code and Codex; its MCP entry starts the `cavelon` on your PATH |
| `.claude-plugin/`, `.agents/plugins/` | the marketplaces, so this folder is a local marketplace |
| `skills/` | the skills, for agents without a plugin |
| `mcp/cavelon.mcp.json` | the MCP entry for agents without a plugin |
| `plugin-packages/` | the plugin packages for other clients; their MCP entry is `cavelon mcp`, never npx |

## Install

macOS and Linux, from this folder:

```bash
CAVELON_DOWNLOAD_URL="$PWD/bin" sh bin/install.sh
```

Windows (PowerShell), from this folder:

```powershell
$env:CAVELON_DOWNLOAD_URL = "$PWD\bin"; & .\bin\install.ps1
```

Then add the plugin from this folder (`claude plugin marketplace add <this folder>`,
then `claude plugin install cavelon@cavelon-dev-kit`), and log in with
`cavelon login --instance <your instance's URL>`.
