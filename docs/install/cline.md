# Cline

Unreleased setup support targets `cline` CLI 3.0.70 and the default shared
configuration used by VS Code extension `saoudrizwan.claude-dev` 4.1.23.
CLI and editor evidence are recorded separately in the
[qualification matrix](../coding-agent-qualification.md). Older extensions,
JetBrains and desktop clients need their own checks.

## Install

Provision Cline using its [official instructions](https://docs.cline.bot/getting-started/installing-cline),
then [install Cavelon](../installation.md#install-the-cli). Run in your own
terminal with a kit release that includes this integration:

```bash
cavelon setup --agents cline
```

Setup adds only `mcpServers.cavelon` to
`~/.cline/data/settings/cline_mcp_settings.json` and copies the four marked
skills into `~/.cline/skills/`. It preserves other servers, personal environment
fields and file permissions. Invalid plain JSON or a conflicting Cavelon entry
is left for review. It does not enable Cline's tool auto-approval.

For CLI custom configuration, run setup and Cline with the same absolute
overrides: `CLINE_DIR` changes the configuration root and user skill directory;
`CLINE_DATA_DIR` changes only data, including `settings/`; the exact
`CLINE_MCP_SETTINGS_PATH` selects the MCP file independently. Empty values fall
back to defaults. Cline trims these variables but does not expand a literal
`~` inside them. Mirror CLI `--config` and `--data-dir` options in setup's
environment. Prefer absolute paths when moving between repositories.

The editor's compatibility UI still contains legacy path handling. Use its
default shared paths for this integration; do not assume the CLI's custom
skill root or a different MCP filename works in the editor. Check the file
opened by the editor's MCP settings UI and restart it after setup. Setup does
not migrate an older editor profile's configuration or modify its trust settings.

The editor also filters the MCP process environment. If your login uses a
custom `CAVELON_CONFIG_DIR` or `XDG_CONFIG_HOME`, declare the corresponding
non-secret path in that server's `env` explicitly. The same applies to a custom
cache or credential-store selection. Such a personal entry is preserved by
setup; never put a token or secret in it. Default login locations need no edit.

For project skills:

```bash
cd your-solution
cavelon init --agents cline
```

Init copies skills to `.cline/skills/`, alongside the generic copies. MCP
settings remain at user level: init does not invent a project `.cline/mcp.json`
that Cline would not read. Run user setup for the MCP entry.

## Log in

Setup offers [normal token login](../getting-started.md#2-log-in). Enter your
token only in the hidden prompt in your own terminal, outside the coding
client's environment. Never put it in Cline's settings, a prompt or git.

## Check

```bash
cavelon setup --agents cline --check
cline config --json
```

The CLI configuration should list Cavelon's four skills and MCP server. In the
editor, check its Skills menu and MCP server list separately. Ask for a read
such as `whoami`. A file check or CLI check does not certify the editor UI.

In multi-solution repositories, retain `solution_dir`, such as
`solutions/review`, on every MCP call for that child solution, including its
preview and confirmation. `harness` selects the instance solution; it does not
select its local folder. See [folder selection](../mcp.md#several-solutions-in-one-repository).

## Approval

Cline has code plugins and Agent Plugins. Its inspected MCP clients do not
advertise form elicitation, and ordinary tool approval can be automatic.
Guarded Cavelon changes therefore return a preview and exact command for
**your own terminal**. Review it and run it yourself only if you approve this
change. An agent-supplied `confirm`, a tool permission prompt, auto-approval,
headless mode or `yolo` cannot supply your answer.

The instance binds a confirmation to the token, tenant and exact request; it
does not verify that a person answered. No extra Admin approval is added.
Database passwords, privilege acknowledgement and **Allow write queries**
remain person-only Admin settings.

## Guarded shell

Start the CLI from your own terminal with a process-scoped marker:

```bash
CAVELON_AGENT=1 cline
```

For the editor, fully quit VS Code first, change to the repository root and
launch its new process with `CAVELON_AGENT=1 code .`. The MCP server inherits
that startup folder; switching workspaces does not rebind an existing server.
An existing process may retain its earlier folder and environment. Keep your
separate person terminal outside that environment.
On PowerShell, set `$env:CAVELON_AGENT = '1'` in a dedicated client-launch
terminal before starting the client; use another terminal for person steps.

The kit recognizes this inherited marker in shell commands and refuses token
login, secret entry and guarded confirmation there. The marker guards mistakes;
it is not an authorization boundary. MCP calls are always guarded, independently
of shell markers. See [shell guards](../security.md#when-the-agent-runs-cavelon-in-its-shell).

## Update

Update Cavelon, then run `cavelon setup --agents cline` again with the same
configuration overrides. Only owned entries and marked skills are updated.
Refresh project copies with `cavelon init --update` in each solution folder.
Personal edits are preserved and reported for review. Restart the client.

For offline machines, provision Cline separately and install Cavelon's verified
[signed bundle](../offline-bundle.md) executable first. Setup then writes
`cavelon mcp` and copies bundled skills without fetching a plugin or registry
package. Provision the model runtime separately.

## Remove

```bash
cavelon setup --agents cline --remove
```

Removal uses the recorded settings and skill paths, preserving other servers,
personal edits and shared resources. It leaves your login. Project skill copies
belong to the repository and are removed separately if no longer wanted.
