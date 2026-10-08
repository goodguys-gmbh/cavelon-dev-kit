# OpenCode

Cavelon setup installs dependency-bundled native server and TUI plugins, the
shared CLI/MCP implementation and all four authoritative skills. The native
plugins carry Cavelon's exact-change person dialog through OpenCode's UI;
its built-in MCP path alone does not provide that form capability.

These additions are **Unreleased** and are not in 0.1.15. Packaged-client
qualification remains in [#201](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/201),
following the completed [native prototype](../native-approval-adapters.md#prototype-evidence).

## Install

The qualification target is `opencode-ai` 1.18.35 with separate server/TUI
plugins. Earlier formats need their own compatibility check. Provision
OpenCode through your operator's normal process, then install Cavelon
([Installation](../installation.md#install-the-cli)). In your own terminal:

```bash
cavelon setup --agents opencode
```

Setup uses `$XDG_CONFIG_HOME/opencode`, otherwise `~/.config/opencode`, and
honors `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR`. It selects an existing
compatible JSON/JSONC MCP file, adds the native server to its `plugin` list,
and records the disabled `mcp.cavelon` entry for the adapter's own connection.
Only that Cavelon entry is disabled. Other servers, personal plugins, comments
and existing file permissions remain intact.

The TUI plugin has a separate configuration: an existing `tui.json[c]`, or
`tui.json`. `OPENCODE_TUI_CONFIG` is honored independently of the MCP path;
`OPENCODE_CONFIG_DIR` has the client's higher precedence. Adapters, licenses,
profile and ownership record go into the selected user directory's `cavelon/`.
Native skills go into `skills/`. A person's disabled Cavelon plugin stays off.
Competing entries and inline `OPENCODE_CONFIG_CONTENT` are reported for manual
review rather than shadowed.

For a solution, run `cavelon init --agents opencode` in its folder. A verified
user native installation is reused. Otherwise init writes the project
configuration, `.opencode/cavelon/` assets and portable profile, plus the
shared `.agents/skills` copies. Existing kit-owned project MCP entries can be
migrated to native ownership. Where user and project adapters coexist, the
verified project adapter owns that workspace; the user adapter yields.
Managed directory overrides or disabled project settings are reported.
Ancestor and organization settings can still change what the client loads.

Setup and init prefer `cavelon` on PATH; otherwise they use the npm release
line with platform-aware spawning. For offline use, provision the standalone
Cavelon executable on PATH **before** setup/init. The native dependencies are
bundled and require no runtime package fetch. The client and model runtime must
also be provisioned beforehand. Coding-model and instance execution providers
are separate settings; Cavelon setup does not install or select them.

A recorded MCP entry looks like this with the installed executable:

```json
{
  "mcp": {
    "cavelon": { "type": "local", "command": ["cavelon", "mcp"], "enabled": false }
  }
}
```

Its hash binds the native profile. Do not re-enable the duplicate or edit the
recorded command manually: a changed binding refuses startup. Installing the
executable and repeating setup/init updates a still-owned entry safely.

## Log in

Run `cavelon login --instance https://cavelon.example.com` once in your own
terminal. Credentials stay in Cavelon's credential store, never in OpenCode
configuration, adapter profiles or the repository.

## Check

Run `cavelon setup --check --agents opencode` and restart OpenCode. The file
check verifies assets, ownership, references, server startup and login; it
does not certify actual plugin/UI loading. Inside the client, check that native
`cavelon_` tools appear and invoke a read tool such as `cavelon_whoami`.
`opencode mcp list` should show the duplicate built-in Cavelon entry disabled.
`opencode debug skill` should list all four Cavelon skills.

A root session serving several child solutions passes `solution_dir` on each
MCP/native tool call, including preview and confirmation.
[Folder selection](../mcp.md#several-solutions-in-one-repository) explains why
`harness` alone does not select local files.

## Approval

Each guarded change displays its preview and requires a fresh answer in the
Cavelon dialog. Decline, cancel, timeout and an unavailable UI send no guarded
mutation. Missing UI returns the exact command for your own terminal; the
agent shows it and stops that change. Generic permissions, automatic approval
and remembered answers do not replace your answer. The instance binds the
confirmation to the exact request; it does not verify that a person answered.
Database passwords and **Allow write queries** remain person-only in the Admin.

## Guarded shell

Launch from your own terminal with a process-scoped marker:
`CAVELON_AGENT=1 opencode` on POSIX. In PowerShell, set
`$env:CAVELON_AGENT='1'` only in the terminal used to launch OpenCode. Keep your
separate terminal unmarked; never set the marker globally.

## Update

Update Cavelon, repeat `cavelon setup --agents opencode`, then run
`cavelon init --update` in existing solutions and restart OpenCode. Owned assets
and references update together. Edited assets, references or MCP entries are
preserved and reported instead of overwritten. A moved project keeps its
relative profile paths. If a directory override changes, remove the recorded
user installation before setting up the new location.

## Remove

`cavelon setup --remove --agents opencode` removes the recorded user adapter,
its exact server/TUI references, Cavelon MCP entry and generated user skills.
Removal uses the original recorded paths even after an override changes.
Personal settings and unrelated files remain. An edited native binding or
asset refuses removal so a surviving reference cannot lose its dependency.
Review that conflict manually.

Project integration is tracked in the repository. Review and remove only its
Cavelon plugin references, disabled MCP entry, generated adapter directory and
skill copies; retain other settings and plugins.

## Qualification

The Linux 1.18.35 binary connected to Cavelon and discovered the shared skills.
A separate prototype completed actual person Cancel/Confirm dialogs against a
fake instance. Packaged lifecycle and simulated protocol tests cover config
preservation, rollback, ownership, project precedence and refusal. Actual
packaged-client person dialogs, full journeys and native Windows/WSL
qualification remain open; these tests do not certify those interactions.

Primary references: [configuration](https://opencode.ai/docs/config/),
[MCP](https://opencode.ai/docs/mcp-servers/), [skills](https://opencode.ai/docs/skills/),
[TUI](https://opencode.ai/docs/tui/).
