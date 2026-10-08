# Goose

Unreleased setup support targets Goose CLI 1.53.0. The
[qualification matrix](../coding-agent-qualification.md) records actual client
loading and person interaction separately. Goose Desktop, ACP hosts and other
versions need their own UI checks.

## Install

Provision Goose using its [official instructions](https://goose-docs.ai/docs/getting-started/installation/),
then [install Cavelon](../installation.md#install-the-cli). In your own terminal,
with a kit release that includes this integration:

```bash
cavelon setup --agents goose
```

Setup adds only `extensions.cavelon` to Goose's user `config.yaml` and copies
the four marked skills to that configuration directory's `skills/` folder.
Goose's native skill loader reads this directory. The extension entry uses
`type: stdio`, `name: cavelon`, `enabled: true`, `cmd` and `args`. Setup retains
other extensions, provider settings, comments, formatting and file permissions.
It does not change tool permissions, models or credentials.

The default configuration directory is `~/.config/goose/` on Linux and macOS,
or `%APPDATA%\Block\goose\config\` on Windows. An absolute `XDG_CONFIG_HOME`
changes the Linux/macOS location to `<XDG_CONFIG_HOME>/goose/`. An absolute
`GOOSE_PATH_ROOT` takes precedence on every platform: configuration and installed
skills go under `<GOOSE_PATH_ROOT>/config/`. Relative path-root and XDG overrides
are ignored by the native resolver. Keep these overrides identical for setup
and Goose; setup does not expand a literal `~` in them.

Goose merges system configuration (`/etc/goose/config.yaml`, or
`%PROGRAMDATA%\goose\config.yaml` on Windows), files named by
`GOOSE_ADDITIONAL_CONFIG_FILES`, and user configuration. Setup inspects the
first two layers without editing them. A Cavelon binding in either layer,
another extension with Cavelon's name, an active extension allowlist, or
ambiguous YAML requires person/operator review. Setup never shadows that
binding or fetches an allowlist. Existing YAML aliases, anchors, tags and merge
keys require manual configuration rather than a guessed rewrite.

For project skills:

```bash
cd your-solution
cavelon init --agents goose
```

Init copies the shared skills into `.agents/skills/`. It does not invent a
project Goose MCP configuration: run user setup for the extension entry.

## Log in

Setup offers [normal token login](../getting-started.md#2-log-in). Enter your
token only at the hidden prompt in your own terminal, outside the coding
client's environment. Never put it in Goose's config, a model prompt or git.

## Check

```bash
cavelon setup --agents goose --check
goose info
goose skills list
```

Check that Goose reports the same configuration directory and all four Cavelon
skills, then ask for a read such as `whoami`. Restart a running client after
setup. File checks certify neither Desktop's dialog nor a different host's
elicitation handler. Recipes, `--no-profile` and per-run extension overrides
can change what Goose actually loads; review those in that session.

In multi-solution repositories, retain `solution_dir`, such as
`solutions/review`, on every child-solution MCP call, including preview and
confirmation. `harness` selects the instance solution, not its local folder.
See [folder selection](../mcp.md#several-solutions-in-one-repository).

## Approval

The interactive Goose CLI has a built-in MCP form for Cavelon's exact change.
Only your fresh **Yes** may approve that request. **No**, cancellation or a
missing interactive terminal sends no instance confirmation or guarded change.
Automatic tool permissions do not answer this separate form. Goose 1.53.0
expires its own form after five minutes. An expired form can still be visible;
a late answer cannot approve it. Start a new preview and fresh form instead.

Plain `goose run` is headless even when launched in a terminal. Use an
interactive session, or `goose run --interactive`, for person forms. Headless
Goose cancels the pending elicitation; do not pipe an answer or let the agent
rerun with unattended approval. To complete that change instead, create/review
a fresh preview and run its confirmation command yourself in your separate
terminal. No native Cavelon plugin is needed for the CLI's built-in form.

The instance binds its confirmation to the token, tenant and exact request;
it does not verify that a person answered. There is no extra Admin approval.
Database passwords, privilege acknowledgement and **Allow write queries**
remain person-only Admin settings.

## Guarded shell

Goose 1.53.0's developer shell marks its session with `AGENT_SESSION_ID`, which
the kit recognizes. Use an additional process-scoped launch marker so modes
without that session marker retain the guard:

```bash
CAVELON_AGENT=1 goose session
```

On PowerShell, set `$env:CAVELON_AGENT = '1'` in a dedicated client-launch
terminal before starting Goose. Keep your person terminal outside that
environment. The kit refuses login input, secret entry and guarded shell
confirmation there. MCP calls are always guarded. These markers prevent
mistakes; the instance enforces the credential's rights independently.
See [shell guards](../security.md#when-the-agent-runs-cavelon-in-its-shell).

## Update

Update Cavelon, then rerun `cavelon setup --agents goose` with the same path and
layer overrides. Only owned entries and marked skills are updated. Personal
options, disabled entries and comments inside an entry that cannot be retained
are preserved for review. Refresh project copies with `cavelon init --update`.

For offline use, provision Goose and the model runtime separately. Install
Cavelon's verified [signed bundle](../offline-bundle.md) executable first.
Setup then writes `cavelon mcp` and copies bundled skills without fetching a
plugin, npm package or registry dependency.

## Remove

```bash
cavelon setup --agents goose --remove
```

Removal uses recorded settings and skill paths, even if environment overrides
have since changed. It removes only the owned entry and generated skills,
preserving personal changes, other extensions and comments. Your login stays.
Project copies belong to the repository and are removed separately if unwanted.
