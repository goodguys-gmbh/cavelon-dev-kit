# MCP server

`cavelon mcp` serves the kit's commands as tools over the
[Model Context Protocol](https://modelcontextprotocol.io/), on standard input
and output. A coding agent that speaks MCP calls them as tools instead of
running shell commands. The tools run the same code as the commands, with the
same checks, against the instance and tenant you logged in to.

## Setting it up

**With the Cavelon plugin** for Claude Code or Codex, there is nothing to do:
the plugin starts the server. See [Installation](installation.md#install-the-plugin).

**With `cavelon init --agents <list>`**, the entry is written into the
solution folder for Cursor, GitHub Copilot in VS Code, Gemini CLI, Kiro and
Claude Code. See [Agents without a plugin](installation.md#agents-without-a-plugin).

**By hand**, add this server to your agent's MCP configuration:

```json
{
  "mcpServers": {
    "cavelon": { "command": "npx", "args": ["-y", "@cavelon/cli@0.1", "mcp"] }
  }
}
```

With `cavelon` installed globally, `{ "command": "cavelon", "args": ["mcp"] }`
works as well. In Claude Code: `claude mcp add cavelon -- npx -y @cavelon/cli@0.1 mcp`.

The entry pins the kit's minor version (`@0.1`): while the kit is in 0.x, a new
minor version may change behaviour, and it reaches your agent only when you
update the plugin or run `cavelon init --update`.

## Before the agent starts

The server acts with the token stored by `cavelon login`, so a person logs in
once per instance, in a terminal:

```bash
cavelon login --instance https://cavelon.example.com
```

The agent never sees or passes the token, and there is no login tool. Without
a login, tools answer `not_logged_in` and tell the agent to ask you.
Repository tools (`init`, `pull`, `validate`, `apply`, `explain`, `activate`,
`sandbox_seed`, `artifacts_export`) work in the folder the agent started the
server in, and use its `cavelon.yaml`.

## Tools

Each tool carries the MCP annotations `readOnlyHint` and `destructiveHint`, so
your agent can ask you before it calls a tool that changes or deletes
something. Most tools take an optional `tenant` argument as well.

| Tool | Command | Marked |
|---|---|---|
| `whoami` | `cavelon whoami` | read-only |
| `use_tenant` | `cavelon use` | changing |
| `status` | `cavelon status` | read-only |
| `limits` | `cavelon limits` | read-only |
| `limits_set` | `cavelon limits set` | destructive |
| `models_list` | `cavelon models list` | read-only |
| `models_set_limit` | `cavelon models set-limit` | destructive |
| `tenant_create` | `cavelon tenant create` | changing |
| `tenant_list` | `cavelon tenant list` | read-only |
| `harness_list` | `cavelon harness list` | read-only |
| `harness_new` | `cavelon harness new` | changing |
| `harness_clone` | `cavelon harness clone` | changing |
| `activate` | `cavelon activate` | changing |
| `init` | `cavelon init` | destructive |
| `pull` | `cavelon pull` | destructive |
| `validate` | `cavelon validate` | read-only |
| `apply` | `cavelon apply` | destructive |
| `explain` | `cavelon explain` | read-only |
| `variables_list` | `cavelon variables list` | read-only |
| `variables_get` | `cavelon variables get` | read-only |
| `variables_set` | `cavelon variables set` | changing |
| `secrets_list` | `cavelon secrets list` | read-only |
| `api_list` | `cavelon api list` | read-only |
| `api_describe` | `cavelon api describe` | read-only |
| `api` | `cavelon api` | destructive |
| `docs_search` | `cavelon docs search` | read-only |
| `docs_get` | `cavelon docs get` | read-only |
| `operation_status` | `cavelon wait` | read-only |
| `kb_upload` | `cavelon kb upload` | changing |
| `test_run` | `cavelon test run` | changing |
| `trace` | `cavelon trace` | read-only |
| `loop_start` | `cavelon loop start` | changing |
| `loop_cancel` | `cavelon loop cancel` | destructive |
| `loop_iterations` | `cavelon loop iterations` | read-only |
| `loop_pause` | `cavelon loop pause` | changing |
| `loop_resume` | `cavelon loop resume` | changing |
| `trigger_identity` | `cavelon trigger identity` | destructive |
| `sandbox_list` | `cavelon sandbox list` | read-only |
| `sandbox_validate` | `cavelon sandbox validate` | changing |
| `sandbox_files` | `cavelon sandbox files` | read-only |
| `sandbox_cat` | `cavelon sandbox cat` | read-only |
| `sandbox_activity` | `cavelon sandbox activity` | read-only |
| `sandbox_logs` | `cavelon sandbox logs` | read-only |
| `sandbox_receipt` | `cavelon sandbox receipt` | read-only |
| `sandbox_seed` | `cavelon sandbox seed` | destructive |
| `sandbox_refresh` | `cavelon sandbox refresh` | changing |
| `artifacts_export` | `cavelon artifacts export` | changing |

Each tool's arguments are the command's arguments and options, as listed in the
[command reference](commands.md); options marked "CLI only" there, such as
`--wait`, are not offered to the agent.

### What is not a tool

- **`login` and `logout`**: a person runs them.
- **`secrets set` and `secrets delete`**: a secret's value comes from a person.
  `secrets_list` shows which secrets are set (never a value), and the agent
  tells you the exact `cavelon secrets set <name>` command to run in your
  terminal.
- **`variables delete`**: run it yourself.
- **`watch` and `loop watch`**: they stream until the work ends, and a tool
  must not block. The agent polls `operation_status` and `loop_iterations`
  instead.
- **`commands` and `mcp`** themselves.

## How agents use it

The server tells the agent these rules when it connects, and the Cavelon skills
repeat them:

- **Nothing blocks.** Tools that start work (`kb_upload`, `test_run`,
  `loop_start`, `sandbox_seed`, `artifacts_export`) return operation ids at
  once; the agent reads them with `operation_status` and follows a loop with
  `loop_iterations`.
- **What needs `confirm`.** `apply` returns a preview and imports only with
  `confirm` set to that preview's id. `limits_set`, `models_set_limit`,
  `loop_cancel`, `sandbox_seed`, `trigger_identity`, and `api` for any
  operation that is not read-only (anything but GET, HEAD and OPTIONS), return
  what they would do (for `api`: the method, path, parameters and body) and
  act only with `confirm: true`. The agent shows that to you first, and must
  show you any preview that reaches an active solution or production.
- **What changes without `confirm`.** `init` and `pull` write files in the
  solution folder (`pull` refuses to replace package files with uncommitted
  changes, or outside git files changed since the last pull, unless `force`), and the other tools marked changing act at once:
  `use_tenant`, `tenant_create`, `harness_new`, `harness_clone`, `activate`
  (through the readiness gate), `variables_set`, `kb_upload`, `test_run`,
  `loop_start`, `loop_pause`, `loop_resume`, `sandbox_validate`,
  `sandbox_refresh` and `artifacts_export`.
- **What no tool does, even with `confirm`.** `api` refuses an operation that
  changes a secret, creates or revokes a credential (personal access tokens,
  API keys, sign-in) or decides an approval (`operation_for_a_person`); a
  person does those in Cavelon or in their terminal.
- **Files stay in the solution folder.** Every path a tool takes (`api`'s
  `file` and `body` `@file`, `loop_start`'s `input` `@file`, `kb_upload`'s
  folder, `sandbox_seed`'s source, `artifacts_export`'s `out`, `init`'s
  `from`) must lead, after symlinks, into the folder of `cavelon.yaml`, or the
  folder the server started in when there is none (`path_outside_solution`),
  and never into cavelon's own config or cache directory, which hold the
  stored token (`path_in_kit_directory`). In your terminal, `cavelon` takes
  any path you name.
- **Limits are read, not changed.** The agent reads `limits` before planning a
  solution. It never changes a limit on its own: it proposes the old and new
  value and lets you decide; an operator's limit goes to the operator.
- **Secrets stay with people**, as above. The agent never asks for, reads or
  passes a secret value, and never decides an approval.
- **Docs before guessing.** `docs_search` and `docs_get` read the instance's
  own documentation; `api_list`, `api_describe` and `api` reach any operation
  without its own tool.

[Building a solution with a coding agent](coding-agents.md) shows what these
rules mean while you work with the agent.

## Results and errors

A tool returns the command's `--json` document, plus `warnings` when there are
any and `exit_code` when the command would have exited non-zero without
failing (a test run with failed cases, for example). `warnings` is always a
list: of messages, or for `validate` of `{code, message}` objects, as the
[command reference](commands.md) says. A failed call is an MCP
error whose text is `{"error": {"code", "message", "hint", "exit_code", …}}`,
the same shape as the CLI's `--json` errors; the codes are explained in
[Troubleshooting](troubleshooting.md).
