# Install the kit in your coding agent

Each page below installs the Cavelon dev-kit in one client: the four Cavelon
skills (`cavelon-loop`, `cavelon-authoring`, `cavelon-testing`,
`cavelon-long-running`) and the `cavelon` MCP server. Each covers the install,
the first login, how to check that the agent lists the skills and tools,
updating and removing.

Version 0.1.16 adds OpenCode and Pi with bundled native adapters, and Qwen
Code CLI with native settings and person-terminal approval. See the
[qualification matrix](../coding-agent-qualification.md) for tested versions,
platforms and limits. Cline, Kilo, Goose and OMP remain planned separately.

| Client | Installs as | Page |
|---|---|---|
| Claude Code | the plugin, from this repository's marketplace | [Claude Code](claude-code.md) |
| Codex | the plugin, from this repository's marketplace | [Codex](codex.md) |
| Cursor | the skills and MCP entry (`cavelon setup`), or the Agent Plugins package as a local plugin | [Cursor](cursor.md) |
| VS Code with GitHub Copilot, Copilot CLI | the skills and MCP entry (`cavelon setup`), or the plugin from this repository's marketplace or the release's package | [VS Code and Copilot](vscode-copilot.md) |
| Kiro | the skills and MCP entry (`cavelon setup`), or the Agent Plugins package as a power | [Kiro](kiro.md) |
| Gemini CLI | the extension, from the release | [Gemini CLI](gemini-cli.md) |
| OpenCode | bundled native server/TUI plugins and skills (`cavelon setup`) | [OpenCode](opencode.md) |
| Pi | bundled native extension and skills (`cavelon setup`) | [Pi](pi.md) |
| Qwen Code CLI | native MCP settings and skills (`cavelon setup`); guarded changes in the person's own terminal | [Qwen Code](qwen-code.md) |
| Cloud agents and CI | `npx` or `uvx`, with the skills committed to the repository | [Cloud agents and CI](cloud-and-ci.md) |

**The quickest way** on your own computer: install `cavelon`
([Installation](../installation.md#install-the-cli)), then run `cavelon setup`. It
finds the clients supported by your installed release and sets each up the way its page
recommends, then logs you in. The pages say what it does per client and how to
do the same by hand.

## The packages

Each release attaches the plugin packages, rendered from the one plugin source
in [`plugin/`](../../plugin/) (`packaging/plugins.mjs`), with their checksums in
`checksums-plugins.txt` and build provenance you can check with
`gh attestation verify <file> --repo goodguys-gmbh/cavelon-dev-kit`:

| File | Format | For |
|---|---|---|
| `cavelon-agent-plugin.tar.gz` | [Agent Plugins 1.0](https://agent-plugins.org): `plugin.json`, `mcp.json`, `skills/` | Cursor, VS Code with GitHub Copilot, Copilot CLI and Kiro, on macOS and Linux |
| `cavelon-agent-plugin-windows.tar.gz` | the same | the same clients on Windows |
| `darwin.cavelon-gemini-extension.tar.gz`, `linux.…`, `win32.…` | a Gemini CLI extension: `gemini-extension.json`, `skills/` | Gemini CLI on macOS, Linux and Windows |
| `cavelon-marketplace.tar.gz` | `plugin/` with both marketplaces | Claude Code and Codex on a machine that cannot reach GitHub |

The newest release's files are at
`https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/<file>`.
For a machine that reaches neither GitHub nor npm, the
[offline bundle](../offline-bundle.md#the-plugin-packages) carries the same
packages in their offline variant, whose MCP entry is `cavelon mcp` and never
npx.
Unpack one into a folder of its own:

```bash
mkdir cavelon-plugin && tar -xzf cavelon-agent-plugin.tar.gz -C cavelon-plugin
```

(`tar` is part of Windows 10 and newer too.) Every package starts the MCP
server the same way: on macOS and Linux `cavelon mcp` when a `cavelon` is on
your `PATH`, and otherwise `npx -y @cavelon/cli@0.1 mcp`; the Windows packages
start `cmd /c npx -y @cavelon/cli@0.1 mcp`, which needs Node.js. Each says its
version to `cavelon`, which tells the agent when a newer release is out
([Updating](../installation.md#when-you-work-only-through-a-coding-agent)).

Use one way per client: the plugin or `cavelon setup`'s files, not both, so the
agent does not see the skills and tools twice.

## The first login

Every client's MCP server acts with the token you store once with `cavelon login`,
in a terminal of your own:

```bash
cavelon login --instance https://cavelon.example.com
```

Without `cavelon` installed, `npx -y @cavelon/cli login --instance …` or
`uvx cavelon login --instance …` does the same. [Getting started](../getting-started.md#2-log-in)
shows what it asks. `cavelon whoami` says as whom you are logged in.
