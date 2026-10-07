# VS Code with GitHub Copilot, and Copilot CLI

GitHub Copilot in VS Code and the Copilot CLI read the Cavelon skills and MCP
server in two ways. Choose one per client:

- **`cavelon setup`** (recommended for VS Code): the server in VS Code's user
  `mcp.json` and the skills in `~/.copilot/skills/`. Works without any setting.
- **The Cavelon plugin.** VS Code's [agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)
  and the [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)
  install it from this repository's marketplace (the Claude Code plugin format,
  which both read), or from the release's Agent Plugins package. VS Code's
  agent plugins are off until you turn them on.

Other clients: [Install the kit in your coding agent](README.md).

## Install

**With `cavelon setup`:** install `cavelon` ([Installation](../installation.md#install-the-cli))
and run `cavelon setup`, or `cavelon setup --agents copilot` for VS Code alone.

**The plugin in VS Code**, from this repository's marketplace. In your user
`settings.json` (**Preferences: Open User Settings (JSON)**):

```json
"chat.plugins.enabled": true,
"chat.plugins.marketplaces": ["goodguys-gmbh/cavelon-dev-kit"]
```

Then search the Extensions view for `@agentPlugins cavelon` and choose
**Install** (the first install from a marketplace asks whether you trust it).
**Chat: Install Plugin From Source** with `https://github.com/goodguys-gmbh/cavelon-dev-kit`
does the same without the marketplace setting.

This plugin starts its MCP server through `sh`, as in Claude Code, so on native
Windows use the release's package instead: unpack
`cavelon-agent-plugin-windows.tar.gz` ([The packages](README.md#the-packages))
into a folder and register it in `settings.json`:

```json
"chat.plugins.enabled": true,
"chat.pluginLocations": { "C:\\Users\\you\\cavelon-plugin": true }
```

**The plugin in Copilot CLI:**

```bash
copilot plugin marketplace add goodguys-gmbh/cavelon-dev-kit
copilot plugin install cavelon@cavelon-dev-kit
```

VS Code also loads the plugins Copilot CLI installed. On native Windows, unpack
`cavelon-agent-plugin-windows.tar.gz` and run `copilot plugin install <folder>`
(Copilot CLI warns that installs from a folder will stop working in a future
release).

## Log in

Once, in a terminal of your own: `cavelon login --instance https://cavelon.example.com`
([The first login](README.md#the-first-login)).

## Check

- **VS Code:** **MCP: List Servers** lists `cavelon` (with the plugin, as the
  plugin's server); **Chat: Configure Skills**, or `/skills` in the chat, lists
  the four `cavelon-*` skills. The Extensions view lists the plugin under
  **Agent Plugins - Installed**.
- **Copilot CLI:** `copilot plugin list` shows `cavelon` from `cavelon-dev-kit`;
  `copilot mcp list` shows `cavelon` under **Plugin servers**; `/skills list`
  in a session lists the skills.
- `cavelon setup --check --agents copilot` checks what `cavelon setup` wrote,
  that the server starts, and the login.

## Update

- `cavelon setup`: update `cavelon` ([Updating](../installation.md#updating))
  and run `cavelon setup` again.
- VS Code: **Extensions: Check for Extension Updates** (VS Code also checks
  once a day when extensions update automatically). A package registered with
  `chat.pluginLocations`: unpack the new release's file over the same folder.
- Copilot CLI: `copilot plugin update cavelon`.

## Remove

- `cavelon setup --remove` takes out what `setup` wrote.
- VS Code: right-click the plugin under **Agent Plugins - Installed** and choose
  **Uninstall**; for a folder in `chat.pluginLocations`, remove its line.
- Copilot CLI: `copilot plugin uninstall cavelon`, and
  `copilot plugin marketplace remove cavelon-dev-kit`.

## What was verified

Copilot CLI 1.0.92, without signing in, installed the plugin both from this
repository's marketplace and from the unpacked Agent Plugins package, and
listed the four skills and the `cavelon` plugin server. The package's manifests
are checked against the Agent Plugins 1.0 schemas in CI. VS Code's chat was not
driven by the kit's tests: it needs a signed-in Copilot.
