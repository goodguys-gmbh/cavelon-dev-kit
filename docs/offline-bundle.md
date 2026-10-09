# The offline bundle

Some instances run where developers' machines reach neither GitHub, npm nor
PyPI. For them, each release carries the whole dev-kit as one signed file:
`cavelon-bundle-<version>.tar.gz`. Someone with internet access downloads and
verifies it once and brings it inside, or the instance serves the bundle that
matches its own version. Then developers install `cavelon`, the plugin and the
skills from it without a network.

This page describes the bundle's format, how to verify it, and how to install
from it. The bundle exists for releases after 0.1.12.

## The release files

| Release file | What |
|---|---|
| `cavelon-bundle-<version>.tar.gz` | the bundle |
| `cavelon-bundle-<version>.tar.gz.sigstore.json` | its signature, a [Sigstore bundle](https://docs.sigstore.dev/about/bundle/) |
| `cavelon-bundle-<version>.manifest.json` | a copy of the bundle's `manifest.json` |
| `cavelon-bundle-<version>.manifest.json.sigstore.json` | the manifest's signature |

The release workflow signs both files keylessly with Sigstore (`cosign
sign-blob`): GitHub Actions vouches that this repository's release workflow
ran for the release's tag, Sigstore's certificate authority certifies that
identity for a few minutes, and the signature is recorded in its public
transparency log. No signing key exists that could leak. Both files also carry
a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations),
like the release's executables.

## What the bundle holds

Everything is below one folder, `cavelon-bundle-<version>/`:

| Path | What |
|---|---|
| `manifest.json` | the bundle's files, their sizes and SHA-256, the version and the instance contract versions ([The manifest](#the-manifest)) |
| `bin/cavelon-<os>-<arch>[.exe]` | the standalone executable for each platform: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64` |
| `bin/checksums.txt`, `bin/install.sh`, `bin/install.ps1` | the release's install scripts, which install from this folder ([Install from the bundle](#install-from-the-bundle)) |
| `plugin/` | the Cavelon plugin for Claude Code and Codex, with the offline MCP entry |
| `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` | the marketplaces of Claude Code and Codex, so the bundle's folder is a local marketplace |
| `skills/` | the skills, for agents without a plugin |
| `mcp/cavelon.mcp.json` | the offline MCP entry for agents without a plugin |
| `plugin-packages/` | the plugin packages for the other clients, in their offline variant ([The plugin packages](#the-plugin-packages)) |
| `README.md`, `LICENSE` | a short guide, and the license (Apache-2.0) |

**The offline MCP entry.** The plugin you install from GitHub starts the
`cavelon` on the PATH, or else `npx -y @cavelon/cli@<minor> mcp`, which needs
the npm registry. The bundle's plugin, and `mcp/cavelon.mcp.json`, start only
the `cavelon` on the PATH, and turn off the update check
(`CAVELON_NO_UPDATE_CHECK=1`), which would only wait for GitHub:

```json
{
  "mcpServers": {
    "cavelon": {
      "command": "cavelon",
      "args": ["mcp"],
      "env": { "CAVELON_PLUGIN_VERSION": "<version>", "CAVELON_NO_UPDATE_CHECK": "1" }
    }
  }
}
```

So install `cavelon` from `bin/` before the plugin.

### The plugin packages

`plugin-packages/` holds the [plugin packages](install/README.md#the-packages)
for Cursor, VS Code with GitHub Copilot, Copilot CLI, Kiro and Gemini CLI, and
the marketplace for Claude Code and Codex, under the same file names as the
release's own: `cavelon-agent-plugin.tar.gz`,
`cavelon-agent-plugin-windows.tar.gz`, `darwin.`, `linux.` and
`win32.cavelon-gemini-extension.tar.gz`, and `cavelon-marketplace.tar.gz`.

They are the **offline variant**, which
`node packaging/render.mjs plugins --server installed` renders: their MCP entry
is `cavelon mcp` on every platform, the `cavelon` on the PATH. The packages
attached to the release start the same `cavelon` when there is one and
otherwise fall back to `npx -y @cavelon/cli@<minor> mcp` (on Windows always
`cmd /c npx …`), which needs the npm registry. So a package from the bundle
and the release's package of the same name differ in their MCP entry, and in
their SHA-256: check a package from the bundle against `manifest.json`, not
against the release's `checksums-plugins.txt`. Unlike the bundle's `plugin/`,
their entry does not turn off the update check; without a network it gives up
after a moment and says nothing.

## The manifest

`manifest.json` is the bundle's table of contents. Its schema is
[`contracts/offline-bundle-manifest.schema.json`](../contracts/offline-bundle-manifest.schema.json)
(JSON Schema 2020-12):

```json
{
  "format": 1,
  "name": "cavelon-bundle",
  "version": "0.1.13",
  "repository": "goodguys-gmbh/cavelon-dev-kit",
  "commit": "<the commit the release was built from>",
  "instance_contracts": {
    "api_versions": ["v1"],
    "package_versions": ["v1", "v2", "v3"]
  },
  "executables": [
    { "platform": "darwin-arm64", "path": "bin/cavelon-darwin-arm64" },
    { "platform": "windows-x64", "path": "bin/cavelon-windows-x64.exe" }
  ],
  "mcp": { "plugin": "plugin/.mcp.json", "entry": "mcp/cavelon.mcp.json" },
  "files": [
    { "path": ".agents/plugins/marketplace.json", "size": 437, "sha256": "<64 hex digits>" },
    { "path": "bin/cavelon-darwin-arm64", "size": 61203456, "sha256": "<64 hex digits>" }
  ]
}
```

| Member | What |
|---|---|
| `format` | the bundle format's version, `1`. A reader ignores members it does not know; a new number means a change a reader of format 1 cannot follow. |
| `version` | the release: the version of `cavelon`, the plugin and the skills |
| `repository`, `commit` | where the release was built, and from which commit |
| `instance_contracts` | the instance contract versions this release understands ([Which bundle fits an instance](#which-bundle-fits-an-instance)) |
| `executables` | each platform's executable |
| `mcp` | the offline MCP entries: the plugin's and the one for agents without a plugin |
| `files` | every file of the bundle except `manifest.json` itself, sorted by path (byte order), relative to the bundle's folder, with its size in bytes and SHA-256 |

**The archive.** A gzip-compressed POSIX tar (USTAR; a PAX `path` record only
for a name USTAR cannot hold) with regular files and folders only. The entries
are sorted, owned by 0:0, dated 1980-01-01, and the gzip header carries no time
or system, so the same inputs give the same bytes. The executables and
`install.sh` have mode 0755, everything else 0644.

### Which bundle fits an instance

An instance publishes its contract versions in `GET /api/v1/meta/capabilities`:
`contracts.api_version`, and `contracts.package_versions` with `current` and
`accepted`. A bundle fits the instance when `instance_contracts.api_versions`
contains its `api_version`, and `instance_contracts.package_versions`
contains its `current` package version (or, less well, one of its `accepted`
ones). Of the bundles that fit, take the newest `version`. This is the same
comparison `cavelon login` and `cavelon status` make, which warn when the
instance speaks a contract version this `cavelon` does not understand.

## Verify the bundle

Verify the signature before you extract the bundle, then every file against the
manifest. You need [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
3 or newer, the major version the release signs with.

**On a machine with internet access**, for release `X.Y.Z`:

```bash
cosign verify-blob cavelon-bundle-X.Y.Z.tar.gz \
  --bundle cavelon-bundle-X.Y.Z.tar.gz.sigstore.json \
  --certificate-identity https://github.com/goodguys-gmbh/cavelon-dev-kit/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
# Verified OK
```

The same command with `cavelon-bundle-X.Y.Z.manifest.json` and its
`.sigstore.json` verifies the manifest alone, which is enough for an instance
that keeps the manifest beside the bundle and checks the files after
extracting. To accept any release rather than one tag, use
`--certificate-identity-regexp '^https://github\.com/goodguys-gmbh/cavelon-dev-kit/\.github/workflows/release\.yml@refs/tags/v'`
in place of `--certificate-identity`.

With the GitHub CLI, the build provenance can be checked too:
`gh attestation verify cavelon-bundle-X.Y.Z.tar.gz --repo goodguys-gmbh/cavelon-dev-kit`.

**On a machine without internet access**, cosign cannot fetch Sigstore's
trusted root (the certificate authority's and the transparency log's keys), so
bring it along. On a machine with internet access, after any `cosign
verify-blob` (or `cosign initialize`), copy
`~/.sigstore/root/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json`, then
on the offline machine:

```bash
cosign verify-blob cavelon-bundle-X.Y.Z.tar.gz \
  --bundle cavelon-bundle-X.Y.Z.tar.gz.sigstore.json \
  --trusted-root trusted_root.json \
  --certificate-identity https://github.com/goodguys-gmbh/cavelon-dev-kit/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The signature bundle carries the certificate, the transparency log's
inclusion proof and its signed timestamp, so nothing else is looked up.
Sigstore rotates its keys rarely; fetch the trusted root again when a newer
release no longer verifies with the copy you have.

**After extracting**, check that the manifest is the one you verified, and
every file against it (macOS: `shasum -a 256 -c` in place of `sha256sum -c`):

```bash
tar -xzf cavelon-bundle-X.Y.Z.tar.gz
cd cavelon-bundle-X.Y.Z
cmp manifest.json ../cavelon-bundle-X.Y.Z.manifest.json      # when you verified the manifest alone
jq -r '.files[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum --quiet -c - && echo "all files match"
# and nothing that the manifest does not list:
diff <(find . -type f ! -path ./manifest.json | sed 's|^\./||' | LC_ALL=C sort) <(jq -r '.files[].path' manifest.json | LC_ALL=C sort)
```

## Install from the bundle

From the extracted `cavelon-bundle-X.Y.Z` folder. The install scripts take the
release's files from `bin/` when `CAVELON_DOWNLOAD_URL` names that folder, check
the executable against `bin/checksums.txt`, and install it as they do from
GitHub ([One line](installation.md#one-line-recommended)):

macOS and Linux:

```bash
CAVELON_DOWNLOAD_URL="$PWD/bin" sh bin/install.sh
```

Windows (Windows PowerShell 5.1 or PowerShell 7):

```powershell
$env:CAVELON_DOWNLOAD_URL = "$PWD\bin"; & .\bin\install.ps1
```

Both take the same options as from GitHub (`--dir`, `--no-modify-path`;
`-InstallDir`, `-NoModifyPath`). Installed this way, an executable for macOS
has no quarantine flag, so Gatekeeper does not ask to look up its
notarisation online.

**The plugin, Claude Code and Codex.** Add the bundle's folder as the
marketplace, then install the plugin from it. Keep the folder where it is: the
clients read the marketplace from there.

```bash
claude plugin marketplace add /path/to/cavelon-bundle-X.Y.Z
claude plugin install cavelon@cavelon-dev-kit

codex plugin marketplace add /path/to/cavelon-bundle-X.Y.Z
codex plugin add cavelon@cavelon-dev-kit
```

The marketplace has the same name as the one on GitHub, `cavelon-dev-kit`, so
`cavelon setup` then finds the plugin installed and sets up the other agents:
Cursor, VS Code with GitHub Copilot, Gemini CLI and Kiro get the skills the
executable carries and the `cavelon mcp` entry, with no network. Its login
reaches only your instance.

**Without `cavelon setup`**, copy `skills/` into the agent's skills folder and
the entry in `mcp/cavelon.mcp.json` into its MCP configuration; the
[agents without a plugin](installation.md#agents-without-a-plugin) section says
where each agent keeps them. `cavelon init --agents` writes both into a
solution repository, as from any other install.

**The plugin packages** in `plugin-packages/` install as each client's page in
[docs/install/](install/README.md) says for a downloaded package: unpack the
one for your client and system into a folder and install that folder. Their
MCP entry is `cavelon mcp`, so install `cavelon` from `bin/` first.
`cavelon-marketplace.tar.gz` holds the same plugin as the bundle's own folder,
which already is a marketplace.

### Updating

Install the next release's bundle the same way: `install.sh` or `install.ps1`
replaces `cavelon`, and in Claude Code and Codex, point the marketplace at the
new folder (`claude plugin marketplace remove cavelon-dev-kit`, then add the
new folder and install again). `cavelon --version` still names the online
update command; offline, the next bundle is the update.

## Qwen Code CLI

Qwen Code's file integration (0.1.16+) also works from the installed
executable: `cavelon setup --agents qwen` copies the bundled skills and writes
`cavelon mcp`, without a marketplace or registry install. Guarded changes remain
person-terminal commands. Provision Qwen and its model separately; see
[Qwen Code](install/qwen-code.md#update).

## Native OpenCode and Pi adapters

The standalone executable carries the same dependency-bundled native adapter
assets as npm. With the executable already on PATH, `cavelon setup --agents
opencode,pi` installs those assets and skills locally. Project init can reuse
that verified user installation or write portable project profiles. No native
dependency is downloaded while setup installs the bundled files.

Provision the selected client and its model runtime separately before blocking
external egress. The coding-model provider and the Cavelon instance's execution
provider are separate settings. An offline artifact alone does not configure
either one. See the [qualification matrix](coding-agent-qualification.md) for
the tested runtime scope and
[OpenCode](install/opencode.md) and [Pi](install/pi.md).

## For an instance that serves the bundle

An instance can keep the bundles beside itself and offer the one that fits its
version ([Which bundle fits an instance](#which-bundle-fits-an-instance)):

1. Download the four release files from
   `https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/download/vX.Y.Z/`.
2. Verify the signature of the bundle, or of the manifest, as above, with the
   certificate identity of this repository's release workflow and the issuer
   `https://token.actions.githubusercontent.com`. Refuse a bundle that does not
   verify.
3. Read `format` (refuse one it does not know), `version` and
   `instance_contracts` from the verified manifest.
4. Serve the tarball, its signature and the manifest as they are, so a
   developer can verify them again. To serve single files (such as one
   platform's executable), extract them and check each against the manifest's
   size and SHA-256 first.

Until your instance serves a bundle, bring a verified copy in as described
above.

## Cline

When your kit release includes Cline setup, provision Cline separately, install
the verified local executable, then run `cavelon setup --agents cline`. Setup
copies bundled skills and writes `cavelon mcp` without a runtime package fetch.
Project init copies skills only. Keep guarded changes in your own terminal and
launch the coding client with its guard marker; see [Cline](install/cline.md).

## Kilo

When your kit release includes Kilo setup, provision the client separately and
put the installed offline Cavelon executable on PATH before setup/init. Its
server/TUI plugins and dependencies are carried inside that executable. Setup
records a disabled duplicate entry and owned profile, preserving other servers
and plugins. Provision the coding model and instance providers separately.
Use the CLI’s fresh person dialog, or the person’s terminal in editor/headless
mode; see [Kilo](install/kilo.md). The Linux candidate passed the complete
locally installed workflow; see the [qualification matrix](coding-agent-qualification.md).

## Goose

When your kit release includes Goose setup, provision Goose and its model
runtime separately. Install the verified Cavelon executable on PATH, then run
`cavelon setup --agents goose`. It writes `cavelon mcp` into native user YAML
and installs bundled skills without fetching an adapter or registry package.
Person forms require an interactive CLI session; headless runs refuse them.
See [Goose](install/goose.md). Its Linux candidate passed the complete locally
installed workflow, separately from configuration and client-loading evidence.

## OMP

A kit release with OMP includes its bundled adapter and four skills. Provision
the released OMP client, compatible Bun runtime and approved model endpoint
separately. Setup and adapter loading run no npm/npx fetch. Use the same profile
selection for setup and OMP; native configuration stays in that profile's agent
directory. See [OMP](install/omp.md) and the
[qualification matrix](coding-agent-qualification.md). Actual network-policy
and customer-provider pilots remain separate from synthetic offline checks.
