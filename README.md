# Cavelon dev-kit

Build, test and ship Cavelon solutions from a git repository, with your coding agent, instead of clicking
through the Admin.

- **`cavelon`** is a command-line tool and a local MCP server. It previews and
  imports solution packages, uploads knowledge, runs test suites, reads traces
  and activates solutions. It learns each instance's API, package schema, error
  codes and docs from what the instance publishes, so it works with every
  Cavelon version without an update.
- **The Cavelon plugin** for Claude Code and Codex adds four skills that teach
  the agent the development loop, and the `cavelon` MCP server. Other agents get
  the same through `cavelon init --agents`.

Your token stays with you: `cavelon` never takes it as an argument, keeps it in
your system's credential store, and your agent never sees it.

## Five-minute start

You need git and a Cavelon instance with personal access tokens turned on.
Nothing else: no Node.js, no administrator rights.

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
Open a new terminal, then:

```bash
cavelon --version
```

Run the same line again to update. [Installation](docs/installation.md) has
the details, Homebrew and npm, and how to remove it.

**2. Give your coding agent the kit** (optional). The plugin for Claude Code
and Codex adds the Cavelon skills and the `cavelon` MCP server. It starts the
`cavelon` you installed:

```bash
claude plugin marketplace add goodguys-gmbh/cavelon-dev-kit   # Claude Code
claude plugin install cavelon@cavelon-dev-kit
codex plugin marketplace add goodguys-gmbh/cavelon-dev-kit    # Codex
codex plugin add cavelon@cavelon-dev-kit
```

On native Windows, also add the MCP server once yourself; the plugin's skills
work as they are:

```powershell
claude mcp add --scope user cavelon -- cavelon mcp
codex mcp add cavelon -- cavelon mcp
```

For Cursor, GitHub Copilot, Gemini CLI and other agents, `cavelon init --agents`
writes the skills and the MCP entry into your solution (step 5;
[Agents without a plugin](docs/installation.md#agents-without-a-plugin)).

*With Node.js instead:* if you have Node.js 20.3 or newer, `npx -y @cavelon/cli`
runs the same `cavelon` without installing it, and `npm i -g @cavelon/cli`
installs it. Wherever these docs write `cavelon`, write `npx -y @cavelon/cli`
then. Without an installed `cavelon`, the plugin starts it through `npx` by
itself. [Installation](docs/installation.md#with-nodejs-npx-or-npm) covers
both, and what to do when `npm i -g` fails with `EACCES`.

**3. Create a personal access token** in Cavelon: user menu → **Personal
access tokens** → **Create token**. Tick **May activate** only if this token
may put solutions live.

**4. Log in**, in your own terminal (not in the agent's chat):

```bash
cavelon login --instance https://cavelon.example.com
cavelon whoami
```

Replace `https://cavelon.example.com` with the address of your Cavelon
instance: the URL you open Cavelon at in the browser. `example.com` stands for
it throughout these docs.

`login` asks for the token, checks it and finds the tenants it reaches. With
one, it uses it and says so. With several, it shows them as a numbered list:
type the number, or part of the tenant's name. An operator's token that reaches
every tenant asks for part of the name and searches. You never need to look up
a tenant's id; `--tenant` takes a name, slug or id if you want to name it
straight away:

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

**5. Start a solution** in an empty folder:

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

**6. Work in the loop**, yourself or through your agent:

```bash
cavelon validate                                # the files against the instance's package schema
cavelon apply --env test                        # a preview and its id; nothing changes yet
cavelon apply --env test --confirm <preview-id> # import exactly what was previewed
cavelon kb upload seeds/faq --kb "Support FAQ" --wait
cavelon test run --wait --timeout 5m
cavelon trace <run>                             # why a case passed or failed
cavelon activate                                # through the readiness gate, never by force
```

With the plugin, open the folder in Claude Code or Codex and describe what you
need, for example: *"Build a Cavelon solution that answers our customers'
questions from the FAQ pages in ./faq, and test it."*

The [getting-started tutorial](docs/getting-started.md) walks through all of
this with the ready-made example in [`examples/support-faq/`](examples/support-faq/).

**Next: [Building a solution with a coding agent](docs/coding-agents.md).** How
to brief the agent, what it shows you at each step, what it leaves to you, and
how to review and test its work.

## Documentation

| Page | What it covers |
|---|---|
| [Installation](docs/installation.md) | the one-line install, Homebrew, npx and npm, the plugin in Claude Code and Codex, other agents, updating, uninstalling, Windows/macOS/Linux, proxies |
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
| [`packaging/`](packaging/) | the Homebrew formula and winget manifest the release workflow writes, and the macOS signing entitlements |
| [`plugin/`](plugin/) | the Cavelon plugin: the skills, the MCP entry, and a manifest each for Claude Code and Codex |
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
