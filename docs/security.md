# Security

The kit runs on your machine, with your own credential, against the Cavelon
instance you name. This page says where the credential lives, what your coding
agent can and cannot see, and what is sent where.

## Your token

**Creating it.** A personal access token is created by a person on
`/account/access-tokens` in Cavelon. It acts as that person, never with more
rights than they have, and you choose its ceiling when you create it: whether it
may activate solutions, whether it may work in Platform mode, and when it
expires. Give each machine or purpose its own token, so you can revoke one
without the others.

**Choosing its ceiling.** Pick the lowest one that does the job, as the
instance's token dialog recommends:

| Task | Ceiling |
|---|---|
| read-only checks: `status`, `limits`, `trace`, reading docs and results | **Observer** |
| building and testing a solution: `validate`, `apply`, `test run` | **Builder** |
| changing the tenant's limits or settings (`limits set`) | **Tenant Owner** |
| operating the platform itself | **Platform mode**, for platform operators only |

Keep **May activate** off unless the token should put solutions live; without
it, `cavelon activate` is refused and a person activates in the Admin. The
instance's page on personal access tokens explains each ceiling:
`/docs/administration/personal-access-tokens` on your instance, or
`cavelon docs get administration/personal-access-tokens`.

**Storing it.** `cavelon login` reads the token without echoing it, from your
terminal or from standard input (`--token-stdin`), and keeps it in your
operating system's credential store:

| System | Store |
|---|---|
| macOS | Keychain |
| Windows | Windows Credential Manager |
| Linux | Secret Service (GNOME Keyring, KWallet) |

Where there is no credential store (a server, a container), the token goes into
`credentials.json` in the configuration folder, readable only by you (`0600`),
and `login` says so. `CAVELON_CREDENTIAL_STORE=file` chooses the file on
purpose.

**Never an argument.** No command takes a token or a secret value as a
command-line argument, so neither lands in your shell history or in the
process list. The configuration file and `cavelon.yaml` never hold a token;
`cavelon` refuses to run with a `cavelon.yaml` that looks like it contains one
(`project_file_has_secret`).

**CI and scripts.** Set `CAVELON_URL` and `CAVELON_TOKEN` from your CI
system's secret store. `CAVELON_TOKEN` is used only together with
`CAVELON_URL` and only for that instance: a `--instance` option or a
`cavelon.yaml` from a cloned repository that names another instance never
receives it. Prefer a tenant API key (`cbp_…`) with the narrowest scope for
automation that does not import packages.

**Revoking it.** `cavelon logout` deletes the stored token from your machine
(`--all` for every instance). The token stays valid in Cavelon until you revoke
it on `/account/access-tokens`; do that when a machine is lost or a token may
have leaked.

## What your coding agent sees

The agent calls `cavelon`, as a shell command or through the
[MCP server](mcp.md), and `cavelon` sends the token. The agent never sees,
passes or stores it, and there is no tool that returns it. A person runs
`cavelon login`.

The agent does see what the commands return, which is what your token may read
in the tenant:

- the solution's configuration: agents, prompts, skills, tools, knowledge base
  names, triggers and test suites;
- tenant variables (`{{var:…}}`), which are plain text by design;
- test results and traces, which contain the conversations of test runs, and
  of real conversations when you ask for one by its id;
- Sandbox files and logs you ask it to read;
- the instance's limits, docs and error catalog.

It does **not** see:

- **secret values** (`{{secret:…}}`): `secrets list` shows only names and
  whether each is set; a value is set by a person with `cavelon secrets set`
  in their own terminal, and is never printed, written to a file or read back;
- the **keys of model endpoints**: `models list` shows the endpoint and the
  key's kind, never the key;
- **API keys** a trigger runs as: they are named by name or id, never by value.

Treat the agent's context like any tool that reads your tenant: an agent
provider may process what the agent reads, under your agreement with it.

**What the agent may do** is limited by the token. Use a token without **May
activate** for day-to-day work, so the agent can build and test but a person
activates. Over MCP, `cavelon` limits it further:

- `apply` imports only with the id of a preview, and `limits_set`,
  `models_set_limit`, `loop_cancel`, `sandbox_seed`, `trigger_identity`,
  `harness_default`, `activate` with `make_default`, `kb_upload` where it
  would deactivate documents, and `api` (for any operation that is not
  read-only) change nothing without the `confirm_token` their preview
  returned. The token is a hash of the change the preview showed, the tool,
  the tenant and the instance, so the agent cannot skip the preview or
  confirm another change than the one it showed; `confirm: true` is refused.
  The other changing tools act at once; the
  [MCP page](mcp.md#how-agents-use-it) lists which they are. The Cavelon
  skills tell the agent to show you any preview that reaches an active
  solution or production first.
- `api` refuses, even with `confirm`, an operation the instance keeps for a
  person: one its OpenAPI marks with `x-cavelon-person-only` (setting or
  deleting a secret value, issuing, resetting or revoking a credential,
  deciding an approval), with the instance's reason in the error. On an
  instance that marks no operation, `api` refuses by the words of the path an
  operation that changes a secret, creates or revokes a credential (personal
  access tokens, API keys, sign-in) or decides an approval.
- `api` refuses, even with `confirm`, a body that sets a field the instance
  marks as holding a secret value (`"x-cavelon-secret": true`, published with
  `"writeOnly": true`: provider keys, passwords, one-time codes), at any depth
  of the body, in nested objects and arrays too (`secret_field_for_a_person`).
  The error names the field, never its value, and points to
  `cavelon secrets set` or the Admin; the agent can send the rest without the
  field. A field set to `null`, which clears it, passes. On an instance whose
  OpenAPI marks no field, bodies are checked as before. A secret typed into a
  free-form map, such as a headers or settings object, carries no marker and
  cannot be detected.
- A tool reads and writes files only inside the solution folder (the folder
  of `cavelon.yaml`, or the one the server started in), following symlinks,
  and never in `cavelon`'s config or cache directory, which hold the stored
  token.

### When the agent runs `cavelon` in its shell

An agent with a shell can run `cavelon api` itself instead of calling the MCP
tool. When `cavelon` runs under a coding agent, `cavelon api` applies the same
guards as the `api` tool:

- an operation kept for a person, and a body with a field marked
  `x-cavelon-secret`, are refused, with or without `--confirm`, with exit
  code 5 ("needs a person"); the error says how a person runs it
  (`operation_for_a_person`, `secret_field_for_a_person`).
  `cavelon api describe` shows both marks before anything is tried;
- an operation that is not read-only prints the request it would send
  (method, path, query, headers, body, files) and a confirm token, and sends
  nothing (`sent: false`). Run again with `--confirm <token>`, it sends exactly
  that request. The token is a hash of the request, the instance and the
  tenant, so a changed body, parameter or file needs a new preview; a token
  that does not match sends nothing and exits 4, and `--confirm` without a
  token sends nothing and exits 5;
- the body `@file`, `--file` attachments and `--output` stay inside the
  solution folder, never in `cavelon`'s config or cache directory
  (`path_outside_solution`, `path_in_kit_directory`).

`cavelon` runs under a coding agent when one of these variables, which the
agents set for the commands their shell tool runs, is set (and is not empty,
`0` or `false`):

| Variable | Set by |
|---|---|
| `CLAUDECODE` | Claude Code |
| `CODEX_THREAD_ID`, `CODEX_SANDBOX` | Codex (`CODEX_SANDBOX` only inside its macOS sandbox) |
| `CURSOR_AGENT` | Cursor's agent terminal and `cursor-agent` |
| `GEMINI_CLI` | Gemini CLI's shell tool |
| `COPILOT_CLI` | GitHub Copilot CLI |
| `COPILOT_AGENT` | GitHub Copilot's agent terminals in VS Code |
| `AI_AGENT` | the shared variable newer agents set |
| `CAVELON_AGENT=1` | you, for an agent that sets none of the above |

Kiro documents no such variable: set `CAVELON_AGENT=1` in the environment
its commands run in, if you can. The Claude Code extensions for VS Code and
JetBrains set `CLAUDECODE` in their integrated terminals too, so `cavelon api`
typed there is guarded; run it in another terminal. A person in a plain
terminal is unaffected: `cavelon api` sends at once, takes any path and sends
any field.

The commands with a `--confirm` flag are held to the same as their MCP tools:
`limits set`, `models set-limit`, `loop cancel`, `sandbox seed`,
`trigger identity`, `harness default`, `activate --make-default`,
`deactivate`, `kb upload --replace`, `variables delete` and `secrets delete`.
Run under a coding agent, each prints its preview with a confirm token and
the command that confirms exactly that change (`--confirm <token>`, the same token the MCP
tool returns). A bare `--confirm` changes nothing: it shows the preview and
exits 5, and `activate --make-default --confirm` refuses before it activates.
A token of another change exits 4. In your own terminal the plain flag
confirms, as before; a token given there is checked too.

These guards keep an agent from doing by mistake what is meant for a person;
they are not a boundary. An agent that unsets the variable, or calls the API
some other way, has whatever your shell and the token allow it. Your agent
client's permission settings decide what it may run, and the instance enforces
the token's role and ceiling on every request.

## What is sent where

- **To your instance only.** Every request goes to the instance URL you
  named, with the token in the `Authorization` header and the tenant in
  `X-Tenant-Id`. A request to any other host is refused (`foreign_url`),
  including one to a path the instance itself supplies. Plain
  `http://` is refused except for `localhost`, unless you set
  `CAVELON_ALLOW_HTTP=1` for a test instance on a private network.
- **What it sends:** the package files you `apply`, the documents you
  `kb upload`, the files you `sandbox seed`, and the values you set with
  `variables set` and `secrets set`. Nothing is uploaded that a command does not
  name.
- **No telemetry.** `cavelon` sends no usage data or crash reports anywhere.
- **Update check.** At most once a day, `cavelon` in a terminal asks for the
  number of the latest release: the GitHub release API (`api.github.com`) for
  the standalone executable, the npm registry for an npm install. The request
  is an anonymous GET with no token, no instance and nothing about you or your
  solutions; never with `--json`, in MCP mode, in CI or through `npx`.
  `CAVELON_NO_UPDATE_CHECK=1` turns it off; see
  [Updating](installation.md#updating).
- **npm.** Installing or running through `npx` downloads `@cavelon/cli` and its
  dependencies from the npm registry. Releases are published from this
  repository's release workflow with npm provenance; `npm view @cavelon/cli
  dist.attestations` shows it.
- **GitHub releases.** The one-line install downloads the install script, the
  executable for your system and `checksums.txt` from this repository's
  GitHub release, and installs nothing whose SHA-256 checksum does not match.
  The release workflow builds each executable from the tagged commit and
  attests it; `gh attestation verify <file> --repo goodguys-gmbh/cavelon-dev-kit`
  checks that. The install scripts send nothing else anywhere.
- **The standalone executable** carries the same code as the npm package, with
  the Bun runtime it runs on. Like the npm package, it reads no `.env` or
  `bunfig.toml` from the folder it runs in, so a repository cannot change its
  settings or point it at another instance that way.

## Files on your machine

| Path (Linux and macOS) | Path (Windows) | Holds |
|---|---|---|
| `~/.config/cavelon/config.json` | `%APPDATA%\cavelon\config.json` | the current instance, the tenant chosen with `use`, which store holds the token; never a token |
| `~/.config/cavelon/credentials.json` | `%APPDATA%\cavelon\credentials.json` | the token per instance (`0600`), only where there is no credential store |
| `~/.config/cavelon/setup.json` | `%APPDATA%\cavelon\setup.json` | what `cavelon setup` changed in your coding agents' settings, so `setup --remove` undoes exactly that; never a token |
| `~/.cache/cavelon/<instance>/<version>/` | `%LOCALAPPDATA%\cavelon\cache\…` | what the instance publishes: capabilities, OpenAPI, error catalog, package schema, docs index |
| `~/.cache/cavelon/update-check.json` | `%LOCALAPPDATA%\cavelon\cache\update-check.json` | when the latest release was last looked up, its number, and when `cavelon` last said so |

`CAVELON_CONFIG_DIR` and `CAVELON_CACHE_DIR` move them; `XDG_CONFIG_HOME` and
`XDG_CACHE_HOME` are honoured.
A development build of the instance keeps one version while what it publishes
changes, so `cavelon` reads its copies again after a minute
(`CAVELON_CONTRACT_TTL_SECONDS`), or checks them with the ETag the instance sent.

Outside the cavelon folders, only `cavelon setup` writes, and only into your
coding agents' user settings, as [Installation](installation.md#set-up-your-coding-agents)
lists; it runs Claude Code's and Codex's own plugin commands, and never puts a
token into any of those files.

In a solution folder, only `init`, `pull` and `apply` write files, plus
`artifacts export`, which writes the archive it downloads to a new file.
`.cavelon/` holds the inventory and the stored previews (the exact import
request, which never contains a secret value); it is ignored by git. `init`
never overwrites a file it did not create, and changes only the block between
its markers in your `AGENTS.md`, `CLAUDE.md`, `.gitignore` or git hook. It
leaves a hooks folder outside the repository alone, such as one a global
`core.hooksPath` names, since every repository of yours runs it. `validate`,
`apply` and `pull` follow a symlinked package file only inside the solution
folder.

## Reporting a vulnerability

Report it privately, as [SECURITY.md](../SECURITY.md) describes, never in a
public issue.
