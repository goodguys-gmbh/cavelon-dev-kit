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

```bash
codex plugin marketplace upgrade cavelon-dev-kit
codex plugin add cavelon@cavelon-dev-kit
```

From an unpacked `cavelon-marketplace.tar.gz`, unpack the new release's file
over the same folder first.

## Remove

```bash
codex plugin remove cavelon@cavelon-dev-kit
codex plugin marketplace remove cavelon-dev-kit
```

`cavelon setup --remove` does both when `setup` installed them.
