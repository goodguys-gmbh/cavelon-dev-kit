# OpenCode

OpenCode has native plugins, MCP configuration and skill discovery. This setup
installs the shared Cavelon MCP server and skills through configuration. Its
built-in MCP path does not provide the form approval Cavelon requires. Native
dialog integration is being packaged and qualified separately in
[#201](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/201), following
the completed [native prototype](../native-approval-adapters.md#prototype-evidence).

These setup additions are under **Unreleased**. They are not in 0.1.15.

## Install

Install OpenCode through your operator's normal process, then install Cavelon
([Installation](../installation.md#install-the-cli)). In your own terminal:

```bash
cavelon setup --agents opencode
```

Setup uses OpenCode's config directory (`$XDG_CONFIG_HOME/opencode`, otherwise
`~/.config/opencode`) and its native `skills/` directory. It honors
`OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR`, preserves an existing compatible
JSON/JSONC file and writes only `mcp.cavelon`. It refuses competing Cavelon
entries or inline `OPENCODE_CONFIG_CONTENT`; configure those manually rather
than adding a file that shadows your settings. Setup leaves other servers,
comments, personal entries and existing permissions intact.

For a solution repository, run `cavelon init --agents opencode` in it. The
project entry goes into an existing `opencode.json[c]` or
`.opencode/opencode.json[c]`, otherwise `opencode.json`; OpenCode reads the
shared `.agents/skills` copies. Managed directory overrides or disabled project
config are reported rather than bypassed. Ancestor/project and organization
settings can still change the effective client configuration; check inside the
actual client as well.

The installed/offline entry is:

```json
{
  "mcp": {
    "cavelon": { "type": "local", "command": ["cavelon", "mcp"] }
  }
}
```

Setup prefers `cavelon` on PATH. Otherwise it uses the pinned npm release line
and the Windows `cmd /c` form. Project init writes that npm fallback and keeps
a recognized installed or alternate-platform entry during updates. For an
offline project, replace only its Cavelon command with `["cavelon", "mcp"]`.
Provision OpenCode, its model runtime and Cavelon before blocking external
egress. Setup does not install a client or configure its model. Coding-model
and instance execution providers are separate settings.

## Log in

Log in once in your own terminal with
`cavelon login --instance https://cavelon.example.com`. Credentials are stored
by Cavelon, never in OpenCode's configuration.

## Check

Check `cavelon setup --check --agents opencode`, then run `opencode mcp list`
and `opencode debug skill` in the solution. Confirm the server connects and all
four Cavelon skills appear. The setup check verifies files, server startup and
login; it does not certify the client's UI, model or approval capability.

## Approval

Before each guarded change, built-in MCP returns the exact command for the
person's own terminal. The agent shows that command and stops the change; the
person executes it outside the agent-controlled terminal. Generic OpenCode
permissions and remembered answers do not approve a Cavelon change. A native
plugin must pass the fresh-person-dialog checks before native approval is
claimed. Database passwords and **Allow write queries** remain in the Admin.

## Guarded shell

Use a process-scoped agent marker when launching from your own terminal:
`CAVELON_AGENT=1 opencode` on POSIX, or in PowerShell set
`$env:CAVELON_AGENT='1'` only in the terminal used to launch OpenCode. Keep the
person's separate terminal unmarked; never set the marker globally.

## Update

Update Cavelon, then repeat `cavelon setup --agents opencode` and run
`cavelon init --update` in existing solutions. Restart OpenCode afterwards.

## Remove

`cavelon setup --remove --agents opencode` removes the user files it recorded,
including the original config path if an override later changes. Personal
edits remain. Project files are reviewed and removed in the repository.

## Qualification

Qualification candidate: `opencode-ai` 1.18.35. Its Linux binary connected to
Cavelon and discovered the four shared skills in a clean home. The separate
native prototype also completed actual person Cancel/Confirm dialogs against
a fake instance. Packaged native-dialog installation, full journeys, editor
and native Windows/WSL qualification remain separate; simulated approval
tests do not prove those person interactions.

Primary client references: [configuration](https://opencode.ai/docs/config/),
[MCP](https://opencode.ai/docs/mcp-servers/), [skills](https://opencode.ai/docs/skills/).
