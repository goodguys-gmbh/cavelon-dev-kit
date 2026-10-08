# Pi

Cavelon setup installs a dependency-bundled native extension and all four
shared skills. The extension owns Cavelon's MCP connection and carries its
exact-change person dialog through Pi's UI. It disables only Cavelon's duplicate
built-in MCP entry; other MCP servers keep using Pi's built-in implementation.

Added in kit 0.1.16. The [qualification matrix](../coding-agent-qualification.md)
records the exact tested client version, platform and approval mode.

## Install

The qualification target is `@earendil-works/pi-coding-agent` 1.1.0. Provision
Pi and Cavelon, then run in your own terminal:

```bash
cavelon setup --agents pi
```

Setup honors `PI_CODING_AGENT_DIR`, otherwise using `~/.pi/agent`. It adds its
extension to `settings.json`, records a disabled Cavelon entry in `mcp.json`,
and puts bundled adapters, licenses, profile and ownership record in `cavelon/`.
Shared skills and their resources go into `skills/`. Plain JSON is required;
comments, malformed files and personal Cavelon entries are refused. Other
servers, extensions and existing file permissions remain intact.

A solution's `cavelon init --agents pi` reuses a verified user native
installation. Otherwise it creates `.pi/mcp.json`, a reference in
`.pi/settings.json`, portable `.pi/cavelon/` assets and `.pi/skills/`, alongside
the shared skill copies. It adds no other new client's directories. Where user
and project native adapters coexist, the trusted project adapter owns the
workspace and the user adapter yields. **Only the person grants Pi project
trust**; setup does not grant it.

Setup and init prefer `cavelon` on PATH, otherwise the npm release line with
platform-aware spawning. For offline use, provision the standalone Cavelon
executable on PATH **before** setup/init. Native dependencies are bundled;
loading the adapter requires no package fetch. The client and model runtime
must also be provisioned beforehand. Coding-model and instance execution
providers are separate settings; setup does not install or select them.

With the installed executable, the recorded entry looks like this:

```json
{
  "mcpServers": {
    "cavelon": { "command": "cavelon", "args": ["mcp"], "enabled": false }
  }
}
```

Its hash binds the native profile. Do not re-enable the duplicate or edit the
recorded command manually: a changed binding refuses startup. Installing the
executable and repeating setup/init updates a still-owned entry safely.

## Log in

Run `cavelon login --instance https://cavelon.example.com` once in your own
terminal. Credentials stay in Cavelon's store, never in Pi settings, adapter
profiles or the repository.

## Check

Run `cavelon setup --check --agents pi` and reload Pi. The file check verifies
assets, ownership, references, server startup and login; it does not certify
actual UI loading. In Pi, check that native `mcp__cavelon__` tools appear and
invoke a read tool such as `mcp__cavelon__whoami`. The duplicate built-in Cavelon
entry should be disabled in `/mcp`. Load `/skill:cavelon-loop` and check that all
four skills are available.

Old replacement `/mcp` extensions can conflict with native Cavelon tools.
Inspect loaded extensions and resolve that conflict yourself; setup does not
install, disable or grant trust to another extension. A root session serving
several child solutions passes `solution_dir` on every tool call, including
preview and confirmation; see [folder selection](../mcp.md#several-solutions-in-one-repository).

## Approval

Each guarded change displays its preview and requires a fresh answer in Pi's
Cavelon confirmation dialog. Decline, cancel, timeout and an unavailable UI
send no guarded mutation. Missing UI returns the exact command for your own
terminal; the agent shows it and stops that change. Automatic tool permissions
and remembered answers do not replace your answer. The instance binds the
confirmation to the exact request; it does not verify that a person answered.
Database passwords and **Allow write queries** remain person-only in the Admin.

## Guarded shell

Pi 1.1.0 exposes `PI_SESSION_ID` to its bash tool, which Cavelon recognizes.
If session-environment exposure is disabled, launch with a process-scoped
`CAVELON_AGENT=1 pi` on POSIX. In PowerShell set `$env:CAVELON_AGENT='1'` only in
the terminal used to launch Pi. Never set the marker globally: your separate
terminal must remain usable. Environment detection prevents mistakes; it is
not an authorization boundary.

## Update

Update Cavelon, repeat `cavelon setup --agents pi`, then run
`cavelon init --update` in existing solutions and reload Pi. Owned assets and
references update together. Edited assets, references and MCP entries are
preserved and reported instead of overwritten. Moved projects keep their
relative profiles. If `PI_CODING_AGENT_DIR` changes, remove the recorded user
installation before setting up the new location.

## Remove

`cavelon setup --remove --agents pi` removes the recorded user adapter, its
exact extension reference, Cavelon MCP entry and generated user skills.
Original recorded paths are used even after an override changes. Personal
settings and unrelated files remain. Edited native bindings or assets refuse
removal so a surviving reference cannot lose its dependency; review the
conflict manually.

Project integration is tracked in the repository. Review and remove only its
Cavelon extension reference, disabled MCP entry, generated adapter directory
and skill copies, keeping the other settings and extensions.

## Qualification

The [0.1.16 qualification matrix](../coding-agent-qualification.md) records
released-client runtime checks, person interaction and platform limits.
Configuration lifecycle tests cover preserved personal settings, ownership,
updates/removal and refusal. A fake local instance supplies synthetic data;
there are no model calls or real database execution in these checks. Scripted
answers never count as a person's approval.

Primary references:
[MCP and trust](https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/docs/mcp.md),
[extensions](https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/docs/extensions.md).
