# Qwen Code CLI

Added in kit 0.1.16 for `@qwen-code/qwen-code` 0.25.0 (Node.js 22 or newer).
See the [qualification matrix](../coding-agent-qualification.md) for tested
versions, platforms and limits. Editor integrations
are separate surfaces and are not certified by this CLI page.

## Install

Install Qwen Code through its [official instructions](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/),
then [install Cavelon](../installation.md#install-the-cli) and run in your own
terminal:

```bash
cavelon setup --agents qwen
```

Setup shows its plan before changing your user settings. It adds only
`mcpServers.cavelon` to `~/.qwen/settings.json` and copies the four marked
Cavelon skills into `~/.qwen/skills/`. It preserves comments, other servers,
personal environment fields and file permissions. A conflicting Cavelon
entry or invalid settings are left for review.

`QWEN_HOME` selects the configuration directory directly: setup uses
`<QWEN_HOME>/settings.json` and `<QWEN_HOME>/skills/`, without appending another
`.qwen`. Leading `~` expands to your home folder; relative values resolve from
the working directory. Use an absolute override when starting the client from
different folders. `QWEN_RUNTIME_DIR` changes logs and session output, not these
configuration paths. Windows uses your user home in the same way.

For a project installation:

```bash
cd your-solution
cavelon init --agents qwen
```

This writes `.qwen/settings.json` and `.qwen/skills/`, alongside the generic
skill copies. It does not silently replace a personal user-level Cavelon
server. Project settings and resources depend on the trust you grant in Qwen.
Operator settings and MCP allow/exclude policies are checked without changing
them; a restriction or managed Cavelon binding needs person/operator review.

## Log in

Setup offers the [normal token login](../getting-started.md#2-log-in). You can
also run `cavelon login --instance https://cavelon.example.com` from your own
terminal. Enter the token only in its hidden prompt. Do not send it to Qwen or
put it in Qwen's MCP configuration.

## Check

```bash
cavelon setup --agents qwen --check
qwen mcp list
```

Restart Qwen if it was already open. In its interactive UI, `/mcp` should show
the Cavelon server; `/skills` should list `cavelon-loop`, `cavelon-authoring`,
`cavelon-testing` and `cavelon-long-running`. Ask for a read such as `whoami`
before changing a solution. A kit file/transport check alone does not prove
the client's full UI workflow.

In a multi-solution repository, use `solution_dir`, such as
`solutions/review`, on each MCP call that works on that solution, including
its preview. `harness` selects the instance solution, not its local folder.
See [folder selection](../mcp.md#several-solutions-in-one-repository).

## Approval

Qwen has extensions and hooks. The inspected 0.25.0 MCP client does not
advertise form elicitation, and its documented `elicitation_dialog` hook is
not implemented. Cavelon therefore returns the preview and exact command for
you to run in **your own terminal** for every guarded change. Read that preview
and run the displayed command yourself only if you approve it.

Qwen's tool permission prompt, `yolo`, automatic approval and an agent-supplied
`confirm` do not answer Cavelon's confirmation. A headless run also cannot
confirm. The instance binds its confirmation id to the token, tenant and exact
change; it does not prove a person's answer. No extra Admin approval is added.
The database password, write-privilege acknowledgement and **Allow write
queries** remain person-only Admin settings.

## Guarded shell

Qwen 0.25.0 sets `QWEN_CODE=1` in its shell processes. The kit recognizes it
and refuses token login, secret entry and guarded confirmation there. Ask Qwen
to use the stored login and previews; do person-only steps in a separate
terminal. This marker prevents agent mistakes; it is not an authorization
boundary. See [shell guards](../security.md#when-the-agent-runs-cavelon-in-its-shell).

## Update

Update Cavelon, then run `cavelon setup --agents qwen` again. Setup updates
only its recognized server entry and marked skills. Personal edits to the
server are preserved and reported for review. Project copies update with
`cavelon init --update` from the project folder.

For offline machines, install the verified executable from the
[signed bundle](../offline-bundle.md) first. Setup then writes `cavelon mcp`
and copies bundled skills without fetching from npm. Qwen and its internal
model endpoint must already be provisioned separately.

## Remove

```bash
cavelon setup --agents qwen --remove
```

Removal uses the original recorded paths even if `QWEN_HOME` changed. It removes
only the recognized entry and marked skills; personal entries and unrelated
settings remain. This command removes the user installation. Review project
copies in version control separately.

## Qualification

The [0.1.16 qualification matrix](../coding-agent-qualification.md) records
released-client runtime checks, person interaction and platform limits.
Configuration lifecycle tests cover preserved personal settings, ownership,
updates/removal and refusal. A fake local instance supplies synthetic data;
there are no model calls or real database execution in these checks. Scripted
answers never count as a person's approval.

Configuration and limitations follow Qwen's
[settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/),
[skills](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/),
[MCP](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/) and
[hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/) documentation.
