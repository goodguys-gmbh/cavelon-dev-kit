# Contributing

Thank you for helping with the Cavelon dev-kit. This guide covers how the
repository is laid out, how to build and test it, and what a change needs
before it is merged.

Report a vulnerability as [SECURITY.md](SECURITY.md) says, never in a public
issue.

## Layout

| Path | What |
|---|---|
| `cli/` | the `cavelon` CLI and MCP server: TypeScript on Node.js 20.3 or newer |
| `cli/src/commands/` | one file per command group; each command declares its options, help text and whether it is read-only |
| `cli/test/` | the tests, and the fake server that serves the contract snapshots |
| `cli/scripts/` | build helpers: copying the skills into the package, building the standalone executable, trimming and cleaning the contract snapshots, generating `docs/commands.md` |
| `plugin/` | the Cavelon plugin: `skills/` (the one source of the skills), `.mcp.json`, and a manifest each for Claude Code and Codex; the other clients' packages are rendered from it |
| `.claude-plugin/`, `.agents/plugins/` | the marketplaces of Claude Code and Codex, naming `plugin/` |
| `contracts/` | snapshots of what an instance publishes, the list of operations the kit uses, the published schemas of the clients' plugin formats (`clients/`), and the schema of the offline bundle's manifest |
| `install.sh`, `install.ps1` | the one-line installers of the standalone executable, published with each release |
| `packaging/` | what the release workflow writes for Homebrew and winget, the plugin packages for Cursor, VS Code, Kiro and Gemini CLI (`plugins.mjs`: `node packaging/render.mjs plugins`), the PyPI wheel builder (`pypi/`, standard-library Python), the offline bundle builder (`bundle/`, standard-library Node.js), and the macOS signing entitlements |
| `examples/` | solution repositories to copy: `support-faq/` (one agent and a knowledge base) and `expense-approval/` (a pipeline with an approval); the tests validate them |
| `docs/` | the user documentation |

## Build and test

```bash
cd cli
npm ci --ignore-scripts      # dependencies' install scripts never run
npm run typecheck
npm run lint
npm run build && node dist/cli.js --help
npm test
```

Use the clone's build from anywhere with `npm install -g .` in `cli/` (it links
to the clone, so keep the folder), and give your agent an MCP server of its
own to try it: `claude mcp add cavelon-dev -- cavelon mcp`.

CI runs the same steps on Linux (Node.js 20, 22 and 24), macOS and Windows, and
checks that the packed package carries the skills and the license.

A test that compares a printed command with a string pins the shell, since
`cavelon` quotes words for the shell it runs in (`'…'` for POSIX, `"…"` on
Windows): set `SHELL=/bin/sh` in the test sandbox's environment, or call
`useShell("posix")` around an in-process check and restore it afterwards.
Otherwise the test passes on Linux and macOS and fails only on Windows.

### The standalone executable

The releases also carry `cavelon` as one executable per platform, built with
[Bun](https://bun.sh) (`bun build --compile`): it bundles `dist/` and the Bun
runtime, so it runs without Node.js. With Bun installed (CI uses the version in
`cli/.bun-version`), build the one for your system and run its smoke test:

```bash
cd cli
npm run build && npm run build:executable      # bun scripts/build-executable.mjs → build/cavelon-<os>-<arch>[.exe]
CAVELON_EXECUTABLE="$PWD/build/cavelon-linux-x64" npm run test:executable
```

`scripts/build-executable.mjs` hands the executable the version, skills and
native adapter assets (`src/embedded.ts`), which the npm package reads from
files beside it. `scripts/build-native-assets.mjs` bundles the protocol
dependencies into separate OpenCode server/TUI entries and a Pi entry, with a
versioned inventory and redistribution licenses. The native UI framework and
the CLI's credential binding stay out of these adapter bundles. Each
executable is built on its own platform, because it carries the native
credential store binding (`@napi-rs/keyring`) that npm installed there. Bun
was chosen over Node.js single executable applications because it bundles the
ES modules as they are, embeds and loads that native binding from inside the
executable, and builds in one step. Without the binding, `cavelon` falls back
to the user-only credentials file, as the npm package does. On macOS the
script signs the executable ad hoc: the Keychain refuses an unsigned program
the token it stored, and Bun signs only its Apple silicon builds.

CI builds all five (macOS arm64 and x64, Linux x64 and arm64, Windows x64),
runs the smoke test on each platform (`--version`, `whoami` and a `login`
through the system's credential store against the fake server, `init --agents`
with the embedded skills, and an MCP handshake), and tests `install.sh` and
`install.ps1` (Windows PowerShell 5.1 and PowerShell 7) and the Homebrew
formula against them, served from a local folder: nothing is published.

### The plugin packages

`plugin/` is the one source of the plugin. Claude Code and Codex install it as
it is; for the other clients, each release attaches packages rendered from it
by `packaging/plugins.mjs` (the Agent Plugins format for Cursor, VS Code with
GitHub Copilot and Kiro, a Gemini CLI extension per platform, and the
marketplace for Claude Code and Codex offline). Render them from the
repository's root; Node.js is all it needs:

```bash
node packaging/render.mjs plugins                    # packaging-out/plugins/*.tar.gz, and each unpacked
node packaging/render.mjs plugins --server installed # the MCP entry starts the cavelon on the PATH, never npx
bash .github/scripts/test-plugin-packages.sh         # Gemini CLI validates, installs and lists its extension
```

`cli/test/plugin-packages.test.ts` checks the manifests against the Agent
Plugins schemas kept in `contracts/clients/` and Gemini CLI's own rules, and
that every render gives the same bytes. When a client changes its format,
change `packaging/plugins.mjs` and the client's page in `docs/install/`, and
say in the changelog what users of the old package do.

### The offline bundle

Each release also carries `cavelon-bundle-<version>.tar.gz`
([docs/offline-bundle.md](docs/offline-bundle.md)), built by
`packaging/bundle/build-bundle.mjs` from the release's executables and signed
by the release workflow. The builder renders the plugin packages it carries
itself, in the offline variant (`plugins.mjs` with `--server installed`). To
build one from your tree, with the executable for your system:

```bash
cd cli && npm run build && npm run build:executable && cd ..
node packaging/bundle/build-bundle.mjs --executables cli/build --allow-missing-executables
# packaging-out/bundle/cavelon-bundle-<version>.tar.gz and .manifest.json
```

The same inputs give the same bytes; `offline-bundle.test.ts` checks that, the
manifest against `contracts/offline-bundle-manifest.schema.json`, and an
install from the extracted bundle with `install.sh`. CI's install job builds
it from the five executables and installs from its `bin/` with `install.sh`
and `install.ps1`.

## How the kit is built

- **Published contracts only.** The kit talks to an instance only through what
  the instance publishes: its OpenAPI, `/api/v1/meta/capabilities`,
  `/api/v1/meta/error-catalog`, the package schema and the docs. It never
  hard-codes an entity type or a field the published schema or OpenAPI can
  tell it, so one kit release works with many instance versions.
- **Built for agents.** Every command works without a prompt, offers `--json`,
  uses the [documented exit codes](docs/troubleshooting.md#exit-codes), bounds
  its waits and its output, and is marked read-only or changing (which also
  sets the MCP tool's annotations).
- **Older instances.** A field a recent instance added is read with a fallback
  for an instance that does not publish it. The fake server can play both, and
  a test covers both.
- **Secrets stay with people.** A token or secret value is never a
  command-line argument, never logged and never written to a repository. Only
  `login` and `secrets set` read one, from a terminal or stdin.
- **Customers' files.** The kit never overwrites a file it did not create; in a
  customer's `AGENTS.md`, `CLAUDE.md`, `.gitignore` or git hook it changes only
  the block between its markers.

## Tests

Tests run without a real instance. `cli/test/fake-server.ts` serves the
snapshots in `contracts/cavelon/` and answers the routes the commands use, and
`contract.test.ts` checks that its answers match the snapshot's OpenAPI, so the
other tests prove something.

- A command that calls a new operation adds it to
  `contracts/kit-operations.json`; `contracts/README.md` says how to refresh and
  trim the snapshot. The contract test fails when the snapshot and the list
  disagree.
- `docs/commands.md` is generated from the commands' own help:
  `npm run docs:commands` in `cli/`. A test fails while it is out of date.
- A test against a live instance is opt-in and never runs in CI.

### Checking against a live instance

Native person-approval adapter design and the distinction between simulated
protocol checks and supervised client UI evidence are recorded in
[docs/native-approval-adapters.md](docs/native-approval-adapters.md).

Before a release, run the [getting-started tutorial](docs/getting-started.md)
against a test instance with personal access tokens and the operations API on,
using a token for a test tenant. Check that each step's output matches what the
documentation shows, and that `--json` output parses. Never use a production
tenant or a token with **May activate** for this unless you mean to activate.

## Code style

- TypeScript, strict; ESLint as configured in `cli/eslint.config.js`.
- No `console` in `cli/src`: commands write through their context, so `--json`
  and MCP output stay clean.
- Regular expressions: no quantified group anchored at the end (such as
  `/(\r?\n)+$/` or `/^[-.]+|[-.]+$/`); trim with a loop instead. Build file
  paths only from validated names.
- English in code, comments, docs, commits and pull requests. Comments say why,
  not what.

## Pull requests

- Branch from `main`, one change per pull request; pull requests are squash
  merged.
- CI must pass: typecheck, lint and tests on Linux, macOS and Windows.
- A user-visible change gets a line in `CHANGELOG.md` under **Unreleased**, and
  the docs in `docs/` change with it.
- Releases follow [RELEASING.md](RELEASING.md).

### Dependency updates

Dependabot opens the dependency pull requests (`.github/dependabot.yml`): a
security update as soon as GitHub knows of a vulnerability in a dependency, and
every Monday one grouped update for the CLI's npm minor and patch versions and
one for the GitHub Actions the workflows pin by commit. A major version gets its
own pull request, unless `.github/dependabot.yml` holds it back and says why:
`@types/node` stays on the major of the oldest Node.js the CLI supports, so the
code cannot use an API that version lacks. Review them like any other: CI must
pass, and an update of an action that `release.yml` uses is checked against the
action's release notes, because that workflow holds the token that stages a
release. A security update that reaches the published package goes out with the
next release.

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
