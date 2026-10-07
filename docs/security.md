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
it, `cavelon activate` is refused and a person activates in the Admin.
`cavelon whoami` lists what the token may do in the tenant (its permissions,
an API key's scopes, and the operations a person runs instead), and the MCP
server marks the tools it may not use, so your agent does not learn it from
refusals. The
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
  in their own terminal, or in the Admin where the instance lets no token set
  one, and is never printed, written to a file or read back;
- the **keys of model endpoints**: `models list` shows the endpoint and the
  key's kind, never the key;
- **API keys** a trigger runs as: they are named by name or id, never by value.

Treat the agent's context like any tool that reads your tenant: an agent
provider may process what the agent reads, under your agreement with it.

**What the agent may do** is limited by the token. Use a token without **May
activate** for day-to-day work, so the agent can build and test but a person
activates. Over MCP, `cavelon` limits it further:

- `apply` imports only with the id of a preview, and `tenant_create`,
  `variables_set` where it replaces another value, `loop_start`,
  `limits_set`, `models_set_limit`, `loop_cancel`, `sandbox_seed`,
  `trigger_identity`, `harness_default`, `activate` of a solution a channel
  or an active trigger reaches or with `make_default`, `deactivate`,
  `kb_upload` where it would deactivate documents, and `api` (for any
  operation that is not read-only) change nothing without the
  `confirm_token` their preview returned. The token is a hash of the change the preview showed, the tool,
  the tenant and the instance, so the agent cannot skip the preview or
  confirm another change than the one it showed; `confirm: true` is refused.
  The other changing tools act at once; the
  [table below](#every-changing-command-and-its-guard) lists every changing
  command and its guard. The Cavelon
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
`0` or `false`; `TERM_PROGRAM` only with the value shown):

| Variable | Set by |
|---|---|
| `CLAUDECODE` | Claude Code |
| `CODEX_THREAD_ID`, `CODEX_CI`, `CODEX_SANDBOX` | Codex (`CODEX_SANDBOX` only inside its macOS sandbox) |
| `CURSOR_AGENT` | Cursor's agent terminal and `cursor-agent` |
| `GEMINI_CLI` | Gemini CLI's shell tool and its `!` commands |
| `COPILOT_CLI` | GitHub Copilot CLI |
| `COPILOT_AGENT` | GitHub Copilot's agent terminals in VS Code |
| `AGENT_CONTEXT_OUT` | Kiro CLI, while its agent runs the command |
| `TERM_PROGRAM=kiro` | the Kiro IDE, in every terminal it opens |
| `OPENCODE` | OpenCode, in every command it starts |
| `GROK_AGENT` | Grok Build |
| `AI_AGENT` | the shared variable newer agents set |
| `CAVELON_AGENT=1` | you, for an agent that sets none of the above |

So every agent `cavelon setup` sets up is recognised by what it sets itself;
`setup` has nothing to add to your shell. The Kiro IDE marks no terminal as
its agent's, so `cavelon` takes every terminal of the Kiro IDE for one, as it
does the integrated terminals of VS Code and JetBrains with the Claude Code
extension (they set `CLAUDECODE`) and OpenCode's own terminals: what is meant
for a person, such as `secrets set`, you run there in another terminal. A
command you type with `!` in Claude Code, Codex or Gemini CLI runs in the
agent's environment too. The variables are what the agents' current versions
set; for an agent not listed here, set `CAVELON_AGENT=1` in the environment
its commands run in. The MCP server needs none of them: everything that
reaches `cavelon` over MCP is guarded. A person in a plain terminal is
unaffected: `cavelon api` sends at once, takes any path and sends
any field.

The commands with a `--confirm` flag are held to the same as their MCP tools:
`tenant create`, `variables set` (replacing a value), `loop start`,
`limits set`, `models set-limit`, `loop cancel`, `sandbox seed`,
`trigger identity`, `harness default`, `activate` (of a solution a channel
or trigger reaches, or with `--make-default`), `deactivate`,
`kb upload --replace` and `variables delete`.
Run under a coding agent, each prints its preview with a confirm token and
the command that confirms exactly that change (`--confirm <token>`, the same token the MCP
tool returns). A bare `--confirm` changes nothing: it shows the preview and
exits 5, and `activate --confirm` refuses before it activates.
A confirm line printed before its preview exists (`activate`'s default route,
the stop command of a running loop, a hint) names the token it needs:
`--confirm <confirm_token of its preview>`.
A token of another change exits 4. In your own terminal the plain flag
confirms, as before; a token given there is checked too.

`secrets set` and `secrets delete` are refused under a coding agent, with or
without `--confirm`, before a value is read or anything is sent
(`operation_for_a_person`, exit 5), as `cavelon api` refuses the same
operations. You run them in your own terminal. Where the instance lets only a
person signed in to the Admin set or delete a secret (its `/meta/principal`
lists them in `needs_a_person`), they are refused for every token before a
value is read (`secret_needs_a_person`, exit 5), and you set it in the Admin
under Settings › Secrets.

A refusal says who runs the command instead, never which variable made
`cavelon` take the shell for an agent's.

These guards keep an agent from doing by mistake what is meant for a person;
they are not a boundary. An agent that unsets the variable, or calls the API
some other way, has whatever your shell and the token allow it. Your agent
client's permission settings decide what it may run, and the instance enforces
the token's role and ceiling on every request.

### Every changing command and its guard

Every command that changes something, on the instance or on your machine, and
what holds it back. **Preview** means: without `--confirm` the command shows
what it would do and changes nothing; with `--confirm` it does it. Under a
coding agent and over MCP, only the `confirm_token` of that very preview
confirms (see above). The rule of the Cavelon skills stays: an agent confirms
on its own only for a draft solution in a test environment, and shows you
every other preview first.

| Command | MCP tool | What it changes | Guard |
|---|---|---|---|
| `tenant create` | `tenant_create` | adds a tenant to the platform (Platform mode) | preview, always |
| `variables set` | `variables_set` | a tenant-wide `{{var:…}}` value every solution reads | preview when it replaces another value; a new variable is created at once |
| `variables delete` | none | removes a tenant variable | preview, always |
| `secrets set` | none | a secret's value | a person only: refused under a coding agent, and for every token where the instance lets only the Admin set it; the value is read from a terminal or stdin |
| `secrets delete` | none | removes a secret's value | a person only, and a preview |
| `loop start` | `loop_start` | starts a run that acts as you and spends budget | preview, always (an agent may confirm a trigger of a draft solution in a test environment) |
| `loop cancel` | `loop_cancel` | stops a run and its loops | preview, always |
| `loop pause`, `loop resume` | `loop_pause`, `loop_resume` | asks a loop to pause at its next safe point, or resumes a paused one | at once |
| `trigger identity` | `trigger_identity` | the API key a trigger's runs act as | preview, always |
| `activate` | `activate` | puts a solution live, through the readiness gate | preview when a channel or an active trigger reaches it, or the instance does not say; with `--make-default`, also the default route. A draft nothing reaches activates at once |
| `deactivate` | `deactivate` | takes a solution out of live traffic | preview, always; the default route is refused |
| `harness default` | `harness_default` | which solution the tenant's chat and widget answer with | preview, always |
| `harness new`, `harness clone` | `harness_new`, `harness_clone` | a new draft solution | at once (a draft answers no live traffic) |
| `apply` | `apply` | imports the package into a solution | preview, always; confirmed with the preview's id |
| `kb upload` | `kb_upload` | adds documents to a knowledge base | at once; with `--replace` on an instance that cannot replace a document itself, a preview of what it would deactivate |
| `test run` | `test_run` | runs test suites, which spends budget | at once |
| `chat` | `chat` | one turn of a conversation, which spends budget | at once |
| `limits set` | `limits_set` | a limit of the tenant or the platform | preview, always |
| `models set-limit` | `models_set_limit` | a model endpoint's concurrency limit | preview, always |
| `db test`, `db test-run` | `db_test`, `db_test_run` | a tenant Owner's connection test (stored as the connection's last test), or one run of a saved query with the values given (the rows come back once; the instance keeps counts only) | at once; read-only on the database, and the instance refuses anyone but the tenant Owner |
| `sandbox seed` | `sandbox_seed` | replaces a Sandbox's workspace | preview, always |
| `sandbox validate`, `sandbox refresh` | `sandbox_validate`, `sandbox_refresh` | runs a Sandbox's readiness checks, or accepts a customer VM's workspace as it is now | at once |
| `artifacts export` | `artifacts_export` | takes files out of an isolated container as a tar archive | at once; never writes over an existing file |
| `api` | `api` | any operation of the instance | preview for every operation that is not read-only under a coding agent and over MCP; operations kept for a person are refused |
| `use` | `use_tenant` | the tenant your commands act in (over MCP: for the session only) | at once, on your machine |
| `init`, `pull`, `fmt` | `init`, `pull`, `fmt` | files in the solution folder; `init` may create a draft solution from a shell | at once; `pull` refuses to replace a file that changed and is not committed, unless `--force` |
| `login`, `logout` | none | the stored token | a person only: the token is read from a terminal or stdin |
| `setup` | none | sets up your coding agents for Cavelon and logs in | on your machine, guided; changes only the blocks between its markers in a file it did not create |
| `mcp` | none | starts the MCP server | nothing by itself |

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
  solutions; never with `--json`, in CI or through `npx`. The MCP server
  (`cavelon mcp`) asks the same, once a day as a session starts, and through
  `npx` only to compare the Cavelon plugin's version (from the GitHub release);
  it also reads the version line of the skill files `cavelon init --agents`
  wrote in the solution folder, and in Claude Code the version in the
  plugin's own manifest (`CLAUDE_PLUGIN_ROOT`). `CAVELON_NO_UPDATE_CHECK=1` turns both off;
  see [Updating](installation.md#updating).
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
| `~/.cache/cavelon/<instance>/<version>/` | `%LOCALAPPDATA%\cavelon\cache\…` | what the instance publishes: OpenAPI, error catalog and package schema; the capabilities once per tenant, as they carry its limits (`capabilities.<hash>.json`, named by a SHA-256 prefix of the tenant); and the docs index once per token and tenant (`llms.<hash>.txt`, named by a SHA-256 prefix of the two, never the token). Files `0600`, folders `0700` |
| `~/.cache/cavelon/update-check.json` | `%LOCALAPPDATA%\cavelon\cache\update-check.json` | when the latest release was last looked up, its number, and when `cavelon` last said so |

`CAVELON_CONFIG_DIR` and `CAVELON_CACHE_DIR` move them; `XDG_CONFIG_HOME` and
`XDG_CACHE_HOME` are honoured.
The cache names the instance and its tenants and holds their limits, so only
you may read it: every file `cavelon` writes there is `0600`, in folders that
are `0700` from the cache folder down. A folder an earlier version left
readable to others is narrowed the next time `cavelon` writes into it.
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
