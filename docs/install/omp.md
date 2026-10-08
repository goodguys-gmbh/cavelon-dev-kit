# OMP (Oh My Pi)

OMP is a separate coding client from Pi. This integration requires
kit 0.1.17 or newer. Configuration and extension APIs were inspected
in `@oh-my-pi/pi-coding-agent` 18.8.5 with Bun 1.3.14. Runtime and actual person
dialog qualification are recorded separately in
[Coding-agent qualification](../coding-agent-qualification.md).

## Install

Install OMP through its [official instructions](https://github.com/can1357/oh-my-pi),
then [install Cavelon](../installation.md#install-the-cli). In your own terminal:

```bash
cavelon setup --agents omp
```

`oh-my-pi` is an alias for `omp`; `pi` continues to select Pi. Setup writes OMP's
native user `mcp.json`, four native skills and a bundled autoload extension. It
disables only the duplicate built-in Cavelon MCP entry. The extension owns its
own stdio connection and can ask for a fresh person answer in the OMP TUI.
Setup preserves personal YAML, legacy settings, other servers and extensions.

The default user directory is `~/.omp/agent`. OMP profiles follow these rules:

| Selection | Agent directory |
|---|---|
| Default | `~/.omp/agent`, or the default `PI_CODING_AGENT_DIR` override |
| `OMP_PROFILE=work` | `~/.omp/profiles/work/agent`; ignores the default agent-directory override |
| `PI_PROFILE=work` | Legacy fallback when `OMP_PROFILE` is absent |
| `PI_CONFIG_DIR=.custom-omp` | Changes the config root under your home |

Use the same profile environment for Cavelon setup/check/update and OMP. An
explicitly empty `OMP_PROFILE` selects the default instead of inheriting
`PI_PROFILE`. Match OMP's `--profile` flag by setting `OMP_PROFILE` for setup.
XDG data/cache migration does not move this MCP and skill configuration.

The extension entry is `extensions/cavelon.js`; its bundled assets, profile and
ownership record are in `cavelon/` alongside `mcp.json`. It loads without npm or
npx. Setup refuses conflicting native/compatible Cavelon entries, a personal
autoload entry, ambiguous configuration, and Cavelon in the person's
`disabledServers` or `enabledServers` policy. Review these settings in OMP;
setup never clears them for you. Configured packages, command-line extension
flags and custom discovery policies still need runtime inspection.

## Log in

Run [login](../getting-started.md#2-log-in) yourself. Keep credentials out of chat,
source control and agent-authored config. Choose the intended tenant before
opening a coding session:

```bash
cavelon login --instance https://your-instance.example
cavelon use
```

Launch OMP from the repository root with the shell guard scoped to that process:

```bash
CAVELON_AGENT=1 omp
```

For PowerShell, set `$env:CAVELON_AGENT = '1'` in OMP's launch terminal. Use a
separate person's terminal for person-only commands. The loaded Cavelon
extension also marks its process, but the explicit guarded launch covers
sessions that disable or fail to load extensions. See [Security](../security.md).

For a project installation, run `cavelon init --agents omp`. It writes
`.omp/mcp.json`, `.omp/skills/` and `.omp/extensions/cavelon.js`, with a portable
project profile. Grant project trust in OMP yourself. A verified user adapter
already serving the project prevents an unnecessary duplicate project adapter.

## Check

```bash
cavelon setup --agents omp --check
```

This checks recorded files and process ownership. In OMP, also inspect the
loaded extension and four Cavelon skills and ask it to call `whoami`. Native
tools use the `mcp__cavelon__` prefix and are essential tools. File checks cannot
prove a TUI loaded correctly or that custom extension/discovery settings permit
it. RPC, print and ACP surfaces require their own qualification.

### Approve a guarded change

The extension displays the exact preview in the native TUI. Read every preview
page and answer the final confirmation yourself. Refusal, timeout, cancellation,
missing UI or a disconnected session approves nothing. A new change needs a
fresh answer; generic tool approval, automatic mode and earlier answers do not
approve Cavelon's guarded changes. The instance binds the confirmation to the
token, tenant and exact request; it does not verify who answered the dialog.

Print and RPC modes return the exact command for your own terminal. The coding
agent must not run it for you or supply its confirmation. Database connection
passwords and **Allow write queries** still stay with you in the Admin.

For a multi-solution repository, open OMP at its root and pass
`solution_dir: "solutions/<slug>"` to solution tools. `harness` chooses a solution
on the instance; it does not choose a local folder. Preview ids stay confined to
the selected solution directory. See [MCP](../mcp.md).

## Update

[Update the CLI](../installation.md#updating), then run setup again with
the same OMP profile. The kit replaces only recorded bytes and settings it
still owns. Personal edits cause a refusal and remain preserved. Remove the
recorded integration before changing its directory or profile configuration.

## Remove

```bash
cavelon setup --agents omp --remove
```

Removal follows the recorded directory even if your environment changed. It
removes the owned autoload entry, bundled assets, skills and Cavelon MCP entry,
leaving personal settings and other clients intact. Edited files are preserved;
review them before manual removal. Restart OMP after changing its integration.

For isolated networks, provision OMP, Bun and your approved model endpoint
separately; use the [offline bundle](../offline-bundle.md). Installing Cavelon
does not configure the client's model provider or certify its network policy.
