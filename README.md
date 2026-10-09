# Cavelon dev-kit

Build, test and ship Cavelon solutions from a git repository, with your coding agent, instead of clicking
through the Admin.

- **`cavelon`** is a command-line tool and a local MCP server. It previews and
  imports solution packages, uploads knowledge, runs test suites, reads traces
  and activates solutions. It learns each instance's API, package schema, error
  codes and docs from what the instance publishes, so it works with every
  Cavelon version without an update.
- **Database limits**: `cavelon db instance` and `cavelon limits` show the
  tenant's connection/query caps and counts where published. An operator can
  set a tenant override in Platform mode; see [Database limits](docs/limits.md#database-connections-and-queries).
- **The Cavelon plugin** adds four skills that teach the agent the development
  loop, and the `cavelon` MCP server. Claude Code and Codex install it from this
  repository, Gemini CLI as an extension, and each release carries it as a
  package for Cursor, VS Code with GitHub Copilot and Kiro. `cavelon setup`
  installs it for you, or gives those agents the same skills and server in
  their settings. [One install page per client](docs/install/README.md).

Your token stays with you: `cavelon` never takes it as an argument, keeps it in
your system's credential store, and your agent never sees it.
The kit also refuses token login from recognized agent shells before
reading input. Log in from your own terminal; see [the login guide](docs/getting-started.md#2-log-in).

> [!NOTE]
> **New in 0.1.17:** [Cline](docs/install/cline.md), [Kilo](docs/install/kilo.md),
> [Goose](docs/install/goose.md) and [OMP](docs/install/omp.md) join
> [OpenCode](docs/install/opencode.md), [Pi](docs/install/pi.md) and
> [Qwen Code CLI](docs/install/qwen-code.md). Each gets native setup and all
> four skills. Guarded changes use a fresh client dialog where qualified,
> otherwise your own terminal. See the [qualification matrix](docs/coding-agent-qualification.md)
> for pinned versions, tested surfaces and limits.
> All seven released CLI runtimes have [native platform workflow checks](CONTRIBUTING.md#released-coding-client-runtimes);
> these scripted fixtures leave human UI qualification separate.

## Five-minute start

You need a Cavelon instance with personal access tokens turned on, and a coding
agent: Claude Code, Codex, Cursor, VS Code with GitHub Copilot, Gemini CLI,
Kiro, OpenCode, Pi or Qwen Code CLI. Provision that client first. The standalone
Cavelon tool needs no Node.js or administrator rights.

Three steps: **install `cavelon`** on your computer once, **connect your coding
agents** to it, then **build** in your agent.

### Step 1 · Install `cavelon` on your computer

> [!NOTE]
> **Once per computer.** This installs the `cavelon` tool itself, nothing in
> your coding agents yet; that is step 2. Pick one way: each installs the same
> `cavelon` into your own user folder, without administrator rights.

**One line, nothing else needed** (recommended). On macOS or Linux, in Terminal:

```bash
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex
```

The line downloads the `cavelon` built for your system from this repository's
latest release, checks it against the release's checksums, puts it into
`~/.local/bin` (on Windows, `%LOCALAPPDATA%\Programs\cavelon`), adds that folder
to your `PATH` if it is not there yet, and says what to do next. Open a new
terminal so it finds `cavelon`.

**With Homebrew** (macOS, Linux):

```bash
brew install goodguys-gmbh/cavelon/cavelon
```

**With Python** (macOS, Linux, Windows), through uv or pipx:

```bash
uv tool install cavelon      # or: pipx install cavelon
```

`uvx cavelon` runs it without installing anything, which suits CI and cloud
agents. Python is only needed for the install: `cavelon` itself runs without it.

**With Node.js** 20.3 or newer:

```bash
npm i -g @cavelon/cli
```

Or run it without installing: type `npx -y @cavelon/cli setup` in step 2, and wherever these docs write `cavelon`, write `npx -y @cavelon/cli`.

`cavelon --version` names the way you installed it and the command that
updates it. [Installation](docs/installation.md) has the details for each way,
and how to remove it. Where machines reach neither GitHub, npm nor PyPI,
install from the signed [offline bundle](docs/offline-bundle.md) each release
carries.

### Step 2 · Connect your coding agents

> [!NOTE]
> **Adds Cavelon to the agents installed on this computer, and logs you in.**
> Run it after step 1, and again whenever you install another coding agent.

**Before you run it, have two things ready**, since `setup` logs you in at
the end:

- **Your Cavelon address**: the URL you open Cavelon at in the browser.
  `https://cavelon.example.com` stands for it throughout these docs.
- **A personal access token**: in Cavelon, user menu → **Personal access
  tokens** → **Create token**, then copy it. Tick **May activate** only if this
  token may put solutions live. Use this token, not a tenant API key: it acts
  as you, while a key is meant for CI and stays within its own tenant and
  scopes.

Then run:

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

Then it logs you in: enter your Cavelon address and paste the token when it
asks. The token is not shown as you paste it, and it is kept in your system's
credential store, never in a file of yours. If the token reaches several
tenants, choose yours from the list by number or name. `cavelon setup --check`
shows what is set up and working.

> [!TIP]
> **Installed another coding agent later?** Run `setup` again. It finds the
> new agent and adds Cavelon to it; you are still logged in, so it does not ask
> for a token again. Then restart that agent.
>
> ```bash
> cavelon setup                    # every agent it finds; the ones already set up stay set up
> cavelon setup --agents cursor    # or only the one you name: claude, codex, cursor, copilot, gemini, kiro
> cavelon setup --check            # what is set up and working, for each agent
> ```

**Updating later.** Update `cavelon` the way you installed it
(`cavelon --version` names the command), then run `cavelon setup` again: it
brings the skills it copied into Cursor, VS Code and Kiro up to the new
release. Claude Code, Codex and Gemini CLI update the plugin with their own
command; [Updating](docs/installation.md#updating-each-part) lists each one, and
your agent tells you when something is behind.

### Step 3 · Build your first solution

Open an empty folder in your agent and describe what you need, for example: *"Build a Cavelon solution that answers our customers' questions from
the FAQ pages in ./faq, and test it."* Restart the agent first if it was open
during step 2.

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

**Several solutions in one repository.** Keep each solution's
`cavelon.yaml`, `env/` and package in its own folder. An MCP session opened at
the repository root selects that folder with `solution_dir` on each tool call,
including preview and confirmation. `harness` names the solution on the
instance; it does not select local files. Guarded imports still ask for your
fresh answer. [MCP folder selection](docs/mcp.md#several-solutions-in-one-repository)
shows the calls; CLI commands run in the individual solution's folder.

**Next: [Building a solution with a coding agent](docs/coding-agents.md).** How
to brief the agent, what it shows you at each step, what it leaves to you, and
how to review and test its work.

## Documentation

| Page | What it covers |
|---|---|
| [Installation](docs/installation.md) | the one-line install, Homebrew, PyPI (uvx, uv, pipx, pip), npx and npm, `cavelon setup`, the plugin in Claude Code and Codex, other agents, updating, uninstalling, Windows/macOS/Linux, proxies |
| [Install pages](docs/install/README.md) | one page per client, including OpenCode, Pi and Qwen setup; install, approval scope, updating, removal and plugin packages |
| [Getting started](docs/getting-started.md) | a full tutorial from an empty folder to an active solution |
| [Building with a coding agent](docs/coding-agents.md) | briefing the agent, the loop as it runs it, what stays with you, reviewing and testing its work, prompts to copy |
| [Concepts](docs/concepts.md) | instance, tenant, solution, package, environments, preview and confirm, operations, tests, activation, Platform mode |
| [Command reference](docs/commands.md) | every command with its options and examples |
| [MCP server](docs/mcp.md) | `cavelon mcp`, its tools and how agents use them |
| [Limits](docs/limits.md) | reading and changing limits, and who may change what |
| [Troubleshooting](docs/troubleshooting.md) | exit codes and error codes, with what to do |
| [Security](docs/security.md) | where the token lives, what the agent sees, what is sent where |
| [Connect a database](docs/connect-a-database.md) | create a connection, set its password in the Admin, upload a public CA, test it and explore its schema |
| [Offline bundle](docs/offline-bundle.md) | installing without internet access: the signed bundle each release carries, its format, verifying it with cosign |
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
| [`packaging/`](packaging/) | the Homebrew formula and winget manifest the release workflow writes, the plugin packages it renders (`plugins.mjs`), the PyPI wheels (`pypi/`) and the offline bundle (`bundle/`) it builds, and the macOS signing entitlements |
| [`plugin/`](plugin/) | the Cavelon plugin, the one source of every client's package: the skills, the MCP entry, and a manifest each for Claude Code and Codex |
| `.claude-plugin/`, `.agents/plugins/` | the plugin marketplaces of Claude Code and Codex |
| [`examples/support-faq/`](examples/support-faq/) | a small solution to copy and try: one agent answering from a knowledge base |
| [`examples/expense-approval/`](examples/expense-approval/) | a pipeline to copy and try: chat, agents, routers, an approval by a person, and its test suite |
| [`docs/`](docs/) | the documentation |
| [`contracts/`](contracts/) | snapshots of what an instance publishes, which the tests run against, and the schema of the offline bundle's manifest |

## Contributing and support

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report a
bug or ask a question in [GitHub issues](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues);
report a vulnerability privately, as [SECURITY.md](SECURITY.md) says. Changes
are listed in the [changelog](CHANGELOG.md).

Licensed under the [Apache License 2.0](LICENSE).
