# Upgrading from 0.1 to 0.2

Version 0.2.0 is the next minor release of the dev-kit: the CLI, the skills and
the plugin move together. **It is upcoming until its release is published.**
Until `v0.2.0` appears on the
[releases page](https://github.com/goodguys-gmbh/cavelon-dev-kit/releases) and
`npm view @cavelon/cli version` names it, the install and update commands
below that name no version still bring you the newest 0.1 release, and the
ones that name 0.2 find nothing. Read the 0.2.0 entry in the
[changelog](../CHANGELOG.md) before you upgrade.

This page says what changes for you, what the version number does not mean,
and how to move each part: the CLI, your coding agents, your solution
repositories, CI, and machines without internet access.

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

## What the version number does not mean

0.2 is a version number, not a certificate. These gates are recorded on their
own and are not passed by publishing 0.2:

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

`setup` replaces the skills and the server entries it wrote and recorded, and
changes nothing else. An entry you changed yourself, or one you added by hand
(such as `claude mcp add cavelon -- npx -y @cavelon/cli@0.1 mcp`), stays yours:
`setup` reports it, and you change it to `cavelon mcp` or to
`@cavelon/cli@0.2` yourself. `setup --check` shows the command each agent's
Cavelon tools start, so an entry still on `@cavelon/cli@0.1` stands out.

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

`init --update` changes only the blocks between its markers and the files a
previous `init` wrote; an MCP entry you changed (for example to
`uvx` or to `cavelon mcp`) stays as you wrote it. Everyone who pulls the commit
gets the same skills and entries.

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

The bundle does not install or configure the coding clients, their model
endpoint, or the instance's model provider: those are provisioned and decided
separately, and the [customer pilot](customer-pilot.md) records them.

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

Nothing moves you to 0.2 on its own: entries pinned to `@0.1` and installs you
do not update stay on 0.1. To go back, install 0.1.18 exactly and keep the
0.1 pins:

```bash
curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh -s -- --version 0.1.18
npm i -g @cavelon/cli@0.1.18                # or: uv tool install 'cavelon==0.1.18'
```

Offline, install from the verified 0.1.18 bundle and point the marketplace at
its folder again. Then run `cavelon setup` and `cavelon init --update` with
that version, so the skills match it.
