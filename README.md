# Cavelon dev-kit

Build, test and ship Cavelon solutions from a git repository, with your coding agent, instead of clicking
through the Admin.

- **`cavelon`** is a command-line tool and a local MCP server. It previews and
  imports solution packages, uploads knowledge, runs test suites, reads traces
  and activates solutions. It learns each instance's API, package schema, error
  codes and docs from what the instance publishes, so it works with every
  Cavelon version without an update.
- **The Cavelon plugin** adds four skills that teach the agent the development
  loop, and the `cavelon` MCP server. Claude Code and Codex install it from this
  repository, Gemini CLI as an extension, and each release carries it as a
  package for Cursor, VS Code with GitHub Copilot and Kiro. `cavelon setup`
  installs it for you, or gives those agents the same skills and server in
  their settings. [One install page per client](docs/install/README.md).

Your token stays with you: `cavelon` never takes it as an argument, keeps it in
your system's credential store, and your agent never sees it.

## Five-minute start

You need a Cavelon instance with personal access tokens turned on, and a coding
agent: Claude Code, Codex, Cursor, VS Code with GitHub Copilot, Gemini CLI or
Kiro. Nothing else: no Node.js, no administrator rights.

**1. Install `cavelon`** with one line. It goes into your own user folder.

On macOS or Linux, in Terminal:

```bash
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex
```

The line downloads the `cavelon` built for your system from this
repository's latest release, checks it against the release's checksums, puts
it into `~/.local/bin` (on Windows, `%LOCALAPPDATA%\Programs\cavelon`), adds
that folder to your `PATH` if it is not there yet, and says what to do next.
Open a new terminal so it finds `cavelon`. Run the same line again to update.
With Homebrew (macOS, Linux): `brew install goodguys-gmbh/cavelon/cavelon`.
With Python: `uv tool install cavelon` or `pipx install cavelon` (`uvx cavelon`
runs it without installing).
[Installation](docs/installation.md) has the details, npm, and how to remove it.

*With Node.js instead:* if you have Node.js 20.3 or newer, `npx -y @cavelon/cli`
runs the same `cavelon` without installing it: type `npx -y @cavelon/cli setup`
in the next step, and wherever these docs write `cavelon`, write
`npx -y @cavelon/cli`. [Installation](docs/installation.md#with-nodejs-npx-or-npm)
covers npx and `npm i -g`.

**2. Set up your agent and log in:**

```bash
cavelon setup
```

`setup` finds the coding agents on your computer, shows what it will change
for each, and asks once; Enter means yes.

- Claude Code and Codex get the Cavelon plugin through their own plugin
  command, and Gemini CLI the Cavelon extension.
- Cursor, VS Code with GitHub Copilot and Kiro get the `cavelon` MCP server in
  their user settings and the Cavelon skills in their skills folder.

It changes nothing else in those files, and `cavelon setup --remove` undoes
what it did.

Then it logs you in. Have two things ready:

- **Your Cavelon address**: the URL you open Cavelon at in the browser.
  `https://cavelon.example.com` stands for it throughout these docs.
- **A personal access token**: in Cavelon, user menu → **Personal access
  tokens** → **Create token**. Tick **May activate** only if this token may put
  solutions live. Paste it when `setup` asks; it is not shown, and it is kept in
  your system's credential store.

If the token reaches several tenants, choose yours from the list by number or
name. `cavelon setup --check` shows what is set up and working.

**3. Open an empty folder in your agent** and describe what you need, for
example: *"Build a Cavelon solution that answers our customers' questions from
the FAQ pages in ./faq, and test it."* Restart the agent first if it was open
during `setup`.

The agent creates the solution (`cavelon init`), writes the package and the
tests, previews and imports them into a test environment, and runs the tests.
It stops and asks you before anything reaches production or goes live.

### Doing it yourself

Everything `setup` does, you can do by hand, and every step of the loop is a
command you can type.

**Log in** in your own terminal (not in the agent's chat):

```bash
cavelon login --instance https://cavelon.example.com
cavelon whoami
```

`login` asks for the token, checks it and finds the tenants it reaches. With
one, it uses it and says so. With several, it shows them as a numbered list:
type the number, or part of the tenant's name. An operator's token that reaches
every tenant asks for part of the name and searches. `--tenant` takes a name,
slug or id if you want to name it straight away:

```bash
cavelon login --instance https://cavelon.example.com --tenant "Acme Support"
```

Later, `cavelon use` lets you choose another tenant from the same list, and
`cavelon tenant list` shows each tenant's name, slug and id.
An older Cavelon instance does not tell a token which tenants it reaches; there
`login` asks for `--tenant <tenant-id>` when it needs one (an operator copies
the id in **Platform › Tenants**).

Where nothing can ask for it, in CI or for an agent that runs unattended, a
person pipes the token in from a secret store with `--token-stdin`; it is never
an argument:

```bash
op read op://dev/cavelon/token | cavelon login --instance https://cavelon.example.com --token-stdin
```

Without a terminal there is nobody to choose a tenant: a token for several
tenants is stored, and `login` prints one ready `cavelon use <tenant>` line per
tenant to run next (exit 2). Pass `--tenant` to choose up front.

In CI, setting `CAVELON_URL` and `CAVELON_TOKEN` from the CI system's secrets
works too ([Security](docs/security.md)).

**Set up an agent** with its own commands instead of `setup`
([Install the kit in your coding agent](docs/install/README.md): Claude Code,
Codex, Cursor, VS Code with GitHub Copilot, Kiro, Gemini CLI, cloud agents and
CI), or for one solution
only, in its folder, with `cavelon init --agents`
([Agents without a plugin](docs/installation.md#agents-without-a-plugin)).

**Start a solution** in an empty folder:

```bash
mkdir support-faq
cd support-faq
git init
cavelon init
```

`init` asks which of the tenant's solutions this folder holds, or the name of a
new one, and writes the tenant's and the solution's slugs into `cavelon.yaml`.
To answer up front, name them: `cavelon init --tenant "Acme Support" --harness
"Support FAQ"` (a name, slug or id each).

Then let your agent write the package files, bring an existing solution in
with `cavelon pull`, or copy `package/`, `tests/` and `seeds/` from an example:
[`examples/support-faq/`](examples/support-faq/) (one agent answering from a
knowledge base) or [`examples/expense-approval/`](examples/expense-approval/)
(a pipeline with a router and an approval by a person).

**Work in the loop**, yourself or through your agent:

```bash
cavelon validate                                # the files against the instance's package schema
cavelon apply --env test                        # a preview and its id; nothing changes yet
cavelon apply --env test --confirm <preview-id> # import exactly what was previewed
cavelon kb upload seeds/faq --kb "Support FAQ" --wait
cavelon test run --wait --timeout 5m
cavelon trace <run>                             # why a case passed or failed
cavelon activate                                # through the readiness gate, never by force
```

The [getting-started tutorial](docs/getting-started.md) walks through all of
this with the ready-made example in [`examples/support-faq/`](examples/support-faq/).

**Next: [Building a solution with a coding agent](docs/coding-agents.md).** How
to brief the agent, what it shows you at each step, what it leaves to you, and
how to review and test its work.

## Documentation

| Page | What it covers |
|---|---|
| [Installation](docs/installation.md) | the one-line install, Homebrew, PyPI (uvx, uv, pipx, pip), npx and npm, `cavelon setup`, the plugin in Claude Code and Codex, other agents, updating, uninstalling, Windows/macOS/Linux, proxies |
| [Install pages](docs/install/README.md) | one page per client: Claude Code, Codex, Cursor, VS Code with GitHub Copilot, Kiro, Gemini CLI, cloud agents and CI; the plugin packages each release carries |
| [Getting started](docs/getting-started.md) | a full tutorial from an empty folder to an active solution |
| [Building with a coding agent](docs/coding-agents.md) | briefing the agent, the loop as it runs it, what stays with you, reviewing and testing its work, prompts to copy |
| [Concepts](docs/concepts.md) | instance, tenant, solution, package, environments, preview and confirm, operations, tests, activation, Platform mode |
| [Command reference](docs/commands.md) | every command with its options and examples |
| [MCP server](docs/mcp.md) | `cavelon mcp`, its tools and how agents use them |
| [Limits](docs/limits.md) | reading and changing limits, and who may change what |
| [Troubleshooting](docs/troubleshooting.md) | exit codes and error codes, with what to do |
| [Security](docs/security.md) | where the token lives, what the agent sees, what is sent where |
| [FAQ](docs/faq.md) | common questions |

## Exit codes

Every command uses these, so scripts, CI and agents can branch on them:

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | anything else (not found, an operation failed, a test case failed) |
| 2 | usage: unknown command or option, a missing argument, no instance chosen |
| 3 | validation failed |
| 4 | conflict or stale preview |
| 5 | needs a person |
| 6 | timed out; the work goes on, `cavelon wait` resumes |
| 7 | not authorised |
| 8 | server or network error |

Details in [Troubleshooting](docs/troubleshooting.md#exit-codes).

## What is in this repository

| Path | What |
|---|---|
| [`cli/`](cli/) | the `cavelon` CLI and MCP server (TypeScript, Node.js 20.3+), published as `@cavelon/cli` and as standalone executables |
| [`install.sh`](install.sh), [`install.ps1`](install.ps1) | the one-line installers for macOS and Linux, and for Windows |
| [`packaging/`](packaging/) | the Homebrew formula and winget manifest the release workflow writes, the plugin packages it renders (`plugins.mjs`), the PyPI wheels it builds (`pypi/`), and the macOS signing entitlements |
| [`plugin/`](plugin/) | the Cavelon plugin, the one source of every client's package: the skills, the MCP entry, and a manifest each for Claude Code and Codex |
| `.claude-plugin/`, `.agents/plugins/` | the plugin marketplaces of Claude Code and Codex |
| [`examples/support-faq/`](examples/support-faq/) | a small solution to copy and try: one agent answering from a knowledge base |
| [`examples/expense-approval/`](examples/expense-approval/) | a pipeline to copy and try: chat, agents, routers, an approval by a person, and its test suite |
| [`docs/`](docs/) | the documentation |
| [`contracts/`](contracts/) | snapshots of what an instance publishes; the tests run against them |

## Contributing and support

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report a
bug or ask a question in [GitHub issues](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues);
report a vulnerability privately, as [SECURITY.md](SECURITY.md) says. Changes
are listed in the [changelog](CHANGELOG.md).

Licensed under the [Apache License 2.0](LICENSE).
