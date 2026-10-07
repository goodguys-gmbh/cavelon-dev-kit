# Kiro

Kiro reads the Cavelon skills and MCP server in two ways. Choose one:

- **`cavelon setup`** (recommended): the server in `~/.kiro/settings/mcp.json`
  and the skills in `~/.kiro/skills/`, for your user. They are always there,
  in the Kiro IDE and in `kiro-cli`, and in custom agents too.
- **A power** from the release's Agent Plugins package
  (`cavelon-agent-plugin.tar.gz`): Kiro [installs it](https://kiro.dev/docs/powers/installation/)
  as one unit. A power is loaded when a prompt names one of its keywords
  (`cavelon`, `cavelon solution`, `cavelon.yaml`, `solution-as-code`), so ask
  for Cavelon work by name. Custom agents load powers only when their file sets
  `includePowers`.

The kit is not in Kiro's powers catalog, and **Import power from GitHub** with
this repository's URL finds no power: install the package from a folder. Other
clients: [Install the kit in your coding agent](README.md).

## Install

**With `cavelon setup`:** install `cavelon` ([Installation](../installation.md#install-the-cli))
and run `cavelon setup`, or `cavelon setup --agents kiro` for Kiro alone.

**As a power:** download the package of your system and unpack it into a folder
([The packages](README.md#the-packages)):

```bash
mkdir cavelon-power
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/cavelon-agent-plugin.tar.gz | tar -xz -C cavelon-power
```

(On Windows, `cavelon-agent-plugin-windows.tar.gz`.) Then:

- **Kiro IDE:** in the Powers panel, **Add Custom Power** → **Import power from
  a folder**, choose the folder, **Install**.
- **`kiro-cli`:** `kiro-cli powers install ./cavelon-power`, or `/powers install ./cavelon-power`
  in a chat.

Kiro copies the power into `~/.kiro/powers/`; the folder can go afterwards. It
runs the power's MCP server itself, under the name `power-cavelon-cavelon`,
not from `~/.kiro/settings/mcp.json`.

## Log in

Once, in a terminal of your own: `cavelon login --instance https://cavelon.example.com`
([The first login](README.md#the-first-login)).

## Check

- **`kiro-cli`:** `/powers` lists `cavelon`; `/mcp` lists the server and its
  tools (`cavelon`, or `power-cavelon-cavelon` from the power); `/context show`
  or `/config skills` lists the skills.
- **Kiro IDE:** the Powers panel shows the power with its skills and MCP
  configuration; with `cavelon setup`, the Kiro panel lists the skills under
  **Agent Steering & Skills** and the server under MCP servers.
- `cavelon setup --check --agents kiro` checks what `cavelon setup` wrote, that
  the server starts, and the login.

## Update

With `cavelon setup`: update `cavelon` ([Updating](../installation.md#updating))
and run `cavelon setup` again. The power: uninstall it and install the new
release's package the same way.

## Remove

`cavelon setup --remove` takes out what `setup` wrote. The power:
`kiro-cli powers uninstall cavelon`, or in the IDE from the Powers panel.

## What was verified

`kiro-cli` 2.28.0, without signing in, installed the unpacked package as the
power `cavelon` and uninstalled it again. Listing its MCP server needs a
signed-in session, which the kit's tests do not have. The package's manifests
are checked against the Agent Plugins 1.0 schemas in CI.
