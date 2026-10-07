# Claude Code

Claude Code installs the Cavelon plugin from this repository's marketplace:
the four skills and the `cavelon` MCP server, as one unit it updates and
removes. Other clients: [Install the kit in your coding agent](README.md).

## Install

`cavelon setup` does it for you (user scope), then logs you in. By hand, for
yourself in every project:

```bash
claude plugin marketplace add goodguys-gmbh/cavelon-dev-kit
claude plugin install cavelon@cavelon-dev-kit
```

For everyone who works on one repository, run this in the repository and
commit `.claude/settings.json`; Claude Code then offers the plugin to each
person who opens it:

```bash
claude plugin marketplace add goodguys-gmbh/cavelon-dev-kit --scope project
claude plugin install cavelon@cavelon-dev-kit --scope project
```

**Without access to GitHub:** download `cavelon-marketplace.tar.gz` from a
release ([The packages](README.md#the-packages)), unpack it into a folder, and
add that folder as the marketplace:

```bash
mkdir cavelon-marketplace && tar -xzf cavelon-marketplace.tar.gz -C cavelon-marketplace
claude plugin marketplace add ./cavelon-marketplace
claude plugin install cavelon@cavelon-dev-kit
```

**Native Windows:** the plugin starts its MCP server through `sh`, which
Windows does not have. `cavelon setup` adds the server to Claude Code's MCP
file for you; by hand, see [Windows](../installation.md#windows). In WSL,
everything works as on Linux.

## Log in

Once, in a terminal of your own: `cavelon login --instance https://cavelon.example.com`
([The first login](README.md#the-first-login)).

## Check

```bash
claude plugin details cavelon@cavelon-dev-kit   # Skills (4): cavelon-authoring, cavelon-long-running, cavelon-loop, cavelon-testing; MCP servers (1): cavelon
claude mcp list                                 # plugin:cavelon:cavelon: sh -c if command -v cavelon … - ✔ Connected
cavelon setup --check --agents claude            # the plugin, the server starting, the login
```

In a session, `/mcp` lists the server and its tools.

## Update

```bash
claude plugin marketplace update cavelon-dev-kit
claude plugin update cavelon@cavelon-dev-kit
```

From an unpacked `cavelon-marketplace.tar.gz`, unpack the new release's file
over the same folder first. When the plugin is behind, the MCP server says so
in the session, with these commands.

## Remove

```bash
claude plugin uninstall cavelon@cavelon-dev-kit
claude plugin marketplace remove cavelon-dev-kit
```

`cavelon setup --remove` does both when `setup` installed them.
