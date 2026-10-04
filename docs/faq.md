# Frequently asked questions

## General

### What is the Cavelon dev-kit for?

Building Cavelon solutions the way you build software: in a git repository,
reviewed in pull requests, tested before they go live, and with a coding agent
doing much of the work. Instead of clicking through the Admin, you (or your
agent) edit files, preview the change, import it, upload knowledge, run tests,
read traces and activate.

### Do I need a coding agent?

No. Every step is a `cavelon` command you can run yourself, in a terminal or in
CI. The plugin and the MCP server make the same commands available to Claude
Code, Codex and other agents.

### How do I build a solution with my coding agent?

Put the material the solution needs into the folder, describe the problem, and
ask for tests; the agent writes, validates, applies to test and tests the
solution, and stops for you before production, activation or a limit change.
[Building a solution with a coding agent](coding-agents.md) walks through it,
with example briefs and prompts to copy.

### Which coding agents work with it?

Claude Code, Codex, Cursor, GitHub Copilot in VS Code, Gemini CLI and Kiro:
`cavelon setup` sets up each one it finds on your computer, Claude Code and
Codex with the plugin, the others with the skills and the MCP server in their
user settings ([Installation](installation.md#set-up-your-coding-agents)).
`cavelon init --agents <name>` writes the same into one repository instead.
Any other agent that reads `AGENTS.md` and runs shell commands can use the CLI
directly. See [Installation](installation.md#agents-without-a-plugin).

### Which Cavelon versions does it support?

`cavelon` learns each instance's API, package schema, error codes and docs from
what the instance publishes, so it works with newer Cavelon versions without an
update. `login` warns if an instance's contracts are newer than your `cavelon`
understands; then update the kit. A feature an older instance does not publish
is not assumed: the commands say so and fall back.

### Is it free? What is the license?

The kit is open source under the [Apache License 2.0](../LICENSE). You need
access to a Cavelon instance to use it.

## Setup

### Do I need Node.js?

No. The one-line install puts a standalone `cavelon` into your own user folder
on macOS, Linux and Windows, without Node.js and without administrator rights
([Installation](installation.md#install-the-cli)). With Node.js 20.3 or newer
you can instead run it through `npx -y @cavelon/cli`, which needs no install,
or install it with npm ([With Node.js](installation.md#with-nodejs-npx-or-npm)).
The plugin starts whichever you have.

### What does `cavelon setup` change, and how do I undo it?

For each coding agent it finds, it shows what it will change and asks first:
it installs the Cavelon plugin through Claude Code's and Codex's own plugin
commands, and adds the `cavelon` MCP server and the Cavelon skills to the user
settings of Cursor, VS Code with GitHub Copilot, Gemini CLI and Kiro. In a file
that holds your other settings it changes only its own `cavelon` entry, and it
leaves a `cavelon` server you configured yourself alone. `cavelon setup --check`
shows what is set up and working; `cavelon setup --remove` undoes exactly what
`setup` did and leaves your login. See
[Set up your coding agents](installation.md#set-up-your-coding-agents).

### Can I use it without installing anything globally?

Yes. The one-line install writes only to your own user folder. Or, with
Node.js, install the plugin for your coding agent, which then runs `cavelon`
through `npx` by itself, and type `npx -y @cavelon/cli <command>` for the
commands you run yourself, `login` first; wherever the docs write `cavelon`,
that is what they mean then. An alias saves the typing
([Installation](installation.md#type-cavelon-instead-optional)).

### Where do I get a token?

In Cavelon: your user menu → **Personal access tokens**
(`/account/access-tokens`) → **Create token**. It starts with `cvpat_` and is
shown once. See [Getting started](getting-started.md#1-create-a-personal-access-token).

### `login` says personal access tokens are turned off.

The instance's operator has not enabled them yet (`PERSONAL_ACCESS_TOKENS_ENABLED`).
Ask them to. Until then, a tenant API key (`cbp_…`) from a tenant admin works
for commands that do not import packages.

### Can I use it with several instances or tenants?

Yes. Log in once per instance (`cavelon login --instance <url>`). Within an
instance, `cavelon use` lists the tenants your token reaches and stores the one
you choose; `--tenant` (a name, slug or id), `CAVELON_TENANT`, `cavelon.yaml`
or an environment file choose it per command or per folder. `cavelon whoami`
shows which one applies and why.

### Does it work on Windows?

Yes. CI runs the tests on Windows, macOS and Linux. See the
[Windows notes](installation.md#windows).

## Working with solutions

### I already have a solution in the Admin. How do I bring it into git?

In an empty repository:

```bash
cavelon init      # asks for the tenant (if your token reaches several) and the solution
cavelon pull
git add -A
git commit -m "Import the solution"
```

`pull` writes the solution into `package/` and `tests/`. From then on, change
the files and `apply` them; `pull` again shows any change made in the Admin as a
`git diff`.

### What happens if someone changes the solution in the Admin while I work?

`apply --confirm` imports exactly the preview you saw. If the solution changed
on the instance after your preview, the import is refused (exit 4) and nothing
is imported; preview again to see the current difference. To bring the Admin's
changes into your files, run `pull` (it refuses to overwrite uncommitted
changes, and outside a git repository files changed since the last pull; a file
as the last pull or confirmed apply left it is not refused).

### Can `apply` delete things?

Only with `--mode replace`, which deletes what the package does not hold, and
only after you confirm a preview that lists what it deletes. The default,
`overwrite`, creates and updates.

### How do I promote from test to production?

Put the production tenant or solution in `env/prod.yaml`, then
`cavelon apply --env prod`, check the preview, and confirm it. The same files
go to both, so what you tested is what goes live. Secrets are set per tenant
with `cavelon secrets set`.

### Can I start from a package file someone sent me?

Yes: `cavelon init --from package.json` writes it into the folder layout, and
`validate` and `apply` take it from there.

### How do I run this in CI?

Set `CAVELON_URL` and `CAVELON_TOKEN` from your CI secret store, then run the
commands with `--json` and branch on the [exit codes](troubleshooting.md#exit-codes):

```bash
cavelon validate --offline || exit 1
cavelon apply --env test --json > preview.json
cavelon apply --env test --confirm "$(jq -r .preview_id preview.json)"
cavelon test run --wait --timeout 10m
```

`validate --offline` needs the package schema cached by an earlier online
command; drop `--offline` on a fresh runner. Whether CI may confirm an import on
its own is your decision; many teams let CI preview and test, and a person
confirm production.

## Agents and safety

### Can the agent see my token or my secrets?

No. `cavelon` sends the token; the agent only calls commands. Secret values are
never printed or read back, and only a person sets them. See
[Security](security.md#what-your-coding-agent-sees).

### Can the agent put a solution live on its own?

Only if you let it. `activate` needs a token created with **May activate**; use
a token without it for day-to-day work. The skills also tell the agent to show
you a preview that reaches an active solution or production before confirming
it.

### Can the agent change my tenant's limits?

The MCP tools that change limits are marked destructive and change nothing
without confirmation. The agent is told to propose the old and new value and let
you decide. See [Limits](limits.md).

### What does the agent send to its model provider?

Whatever the commands return goes into the agent's context: your solution's
configuration, test results and traces among them. Tokens and secret values
never do. Use an agent and provider your organisation allows for that data.

## Troubleshooting

### A command exits 6. Did it fail?

No: the wait timed out, and the work goes on. Run the printed `cavelon wait …`
again to resume.

### A test run exits 1 although the operation succeeded.

The run finished, but some cases did not pass. The output names them;
`cavelon trace <run>` shows why.

### Where are the error codes explained?

In [Troubleshooting](troubleshooting.md), and for any code your instance uses,
`cavelon explain <code>`.
