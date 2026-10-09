# Upgrading from 0.1 to 0.2

Version 0.2.0 is a minor release of the dev-kit: the CLI, the skills and the
plugin move together. This page says what changes, which acceptance checks
are still open, and how to move each part: the CLI, your coding agents, your
solution repositories, CI, and machines without internet access. Read the
0.2.0 entry in the [changelog](../CHANGELOG.md) first.

Check that the release is published before you run a command that names 0.2:

```bash
gh release view v0.2.0 --repo goodguys-gmbh/cavelon-dev-kit   # or the releases page
npm view @cavelon/cli version                                 # 0.2.0 or newer
```

Until both name it, commands without a version still bring the newest 0.1
release, and commands that name 0.2 find nothing.

## What changes

- **The release-line pin moves to 0.2.** Wherever the kit starts its MCP
  server through `npx`, the entry names the kit's minor version: 0.1 entries
  start `npx -y @cavelon/cli@0.1 mcp`, 0.2 entries `npx -y @cavelon/cli@0.2 mcp`.
  While the kit is in 0.x a new minor version may change behaviour, so it
  reaches an agent only when you refresh what starts the server: the plugin,
  `cavelon setup`, or `cavelon init --update`. An entry that starts the
  installed `cavelon mcp` runs whichever `cavelon` you installed.
- **Thirteen setup clients.** Claude Code, Codex, Cursor, VS Code with GitHub
  Copilot, Kiro and Gemini CLI, and since 0.1.16 and 0.1.17 the seven native
  clients OpenCode, Pi, Qwen Code CLI, Cline, Kilo, Goose and OMP. Each has
  its own [install page](install/README.md) with its update steps.
- **Database queries.** List parameters for `IN (:name)` and `NOT IN (:name)`
  (since 0.1.18), and the `oracle` dialect where your instance publishes it
  ([#237](https://github.com/goodguys-gmbh/cavelon-dev-kit/issues/237)). Both
  follow what the instance publishes; an older instance keeps working as
  before. [Connect a database](connect-a-database.md) has the details.

What stays the same:

- **A person approves every guarded change, freshly.** The kit asks the person
  before each guarded change, in the client's dialog where that is qualified,
  otherwise in their own terminal. The instance binds its confirmation to the
  token, tenant and exact request; it does not check the person's answer. An
  earlier yes never covers another change.
- **Your login.** Upgrading needs no new token and no new login. Tokens stay
  in your credential store; log in only from your own terminal, never from an
  agent's shell.
- **Your solutions.** The package format and the API come from your instance,
  not from the kit version, so your `package/`, `tests/` and `env/` files need
  no migration.

## Acceptance still open

Publishing 0.2.0 changes none of these. Each row says what has been checked
and what is still missing:

| Gate | Where it stands | Record |
|---|---|---|
| Released-client CLI workflows (all seven pinned clients, Linux x64, macOS arm64, Windows x64) | automated, with a scripted model and a fake instance; no person, no real provider | [qualification matrix](coding-agent-qualification.md) |
| Person approval on Linux | passed for the clients and versions the matrix names | [qualification matrix](coding-agent-qualification.md) |
| Person approval on native Windows, WSL and macOS | open; needs an actual host, client and person per platform | [remaining host gates](person-approval-qualification.md#remaining-host-gates) |
| Editors, desktop apps, ACP and RPC hosts | open per surface; a CLI check does not qualify an editor | [qualification matrix](coding-agent-qualification.md) |
| A customer's internal model, network policy, offline install and databases | a pilot per customer; never inferred from kit tests | [customer pilot](customer-pilot.md) |
| Oracle against a real Oracle database | kit tests use the instance's published contract and a fake server, never a real database | [customer pilot](customer-pilot.md#databases) |

## Before you start

1. Write down where you are, so you can compare afterwards:

   ```bash
   cavelon --version                 # the version and how it was installed
   cavelon setup --check             # each agent's entry, the MCP server, the login
   ```

2. Commit or set aside open changes in your solution repositories:
   `cavelon init --update` changes files there.
3. Close your coding agents, or plan to restart them at the end.

## 1. Update `cavelon`

`cavelon --version` names the way you installed it. Use the matching line:

| Installed with | Update to 0.2 |
|---|---|
| the one-line install | the install line again; `sh -s -- --version 0.2.0` (Windows: `$env:CAVELON_VERSION = '0.2.0'`) names the release |
| Homebrew | `brew upgrade cavelon` |
| `uv tool install` | `uv tool upgrade cavelon` |
| `pipx install` | `pipx upgrade cavelon` |
| `pip install` | `pip install --upgrade cavelon` |
| `uvx` | `uvx cavelon@0.2.0`, or the range `uvx 'cavelon>=0.2,<0.3'` |
| `npm i -g` | `npm i -g @cavelon/cli@0.2` |
| `npx` | `npx -y @cavelon/cli@0.2`; an `@0.1` you typed stays on 0.1 |
| the offline bundle | [Machines without internet access](#5-machines-without-internet-access) |

```bash
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh -s -- --version 0.2.0
```

```powershell
$env:CAVELON_VERSION = '0.2.0'; irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex
```

Then `cavelon --version` should say `0.2.0`. If you installed `cavelon` in
more than one way, update each, or remove the ones you do not use
([Uninstalling](installation.md#uninstalling)): the plugin starts the first
`cavelon` on your `PATH`.

## 2. Refresh your coding agents

Run setup again, with the same environment you set it up with (for example
`CLINE_DIR`, Goose's path and layer overrides, or the OMP profile):

```bash
cavelon setup
cavelon setup --check
```

`setup` replaces the skills it wrote and moves the server entries it
recognizes to this release's entry: `cavelon mcp` when `cavelon` is installed,
otherwise `npx -y @cavelon/cli@0.2 mcp`. It recognizes an entry that is exactly a form the kit
writes, `cavelon mcp` or `npx -y @cavelon/cli@0.1 mcp` (or `@0.2`; on Windows
`cmd /c npx …`), in a file it manages, even when a person typed it there.
OpenCode, Pi, Kilo and OMP move through the installation `setup` recorded. An
entry with anything else (other options, another command or range, extra
environment) is preserved and reported, and you change it yourself.
`setup --check` shows the command each agent's Cavelon tools start, so an
entry still on `@cavelon/cli@0.1` stands out.

Clients that install the plugin update it with their own commands:

```bash
claude plugin marketplace update cavelon-dev-kit   # Claude Code
claude plugin update cavelon@cavelon-dev-kit
codex plugin marketplace upgrade cavelon-dev-kit   # Codex
codex plugin add cavelon@cavelon-dev-kit
gemini extensions update cavelon                   # Gemini CLI
copilot plugin update cavelon                      # Copilot CLI
```

A plugin package you unpacked for Cursor, VS Code or Kiro: unpack the new
release's package over the same folder, or install the Kiro power again
([the packages](install/README.md#the-packages)). Each client's page has its
own update section: [Install the kit in your coding agent](install/README.md).

Restart each agent, or start a new session, so it loads the new skills and
server. On its first tool call the MCP server says when the plugin or a
solution's skills are still behind
([When you work only through a coding agent](installation.md#when-you-work-only-through-a-coding-agent)).

## 3. Update your solution repositories

In each solution folder that `cavelon init --agents` set up (in a repository
with several solutions, each such folder):

```bash
cavelon init --update
git diff                     # the marked blocks, skills and MCP entries it refreshed
cavelon validate
git add -A && git commit -m "Update the Cavelon dev-kit files to 0.2"
```

`init --update` changes the blocks between its markers, the files a previous
`init` wrote, and MCP entries in the exact 0.1 form, which it rewrites in the
form for the system it runs on. An entry you customized (for example to `uvx`)
stays as you wrote it. Everyone who pulls the commit gets the same skills and
entries.

## 4. CI and cloud agents

Move the range in your pipelines when you choose to:

| Before | After |
|---|---|
| `npx -y @cavelon/cli@0.1 <command>` | `npx -y @cavelon/cli@0.2 <command>` |
| `uvx 'cavelon>=0.1,<0.2' <command>` | `uvx 'cavelon>=0.2,<0.3' <command>` |
| an exact `@cavelon/cli@0.1.18` or `cavelon@0.1.18` | `@cavelon/cli@0.2.0` or `cavelon@0.2.0` |

Where uv's cache stays between runs, add `--refresh` once. The skills and
MCP entries a cloud agent reads come from the repository: step 3 updates them.
[Cloud agents and CI](install/cloud-and-ci.md) has the rest.

## 5. Machines without internet access

The [offline bundle](offline-bundle.md) of 0.2.0 replaces the one of 0.1.
Someone with internet access:

1. Downloads `cavelon-bundle-0.2.0.tar.gz`, its manifest and both
   `.sigstore.json` signatures from the `v0.2.0` release.
2. Checks it fits your instance
   ([Which bundle fits an instance](offline-bundle.md#which-bundle-fits-an-instance)).
3. Verifies it against the release workflow's identity for the tag `v0.2.0`:

   ```bash
   cosign verify-blob cavelon-bundle-0.2.0.tar.gz \
     --bundle cavelon-bundle-0.2.0.tar.gz.sigstore.json \
     --certificate-identity https://github.com/goodguys-gmbh/cavelon-dev-kit/.github/workflows/release.yml@refs/tags/v0.2.0 \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

4. Brings the verified files inside.

Inside, from the extracted `cavelon-bundle-0.2.0` folder, which stays where it
is, because Claude Code and Codex read the marketplace from it:

```bash
CAVELON_DOWNLOAD_URL="$PWD/bin" sh bin/install.sh     # Windows: $env:CAVELON_DOWNLOAD_URL = "$PWD\bin"; & .\bin\install.ps1
claude plugin marketplace remove cavelon-dev-kit
claude plugin marketplace add "$PWD" && claude plugin install cavelon@cavelon-dev-kit
codex plugin marketplace remove cavelon-dev-kit
codex plugin marketplace add "$PWD" && codex plugin add cavelon@cavelon-dev-kit
cavelon setup                                         # writes `cavelon mcp` entries; fetches nothing
cavelon setup --check
```

Then step 3 in each solution repository. Offline, `cavelon --version` still
names the online update command; the next verified bundle is the update.
The bundle's plugin turns the daily update lookup off; elsewhere
`CAVELON_NO_UPDATE_CHECK=1` does, and without a network the lookup fails
quietly anyway.

The bundle does not install the coding clients or set their model
endpoints; provision those separately. The [customer pilot](customer-pilot.md)
records those decisions.

## 6. Check

```bash
cavelon --version            # 0.2.0
cavelon setup --check        # every agent you use: set up and working
cavelon whoami               # your login and tenant, unchanged
cavelon status               # in a solution folder: instance, tenant, solution
```

In a test tenant, let the agent run one ordinary preview, and check that its
next guarded change still asks you, in its dialog or your terminal, before
anything changes. Never test that on production.

## Staying on 0.1, or going back

To stay on 0.1, update nothing and keep the `@0.1` and `'cavelon>=0.1,<0.2'`
pins. Unpinned `npx -y @cavelon/cli` and `uvx cavelon` take the newest release,
so pin them too.

To go back after upgrading, undo in this order. 0.1.18 does not recognize the
entries 0.2 writes, so 0.2 has to remove them:

1. With 0.2 still installed, remove what `setup` set up (your login stays):

   ```bash
   cavelon setup --remove
   ```

2. In each solution repository, revert the commit from step 3 rather than
   running `init --update` with 0.1.18:

   ```bash
   git revert <the "Update the Cavelon dev-kit files to 0.2" commit>
   ```

3. Install 0.1.18 exactly:

   ```bash
   curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh -s -- --version 0.1.18
   npm i -g @cavelon/cli@0.1.18                # or: uv tool install 'cavelon==0.1.18'
   ```

4. Give Claude Code and Codex the 0.1.18 plugin before running `setup`: its
   own marketplace step adds this repository as it is now, with the 0.2
   plugin. Add the marketplace from the `v0.1.18` release's
   `cavelon-marketplace.tar.gz`, unpacked into a folder you keep, or from the
   0.1.18 offline bundle's folder
   ([Claude Code](install/claude-code.md#install), [Codex](install/codex.md#install)).
   Gemini CLI's extension follows the version of `cavelon` that installs it.
5. Run `cavelon setup` and `cavelon setup --check` with 0.1.18.
6. Change any entry you wrote yourself with `@0.2`, and your CI pins, back to
   `@0.1` by hand.

Offline, install from the verified 0.1.18 bundle in step 3 and use its folder
in step 4.
