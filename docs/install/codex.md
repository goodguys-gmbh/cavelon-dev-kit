# Codex

Codex installs the Cavelon plugin from this repository's marketplace: the four
skills and the `cavelon` MCP server, as one unit it updates and removes. Other
clients: [Install the kit in your coding agent](README.md).

## Install

`cavelon setup` does it for you, then logs you in. By hand:

```bash
codex plugin marketplace add goodguys-gmbh/cavelon-dev-kit
codex plugin add cavelon@cavelon-dev-kit
```

Codex installs plugins for your user. To give everyone on a repository the
skills and the MCP server, commit what `cavelon init --agents codex` writes into
the solution folder ([Agents without a plugin](../installation.md#agents-without-a-plugin)).

**Without access to GitHub:** download `cavelon-marketplace.tar.gz` from a
release ([The packages](README.md#the-packages)), unpack it into a folder, and
add that folder as the marketplace:

```bash
mkdir cavelon-marketplace && tar -xzf cavelon-marketplace.tar.gz -C cavelon-marketplace
codex plugin marketplace add ./cavelon-marketplace
codex plugin add cavelon@cavelon-dev-kit
```

**Native Windows:** the plugin starts its MCP server through `sh`, which
Windows does not have. `cavelon setup` adds the server to `~/.codex/config.toml`
for you; by hand, see [Windows](../installation.md#windows).

## Log in

Once, in a terminal of your own: `cavelon login --instance https://cavelon.example.com`
([The first login](README.md#the-first-login)).

## Check

```bash
codex plugin list    # cavelon@cavelon-dev-kit  installed, enabled
codex mcp list       # cavelon  sh  -c if command -v cavelon …  enabled
cavelon setup --check --agents codex
```

In a session, `/mcp` lists the server and its tools.

## Update

After updating the CLI, refresh the plugin and all four skills together:

```bash
cavelon setup --update --agents codex
```

The install/update script offers this same update. Start a new Codex session
afterwards to load the refreshed skills.

Setup detects how the marketplace was registered. A Git source is updated
before refreshing the plugin. A local source is read as it stands: setup does
not pull a developer checkout or replace offline files. Unpack the new offline
release into the registered folder, or update your checkout yourself, first.

By hand, for a **Git marketplace**:

```bash
codex plugin marketplace upgrade cavelon-dev-kit
codex plugin add cavelon@cavelon-dev-kit
```

For a **local marketplace**, refresh its files first, then run only:

```bash
codex plugin add cavelon@cavelon-dev-kit
```

If Codex says the marketplace “is not configured as a Git marketplace”, it
was registered from a directory. Check it with
`codex plugin marketplace list --json`. To switch an existing online
installation to the official Git source:

```bash
codex plugin marketplace remove cavelon-dev-kit
codex plugin marketplace add goodguys-gmbh/cavelon-dev-kit
codex plugin add cavelon@cavelon-dev-kit
```

Removing the registration keeps the original local directory. Keep local
registration for offline use; it needs no Git upgrade.

## Remove

```bash
codex plugin remove cavelon@cavelon-dev-kit
codex plugin marketplace remove cavelon-dev-kit
```

`cavelon setup --remove` does both when `setup` installed them.
