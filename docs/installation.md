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
| **macOS, Linux or Windows** | `cavelon` comes as one executable for macOS (Apple silicon and Intel), Linux (x64 and arm64, with glibc) and Windows (x64; Windows on Arm runs it too). It needs no Node.js. |
| **git** | A solution lives in a git repository; `pull` refuses to overwrite uncommitted changes. |
| **A Cavelon instance** and an account on it | Its URL, for example `https://cavelon.example.com`. |
| **Personal access tokens** turned on in that instance | `cavelon` logs in with a personal access token. The instance's operator turns them on. |
| **The operations API** turned on, for waiting | `wait`, `watch` and every `--wait` follow work through it. Without it, the commands still start the work, but cannot wait for it. |
| **Claude Code or Codex** (optional) | For the plugin. Other agents work too: see [Agents without a plugin](#agents-without-a-plugin). |
| **Node.js 20.3 or newer** (optional) | Only to run `cavelon` through `npx` or install it with npm instead: [With Node.js](#with-nodejs-npx-or-npm). |

If you are not sure whether your instance has personal access tokens and the
operations API turned on, log in (step 3 of [Getting started](getting-started.md))
and run `cavelon status`; the [troubleshooting page](troubleshooting.md) shows
what each refusal means.

## Install the CLI

### One line (recommended)

On macOS or Linux, in Terminal:

```bash
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh
```

On Windows, in PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex
```

The install script:

1. finds your system and processor, and picks the matching executable of the
   latest release of this repository;
2. downloads it and the release's `checksums.txt`, and stops without
   installing anything if the executable's SHA-256 checksum does not match;
3. puts it into a folder of your own, so it needs neither `sudo` nor an
   administrator: `~/.local/bin/cavelon` on macOS and Linux,
   `%LOCALAPPDATA%\Programs\cavelon\cavelon.exe` on Windows;
4. adds that folder to your `PATH` once, if it is not there yet, and says
   where: on macOS and Linux a line in your shell's startup file (`~/.zshrc`
   for zsh, `~/.bashrc` for bash on Linux, `~/.bash_profile` or `~/.profile`
   for bash on macOS, `~/.profile` for other shells, a file in
   `~/.config/fish/conf.d/` for fish), on Windows your user `PATH`;
5. prints the next step.

It sends nothing anywhere but the two downloads. Open a new terminal (on
Windows, the one you installed from works at once), then check it:

```bash
cavelon --version
```

Running the line again updates `cavelon` to the latest release, and changes
nothing else.

**Options.** On macOS and Linux, pass them after `sh -s --`; on Windows, set
the environment variable before the line:

| macOS, Linux | Windows | What |
|---|---|---|
| `--version 0.1.3` | `$env:CAVELON_VERSION = '0.1.3'` | that release instead of the latest |
| `--dir <folder>` | `$env:CAVELON_INSTALL_DIR = '<folder>'` | another folder |
| `--no-modify-path` | `$env:CAVELON_NO_MODIFY_PATH = '1'` | change no startup file or `PATH`; it tells you what to add |
| `CAVELON_DOWNLOAD_URL=<url>` | `$env:CAVELON_DOWNLOAD_URL = '<url>'` | download from a folder holding the release's files, such as a mirror, instead of GitHub |

```bash
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh -s -- --version 0.1.3
```

**Read it first.** To see what you run, download the script, read it, then
run it:

```bash
curl -fsSLO https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh
less install.sh
sh install.sh
```

On Windows, `irm <url> -OutFile install.ps1`, read it, then
`powershell -ExecutionPolicy Bypass -File install.ps1` (it takes `-Version`,
`-InstallDir` and `-NoModifyPath`).

**Check the executable yourself.** Every release lists the SHA-256 checksum of
each of its files in `checksums.txt`, and carries a build provenance
attestation for each: a signed record that this repository's release workflow
built the file from the tagged commit. With the GitHub CLI:

```bash
gh attestation verify ~/.local/bin/cavelon --repo goodguys-gmbh/cavelon-dev-kit
```

The executables are built with [Bun](https://bun.sh), which bundles `cavelon`
and a JavaScript runtime into one file. It keeps the token in your system's
credential store as the npm package does.

#### Unsigned executables: Gatekeeper and SmartScreen

Until the executables are signed (on macOS also notarised), macOS and Windows
may warn about them. The install scripts download with `curl` and PowerShell,
which do not mark the file as downloaded from the internet, so neither system
asks when you run `cavelon` installed that way. If you download an executable
from the release page in a browser:

- **macOS** refuses to open it, because Apple could not check it for
  malicious software. Remove the browser's mark once:
  `xattr -d com.apple.quarantine ./cavelon-darwin-arm64`, or open
  **System Settings → Privacy & Security** and choose **Open Anyway**.
- **Windows** shows "Windows protected your PC" (SmartScreen). Choose
  **More info → Run anyway**, or remove the mark in PowerShell:
  `Unblock-File .\cavelon-windows-x64.exe`.
- On Windows 11 with **Smart App Control** turned on, and where your
  organisation allows only signed programs, an unsigned `cavelon` does not
  start at all. Use `npx` there ([With Node.js](#with-nodejs-npx-or-npm)).

Check the checksum or the attestation (above) before you do either.

### Homebrew and winget

A Homebrew tap and a winget package are being prepared. Once the
[changelog](../CHANGELOG.md) announces them:

```bash
brew install goodguys-gmbh/cavelon/cavelon      # macOS, Linux
winget install goodguys.Cavelon                 # Windows
```

They install the same executables, and update with `brew upgrade cavelon` and
`winget upgrade goodguys.Cavelon`.

### With Node.js: npx or npm

With Node.js 20.3 or newer and npm, `npx` runs `cavelon` without an install:

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

#### Type `cavelon` instead (optional)

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
works as it is. Or skip the global install: the one-line install, `npx` and
the alias above need none of this.

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
claude mcp list                                 # plugin:cavelon:cavelon: sh -c if command -v cavelon … - ✔ Connected
```

### Codex

```bash
codex plugin marketplace add goodguys-gmbh/cavelon-dev-kit
codex plugin add cavelon@cavelon-dev-kit
codex plugin list    # cavelon@cavelon-dev-kit  installed, enabled
codex mcp list       # cavelon  sh  -c if command -v cavelon …  enabled
```

Codex installs plugins for your user. To give everyone on a repository the
skills and the MCP server, write them into the repository with
`cavelon init --agents codex` (next section).

### How the plugin runs `cavelon`

The plugin starts the MCP server through `sh`: `cavelon mcp` when a `cavelon`
is on your `PATH` (the one-line install, Homebrew or `npm i -g`), and
otherwise `npx -y @cavelon/cli@0.1 mcp`, the latest 0.1 release. So with the
plugin you need nothing else as long as you have either. The pin keeps a
release that may change behaviour (0.2) away from `npx` until you update the
plugin; an installed `cavelon` is the version you installed.

Native Windows has no `sh`: add the server yourself there, as
[Windows](#windows) shows. In WSL, everything works as on Linux.

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

The MCP entry it writes starts `npx -y @cavelon/cli@0.1 mcp`, which needs
Node.js on every machine that uses it. If your team installs `cavelon` with
the one-line install instead, change the entry to start it directly,
`{ "command": "cavelon", "args": ["mcp"] }` (in `.codex/config.toml`,
`command = "cavelon"` and `args = ["mcp"]`); `init --update` keeps an entry you
changed.

## Updating

Run the one-line install again: it replaces `cavelon` with the latest release
(or the one `--version` names) and changes nothing else.

```bash
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex
```

The other ways in, and the plugin:

```bash
npm i -g @cavelon/cli                                   # the CLI, if npm installed it
claude plugin marketplace update cavelon-dev-kit       # Claude Code
claude plugin update cavelon@cavelon-dev-kit
codex plugin marketplace upgrade cavelon-dev-kit        # Codex
codex plugin add cavelon@cavelon-dev-kit
cavelon init --update                                   # in a solution set up with --agents
```

Through `npx`, `cavelon` needs no update: `npx -y @cavelon/cli` looks up the
newest release each time it starts. `cavelon --version` shows which one runs.

`cavelon` learns each instance's API, package schema and docs from what the
instance publishes, so a new Cavelon version on the server does not need a new
`cavelon`. Update the kit for its own fixes and features; the
[changelog](../CHANGELOG.md) lists them.

## Uninstalling

First delete your stored tokens, and remove the plugin if you added it:

```bash
cavelon logout --all                          # deletes every stored token
claude plugin uninstall cavelon@cavelon-dev-kit
codex plugin remove cavelon@cavelon-dev-kit
```

Then remove `cavelon` the way it came. Installed with the one-line install, on
macOS or Linux:

```bash
rm ~/.local/bin/cavelon
```

and delete the two lines the installer added to your shell's startup file (it
named the file): `# Added by the cavelon installer` and the `export PATH=…`
line below it. On Windows, in PowerShell:

```powershell
$dir = "$env:LOCALAPPDATA\Programs\cavelon"
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$path = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $dir }
$key.SetValue('Path', ($path -join ';'), 'ExpandString')
Remove-Item -Recurse -Force $dir
```

Installed with npm: `npm uninstall -g @cavelon/cli`.

`logout` deletes the tokens from your machine; they remain valid in Cavelon
until you revoke them on **`/account/access-tokens`**. To remove everything,
also delete the configuration and cache folders listed in
[Security](security.md#files-on-your-machine).

## Operating systems

`cavelon` runs on Linux, macOS and Windows, and CI tests it on all three: the
npm package with Node.js, and each standalone executable on its own platform.

### Windows

- Use PowerShell, Windows Terminal or cmd. The one-line install puts
  `cavelon.exe` on your user `PATH`; so does `npm i -g @cavelon/cli`, and
  `npx -y @cavelon/cli` works in each.
- If PowerShell refuses `npx` (or an npm-installed `cavelon`) because running
  scripts is disabled on this system, it found npm's PowerShell script. Write
  `npx.cmd` instead, or allow local scripts for your user once:
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Your `$PROFILE`, and
  the alias function in it, needs that setting too. The `cavelon.exe` of the
  one-line install is a program, not a script, and needs neither.
- Windows PowerShell 5.1 does not accept `&&` between commands; where the docs
  join two with it, run them one after the other.
- The token is kept in the **Windows Credential Manager**.
- Settings are in `%APPDATA%\cavelon`, the cache in `%LOCALAPPDATA%\cavelon\cache`.
- Commands that `cavelon` prints for you to copy are quoted for the shell it runs
  in (PowerShell, cmd or a POSIX shell). If it guesses wrong, set
  `CAVELON_SHELL` to `powershell`, `cmd` or `posix`.
- In PowerShell, quote arguments that contain spaces with single quotes:
  `cavelon kb upload seeds/faq --kb 'Support FAQ'`.
- The plugin's MCP server is started through `sh`, which native Windows does
  not have, so add the server yourself; the plugin's skills work as they are.
  With `cavelon.exe` installed:

  ```powershell
  claude mcp add --scope user cavelon -- cavelon mcp
  codex mcp add cavelon -- cavelon mcp
  ```

  Through `npx` instead: an agent starts its MCP servers without a shell, and
  on native Windows `npx` is `npx.cmd`, which runs only through one:

  ```powershell
  claude mcp add --scope user cavelon -- cmd /c npx -y @cavelon/cli@0.1 mcp
  codex mcp add cavelon -- cmd /c npx -y @cavelon/cli@0.1 mcp
  ```

- `cavelon init --agents` run on Windows therefore writes the entry as
  `cmd /c npx -y @cavelon/cli@0.1 mcp`. In a repository people also use on
  macOS or Linux, the entry stays in the form it was first written in, and
  `init --update` keeps it: whoever is on the other system adds the server
  for themselves (above).
- In WSL, everything works as on Linux.

### macOS

- The token is kept in the **Keychain**.
- Settings are in `~/.config/cavelon`, the cache in `~/.cache/cavelon`.

### Linux

- The executables need glibc. On Alpine and other musl-based systems, the
  install script says so; use `npx` there.
- The token is kept through the **Secret Service** (GNOME Keyring, KWallet).
  On a machine without one, such as a server or a container, it goes into
  `~/.config/cavelon/credentials.json`, which only you can read, and `login`
  says so.
- Settings follow `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` when they are set.

## Behind a proxy

**Installing.** The install script downloads with `curl` (or `wget`), which
read `HTTPS_PROXY`; PowerShell uses the system's proxy settings. npm uses its
own:

```bash
npm config set proxy http://proxy.example.com:3128
npm config set https-proxy http://proxy.example.com:3128
```

**Running.** The standalone `cavelon` reads the standard proxy variables
itself:

```bash
export HTTPS_PROXY=http://proxy.example.com:3128
export NO_PROXY=localhost,127.0.0.1
cavelon whoami
```

Through Node.js (`npx` or `npm i -g`), `cavelon` uses Node.js's built-in HTTP
client, which reads them only when `NODE_USE_ENV_PROXY=1` is set too (Node.js
24, and recent Node.js 22 releases); on older Node.js versions, update Node.js.
Set the variables where your coding agent starts too (your shell profile), so
the MCP server it launches inherits them.

**A proxy that inspects TLS** presents its own certificate. Give `cavelon` your
organisation's CA certificate; both the standalone `cavelon` and Node.js read
this variable:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem
```

**Timeouts.** A request waits up to 30 seconds by default;
`CAVELON_HTTP_TIMEOUT_MS` changes that for a slow network.

## From source

To try a change before it is released, or to contribute: see
[CONTRIBUTING.md](../CONTRIBUTING.md#build-and-test).
