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
  `models_set_limit`, `loop_cancel`, `sandbox_seed`, `trigger_identity` and
  `api` (for any operation that is not read-only) change nothing without
  `confirm: true`. The other changing tools act at once; the
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
- A tool reads and writes files only inside the solution folder (the folder
  of `cavelon.yaml`, or the one the server started in), following symlinks,
  and never in `cavelon`'s config or cache directory, which hold the stored
  token.

These limits apply to the MCP tools. An agent that runs shell commands has
whatever your shell allows it; your agent client's permission settings decide
that.

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
- **No telemetry.** `cavelon` sends no usage data, crash reports or update
  checks anywhere.
- **npm.** Installing or running through `npx` downloads `@cavelon/cli` and its
  dependencies from the npm registry. Releases are published from this
  repository's release workflow with npm provenance; `npm view @cavelon/cli
  dist.attestations` shows it.

## Files on your machine

| Path (Linux and macOS) | Path (Windows) | Holds |
|---|---|---|
| `~/.config/cavelon/config.json` | `%APPDATA%\cavelon\config.json` | the current instance, the tenant chosen with `use`, which store holds the token; never a token |
| `~/.config/cavelon/credentials.json` | `%APPDATA%\cavelon\credentials.json` | the token per instance (`0600`), only where there is no credential store |
| `~/.cache/cavelon/<instance>/<version>/` | `%LOCALAPPDATA%\cavelon\cache\…` | what the instance publishes: capabilities, OpenAPI, error catalog, package schema, docs index |

`CAVELON_CONFIG_DIR` and `CAVELON_CACHE_DIR` move them; `XDG_CONFIG_HOME` and
`XDG_CACHE_HOME` are honoured.
A development build of the instance keeps one version while what it publishes
changes, so `cavelon` reads its copies again after a minute
(`CAVELON_CONTRACT_TTL_SECONDS`), or checks them with the ETag the instance sent.

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
