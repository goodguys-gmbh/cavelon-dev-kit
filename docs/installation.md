# Installation

The Cavelon dev-kit has two parts, and you can use either without the other:

- **`cavelon`**, a command-line tool that is also a local MCP server. You or your
  coding agent run it to build, test and activate Cavelon solutions.
- **The Cavelon plugin** for Claude Code and Codex: four skills that teach the
  agent the development loop, and the `cavelon` MCP server.

This page covers installing, updating and removing both. When you are done,
continue with [Getting started](getting-started.md).

## Requirements

| What | Why |
|---|---|
| **Node.js 20.3 or newer**, with npm | `cavelon` is a Node.js program, and `npx`, which comes with npm, runs it without an install. `node --version` shows yours. |
| **git** | A solution lives in a git repository; `pull` refuses to overwrite uncommitted changes. |
| **A Cavelon instance** and an account on it | Its URL, for example `https://cavelon.example.com`. |
| **Personal access tokens** turned on in that instance | `cavelon` logs in with a personal access token. The instance's operator turns them on. |
| **The operations API** turned on, for waiting | `wait`, `watch` and every `--wait` follow work through it. Without it, the commands still start the work, but cannot wait for it. |
| **Claude Code or Codex** (optional) | For the plugin. Other agents work too: see [Agents without a plugin](#agents-without-a-plugin). |

If you are not sure whether your instance has personal access tokens and the
operations API turned on, log in (step 3 of [Getting started](getting-started.md))
and run `cavelon status`; the [troubleshooting page](troubleshooting.md) shows
what each refusal means.

## Install the CLI

Nothing needs a global install. With a coding agent, the plugin starts
`cavelon` by itself ([Install the plugin](#install-the-plugin)); for the
commands you type yourself, `npx` runs it.

### Run it through npx

```bash
npx -y @cavelon/cli --version
npx -y @cavelon/cli login --instance https://cavelon.example.com
```

`npx` comes with npm and downloads the package into npm's cache (in your home
folder) the first time, so it needs no root. On Debian and Ubuntu, Node.js from
the system packages comes without npm; install the `npm` package too.

Wherever the documentation says `cavelon`, write `npx -y @cavelon/cli`, and
the same for a `cavelon …` command the CLI prints for you to run next. To stay
on one release line, name it: `npx -y @cavelon/cli@0.1 whoami`. On Windows, if
PowerShell refuses `npx`, see [Windows](#windows).

### Type `cavelon` instead (optional)

An alias gives you the short name without installing anything. In zsh or bash,
and in your `~/.zshrc` or `~/.bashrc` to keep it:

```bash
alias cavelon='npx -y @cavelon/cli'
```

In PowerShell, and in your `$PROFILE` to keep it:

```powershell
function cavelon { if ($MyInvocation.ExpectingInput) { $input | npx -y @cavelon/cli @args } else { npx -y @cavelon/cli @args } }
```

The function passes on what you pipe into it, such as a token for
`login --token-stdin`; a plain `function cavelon { npx -y @cavelon/cli @args }`
would not. An alias works in your interactive shell only: in scripts and CI,
write `npx -y @cavelon/cli`.

Or install it globally:

```bash
npm i -g @cavelon/cli
cavelon --version
```

#### `npm i -g` fails with `EACCES`

When Node.js was installed for the whole system, global installs need root:
on Linux distributions where Node.js comes from the system packages, and on
macOS with the installer from nodejs.org. Instead of `sudo`, give npm a folder
in your home directory once:

```bash
npm config set prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"   # add this line to ~/.bashrc or ~/.zshrc too
npm i -g @cavelon/cli
```

With Node.js from nvm, fnm, Volta, Homebrew or the Windows installer, `npm i -g`
works as it is. Or skip the global install: `npx` and the alias above need
none of this.

## Install the plugin

The plugin adds four skills (`cavelon-loop`, `cavelon-authoring`,
`cavelon-testing`, `cavelon-long-running`) and the `cavelon` MCP server to your
agent. The repository [goodguys-gmbh/cavelon-dev-kit](https://github.com/goodguys-gmbh/cavelon-dev-kit)
is the plugin marketplace for both clients.

### Claude Code

For yourself, in every project (user scope):

```bash
claude plugin marketplace add goodguys-gmbh/cavelon-dev-kit
claude plugin install cavelon@cavelon-dev-kit
```

For everyone who works on one repository (project scope), run this in the
repository and commit `.claude/settings.json`:

```bash
claude plugin marketplace add goodguys-gmbh/cavelon-dev-kit --scope project
claude plugin install cavelon@cavelon-dev-kit --scope project
```

Claude Code then offers the plugin to each person who opens the repository.
`--scope local` does the same for you alone, in this repository only.

Check that Claude Code sees it:

```bash
claude plugin details cavelon@cavelon-dev-kit   # the four cavelon-* skills and the MCP server "cavelon"
claude mcp list                                 # plugin:cavelon:cavelon: npx -y @cavelon/cli@0.1 mcp - ✔ Connected
```

### Codex

```bash
codex plugin marketplace add goodguys-gmbh/cavelon-dev-kit
codex plugin add cavelon@cavelon-dev-kit
codex plugin list    # cavelon@cavelon-dev-kit  installed, enabled
codex mcp list       # cavelon  npx  -y @cavelon/cli@0.1 mcp  ...  enabled
```

Codex installs plugins for your user. To give everyone on a repository the
skills and the MCP server, write them into the repository with
`cavelon init --agents codex` (next section).

### How the plugin runs `cavelon`

The plugin starts the MCP server as `npx -y @cavelon/cli@0.1 mcp`: the latest
0.1 release, whether or not you installed `cavelon` globally, so with the
plugin you need nothing else. The pin keeps a
release that may change behaviour (0.2) away until you update the plugin.

Both clients also accept the path of a local clone instead of
`goodguys-gmbh/cavelon-dev-kit`.

With the plugin installed, [Building a solution with a coding agent](coding-agents.md)
shows how to brief the agent and review its work.

## Agents without a plugin

For Cursor, GitHub Copilot in VS Code, Gemini CLI, Kiro, Pi or any agent that
reads `AGENTS.md` and runs shell commands, `cavelon init` writes the skills and
the MCP entry into the solution folder itself:

```bash
cavelon init --agents cursor,copilot
```

| `--agents` value | What it writes |
|---|---|
| `claude` | `.mcp.json` |
| `codex` | `.codex/config.toml` (a marked block) |
| `cursor` | `.cursor/mcp.json` |
| `copilot` | `.vscode/mcp.json` |
| `gemini` | `.gemini/settings.json` |
| `kiro` | `.kiro/settings/mcp.json` |
| `pi`, `other` | nothing beyond `AGENTS.md` |

Every value also writes the skills to `.agents/skills/cavelon-*/` and
`.claude/skills/cavelon-*/`, marked as generated, and a short Cavelon block in
`AGENTS.md`. `cavelon init` never overwrites a file it did not create: in your
own files it changes only the block between its `cavelon:begin` and
`cavelon:end` markers, and a JSON file only when it can keep every other byte
(otherwise it tells you what to add). `cavelon init --update` refreshes those
blocks and files after you update `cavelon`. Commit them, so everyone on the
repository gets the same.

## Updating

```bash
npm i -g @cavelon/cli                                   # the CLI, if you installed it globally
claude plugin marketplace update cavelon-dev-kit       # Claude Code
claude plugin update cavelon@cavelon-dev-kit
codex plugin marketplace upgrade cavelon-dev-kit        # Codex
codex plugin add cavelon@cavelon-dev-kit
cavelon init --update                                   # in a solution set up with --agents
```

Through `npx`, `cavelon` needs no update: `npx -y @cavelon/cli` looks up the
newest release each time it starts.

`cavelon` learns each instance's API, package schema and docs from what the
instance publishes, so a new Cavelon version on the server does not need a new
`cavelon`. Update the kit for its own fixes and features; the
[changelog](../CHANGELOG.md) lists them.

## Uninstalling

```bash
cavelon logout --all                          # deletes every stored token
claude plugin uninstall cavelon@cavelon-dev-kit
codex plugin remove cavelon@cavelon-dev-kit
npm uninstall -g @cavelon/cli                 # if you installed it globally
```

`logout` deletes the tokens from your machine; they remain valid in Cavelon
until you revoke them on **`/account/access-tokens`**. To remove everything,
also delete the configuration and cache folders listed in
[Security](security.md#files-on-your-machine).

## Operating systems

`cavelon` runs on Linux, macOS and Windows, and CI tests it on all three.

### Windows

- Use PowerShell, Windows Terminal or cmd; `npx -y @cavelon/cli` works in each,
  and `npm i -g @cavelon/cli` puts `cavelon` on your `PATH`.
- If PowerShell refuses `npx` (or `cavelon`) because running scripts is
  disabled on this system, it found npm's PowerShell script. Write `npx.cmd`
  instead, or allow local scripts for your user once:
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Your `$PROFILE`, and
  the alias function in it, needs that setting too.
- Windows PowerShell 5.1 does not accept `&&` between commands; where the docs
  join two with it, run them one after the other.
- The token is kept in the **Windows Credential Manager**.
- Settings are in `%APPDATA%\cavelon`, the cache in `%LOCALAPPDATA%\cavelon\cache`.
- Commands that `cavelon` prints for you to copy are quoted for the shell it runs
  in (PowerShell, cmd or a POSIX shell). If it guesses wrong, set
  `CAVELON_SHELL` to `powershell`, `cmd` or `posix`.
- In PowerShell, quote arguments that contain spaces with single quotes:
  `cavelon kb upload seeds/faq --kb 'Support FAQ'`.
- An agent starts its MCP servers without a shell, and on native Windows
  `npx` is `npx.cmd`, which runs only through one. `cavelon init --agents` run
  on Windows therefore writes the entry as
  `cmd /c npx -y @cavelon/cli@0.1 mcp`. In a repository people also use on
  macOS or Linux, the entry stays in the form it was first written in, and
  `init --update` keeps it: whoever is on the other system adds the server
  for themselves (below).
- The plugin's MCP server is started with plain `npx`, so on native Windows
  add the server yourself; the plugin's skills work as they are:

  ```powershell
  claude mcp add --scope user cavelon -- cmd /c npx -y @cavelon/cli@0.1 mcp
  codex mcp add cavelon -- cmd /c npx -y @cavelon/cli@0.1 mcp
  ```

  With `cavelon` installed globally, `cavelon mcp` works as the command too.
  In WSL, everything works as on Linux.

### macOS

- The token is kept in the **Keychain**.
- Settings are in `~/.config/cavelon`, the cache in `~/.cache/cavelon`.

### Linux

- The token is kept through the **Secret Service** (GNOME Keyring, KWallet).
  On a machine without one, such as a server or a container, it goes into
  `~/.config/cavelon/credentials.json`, which only you can read, and `login`
  says so.
- Settings follow `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` when they are set.

## Behind a proxy

**Installing.** npm uses its own proxy settings:

```bash
npm config set proxy http://proxy.example.com:3128
npm config set https-proxy http://proxy.example.com:3128
```

**Running.** `cavelon` uses Node.js's built-in HTTP client, which reads the
standard proxy variables when `NODE_USE_ENV_PROXY=1` is set (Node.js 24, and
recent Node.js 22 releases):

```bash
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://proxy.example.com:3128
export NO_PROXY=localhost,127.0.0.1
cavelon whoami
```

Set them where your coding agent starts too (your shell profile), so the MCP
server it launches inherits them. On older Node.js versions, update Node.js.

**A proxy that inspects TLS** presents its own certificate. Give Node.js your
organisation's CA certificate:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem
```

**Timeouts.** A request waits up to 30 seconds by default;
`CAVELON_HTTP_TIMEOUT_MS` changes that for a slow network.

## From source

To try a change before it is released, or to contribute: see
[CONTRIBUTING.md](../CONTRIBUTING.md#build-and-test).
