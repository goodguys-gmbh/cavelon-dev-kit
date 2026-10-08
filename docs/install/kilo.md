# Kilo CLI and current VS Code extension

Kit 0.1.17 targets `@kilocode/cli` 7.8.8 and the
`kilocode.kilo-code` VS Code extension 7.8.8. Their shared backend uses Kilo's
native configuration and skills. Older editor formats, JetBrains, remote
sessions and other versions need separate qualification. See the
[qualification matrix](../coding-agent-qualification.md).

## Install

Provision Kilo through your operator's normal process, then install Cavelon
([Installation](../installation.md#install-the-cli)). Once your kit release
includes this integration, run in your own terminal:

```bash
cavelon setup --agents kilo
```

Setup installs four native skills and dependency-bundled server/TUI plugins.
It records `mcp.cavelon` with `type: local`, a command array and
`enabled: false`: the native adapter owns that connection, so only the
duplicate built-in Cavelon MCP entry is disabled. Other servers, personal
plugins, comments and file permissions are preserved. Do not re-enable the
duplicate or edit its command manually; the native profile binds that entry.

The default user directory is `$XDG_CONFIG_HOME/kilo`, otherwise
`~/.config/kilo`, including on Windows. Setup selects an existing Kilo
JSON/JSONC file or creates `kilo.json`. It also inspects `config.json`, home
`.kilo`/`.kilocode` directories and compatible `opencode.json[c]` files.
An existing OpenCode-compatible Cavelon binding is reported for review;
setup does not migrate it or modify that other client's file. Competing
Cavelon entries are also reported instead of guessing their precedence.

`KILO_CONFIG` adds an explicit MCP configuration file; it does not replace
the global directory. `KILO_CONFIG_DIR` adds a configuration directory and
selects its `skills/` and `cavelon/` destinations. The TUI has independent
`tui.json[c]` settings and a `KILO_TUI_CONFIG` override. Keep the same overrides
when starting the client and running setup/check. Inline `KILO_CONFIG_CONTENT`,
operator-defined Cavelon entries and macOS managed preferences require manual
review. A person's disabled Cavelon plugin stays off.

Run `cavelon init --agents kilo` in a solution folder for native `.kilo/skills`
and shared skill copies. It reuses a verified user adapter. Otherwise it
writes project `kilo.json`, server/TUI references and portable
`.kilo/cavelon/` assets. A verified project adapter takes precedence over the
user adapter. Inherited Cavelon bindings, disabled project configuration and
configuration-directory overrides are diagnosed before project setup.

Setup prefers `cavelon` on PATH, with a platform-aware npm fallback when it
is absent. For offline use, provision the standalone executable on PATH
**before** setup/init. Native dependencies are bundled; loading them performs
no package fetch. Provision the coding client and its model separately.
Cavelon setup does not install or select a coding model or an instance provider.

## Log in

Run `cavelon login --instance https://cavelon.example.com` once in your own
terminal. Credentials stay in Cavelon's credential store, never in Kilo
configuration, adapter profiles or the repository.

## Check

Run `cavelon setup --check --agents kilo`, then restart the coding client.
The file check verifies ownership, assets, references, MCP startup and login;
actual UI loading and remote organization policies must be checked in Kilo.
Inspect its effective configuration and verify that native `cavelon_` tools
are available. Use `cavelon_whoami` as a read check. `kilo mcp list` should
show the duplicate built-in Cavelon entry disabled; `kilo debug skill` should
list all four Cavelon skills.

The native server also checks its effective Cavelon entry before each tool
dispatch. A project, environment, plugin or managed overlay that changes the
binding refuses the call. Review that policy instead of enabling a duplicate.

For the editor, fully quit VS Code and start a fresh guarded process from
the repository root. The editor backend selects a directory for its session;
verify the intended workspace before using the tools. For a multi-solution
root, pass `solution_dir` on every tool call, including preview and
confirmation. `harness` selects the instance solution, not its local folder;
see [folder selection](../mcp.md#several-solutions-in-one-repository).

## Approval

In the CLI TUI, each guarded change displays Cavelon's exact preview and asks
for a fresh person answer. Decline, cancel, timeout and missing UI send no
guarded mutation. Generic permission prompts, automatic modes and remembered
answers do not replace that answer.

The editor and headless modes use the person's own terminal. The agent shows
the preview and prepared command; you review and run it outside the coding
agent's terminal. A missing native UI also returns this route. The agent must
never answer the dialog or run the person-only command for you.

The instance binds a confirmation to the token, tenant and exact request;
it does not prove a person answered. Database passwords, privilege
acknowledgement and **Allow write queries** remain person-only in the Admin.

## Guarded shell

Launch the coding client with a process-scoped marker:

```bash
CAVELON_AGENT=1 kilo
# Fully quit VS Code first; start this new process from the repository root.
CAVELON_AGENT=1 code .
```

On Windows, use a dedicated launch process, for example
`cmd /c "set CAVELON_AGENT=1&& kilo"`. The native server additionally marks
Kilo's shell calls through its `shell.env` hook. The launch marker protects
commands when that plugin is unavailable. Keep your separate person's
terminal unmarked and never configure the marker globally.

## Update

Update Cavelon, repeat `cavelon setup --agents kilo`, run
`cavelon init --update` in existing solutions, then restart the client.
Owned assets, entry bindings and references update together. Edited assets,
entries or references are preserved and reported. Moving a project keeps
its relative profile paths. If the configuration directory changes, remove
the recorded user integration before setting up the new destination.

## Remove

`cavelon setup --remove --agents kilo` removes the recorded user adapter,
its exact server/TUI references, Cavelon entry and generated skills, using
the original recorded paths. Personal settings and unrelated files remain.
Edited native assets or bindings refuse removal so a surviving reference
cannot lose its dependency; review those conflicts manually.

Project integration is tracked in the repository. Review and remove only
its Cavelon references, disabled entry, generated adapter directory and
skill copies; retain other settings and plugins.

Primary references: [CLI MCP](https://kilo.ai/docs/automate/mcp/using-in-cli),
[editor MCP](https://kilo.ai/docs/automate/mcp/using-in-kilo-code),
[released plugin contracts](https://github.com/Kilo-Org/kilocode/tree/42efc95370e61d6668bd2cb05f955228e5d4155a/packages/plugin/src).
