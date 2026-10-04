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

You need Node.js 20.3 or newer with npm (on Debian and Ubuntu, install the
`npm` package too), git, and a Cavelon instance with personal access tokens
turned on.

**1. Get the kit.** None of it needs a global install.

*With a coding agent*, install the plugin. It starts `cavelon` through `npx` by
itself:

```bash
claude plugin marketplace add goodguys-gmbh/cavelon-dev-kit   # Claude Code
claude plugin install cavelon@cavelon-dev-kit
codex plugin marketplace add goodguys-gmbh/cavelon-dev-kit    # Codex
codex plugin add cavelon@cavelon-dev-kit
```

On native Windows, also add the plugin's MCP server yourself, as the
[Windows notes](docs/installation.md#windows) show.

*For the commands you type yourself*, `login` first, run `cavelon` through
`npx`. It needs no install and works the same in bash, zsh and PowerShell:

```bash
npx -y @cavelon/cli --version
```

**In the rest of these docs, `cavelon` stands for `npx -y @cavelon/cli`**: where
they write `cavelon whoami`, type `npx -y @cavelon/cli whoami`, and the same
for a `cavelon …` command the CLI prints for you to run next. If PowerShell
refuses `npx` because running scripts is disabled on this system, write
`npx.cmd` instead, or allow local scripts for your user once with
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

*Optional, if you want to type `cavelon`:* an alias does it without installing
anything. In zsh or bash, and in your `~/.zshrc` or `~/.bashrc` to keep it:

```bash
alias cavelon='npx -y @cavelon/cli'
```

In PowerShell, and in your `$PROFILE` to keep it (the function passes on what
you pipe into it, such as a token for `login --token-stdin`):

```powershell
function cavelon { if ($MyInvocation.ExpectingInput) { $input | npx -y @cavelon/cli @args } else { npx -y @cavelon/cli @args } }
```

Or install it globally with `npm i -g @cavelon/cli`. If that fails with
`EACCES`, Node.js was installed for the whole system: by your Linux
distribution (Fedora, Ubuntu) or by the nodejs.org installer on macOS. Don't
use `sudo`; let npm install into your home folder once, then run it again. On
macOS (zsh):

```bash
npm config set prefix "$HOME/.local"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && export PATH="$HOME/.local/bin:$PATH"
npm i -g @cavelon/cli
```

On Linux with bash, write the second line to `~/.bashrc` instead. Windows and
Node.js from Homebrew, nvm, fnm or Volta need none of this. More in
[Installation](docs/installation.md#npm-i--g-fails-with-eacces).

**2. Create a personal access token** in Cavelon: user menu → **Personal
access tokens** → **Create token**. Tick **May activate** only if this token
may put solutions live.

**3. Log in**, in your own terminal (not in the agent's chat):

```bash
npx -y @cavelon/cli login --instance https://cavelon.example.com
npx -y @cavelon/cli whoami
```

Replace `https://cavelon.example.com` with the address of your Cavelon
instance: the URL you open Cavelon at in the browser. `example.com` stands for
it throughout these docs.

Where nothing can ask for it, in CI or for an agent that runs unattended, a
person pipes the token in from a secret store with `--token-stdin`; it is never
an argument:

```bash
op read op://dev/cavelon/token | npx -y @cavelon/cli login --instance https://cavelon.example.com --token-stdin
```

In CI, setting `CAVELON_URL` and `CAVELON_TOKEN` from the CI system's secrets
works too ([Security](docs/security.md)).

**4. Start a solution** in an empty folder:

```bash
mkdir support-faq
cd support-faq
git init
cavelon init --tenant acme --harness support-faq
```

Then let your agent write the package files, bring an existing solution in
with `cavelon pull`, or copy `package/`, `tests/` and `seeds/` from an example:
[`examples/support-faq/`](examples/support-faq/) (one agent answering from a
knowledge base) or [`examples/expense-approval/`](examples/expense-approval/)
(a pipeline with a router and an approval by a person).

**5. Work in the loop**, yourself or through your agent:

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
| [Installation](docs/installation.md) | requirements, npx, an alias or a global install, the plugin in Claude Code and Codex, other agents, updating, uninstalling, Windows/macOS/Linux, proxies |
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
| [`cli/`](cli/) | the `cavelon` CLI and MCP server (TypeScript, Node.js 20.3+), published as `@cavelon/cli` |
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
