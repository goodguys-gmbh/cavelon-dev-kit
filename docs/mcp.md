# MCP server

`cavelon mcp` serves the kit's commands as tools over the
[Model Context Protocol](https://modelcontextprotocol.io/), on standard input
and output. A coding agent that speaks MCP calls them as tools instead of
running shell commands. The tools run the same code as the commands, with the
same checks, against the instance and tenant you logged in to.

## Setting it up

**With `cavelon setup`**, there is nothing to do: it installs the Cavelon
plugin for Claude Code and Codex, which starts the server, and adds the server
to the user settings of Cursor, VS Code with GitHub Copilot, Gemini CLI and
Kiro. `cavelon setup --check` starts it once to show that it works. See
[Set up your coding agents](installation.md#set-up-your-coding-agents).

**With the Cavelon plugin** installed by hand for Claude Code or Codex, the
plugin starts the server. See [Installation](installation.md#install-the-plugin).

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

With `cavelon` installed (the one-line install, Homebrew or `npm i -g`),
`{ "command": "cavelon", "args": ["mcp"] }` works as well, without Node.js, and
`cavelon init --update` keeps an entry changed to it. In Claude Code:
`claude mcp add cavelon -- cavelon mcp`, or
`claude mcp add cavelon -- npx -y @cavelon/cli@0.1 mcp`. The plugin's entry
starts the installed `cavelon` when there is one, and `npx` otherwise.

The entry pins the kit's minor version (`@0.1`): while the kit is in 0.x, a new
minor version may change behaviour, and it reaches your agent only when you
update the plugin or run `cavelon init --update`. The server's first result of
a session says when either is due ([Results and errors](#results-and-errors)).

## Before the agent starts

The server acts with the token stored by `cavelon login`, so a person logs in
once per instance, in a terminal:

```bash
cavelon login --instance https://cavelon.example.com
```

The agent never sees or passes the token, and there is no login tool. Without
a login, tools answer `not_logged_in` and tell the agent to ask you.
Repository tools (`init`, `pull`, `validate`, `package_schema`, `apply`, `explain`, `activate`,
`sandbox_seed`, `artifacts_export`) work in the folder the agent started the
server in, and use its `cavelon.yaml`.

## Tools

Each tool carries the MCP annotations `readOnlyHint` and `destructiveHint`, so
your agent can ask you before it calls a tool that changes or deletes
something. Most tools take an optional `tenant` argument as well. `init` and
`pull` are marked destructive because they may overwrite files in the solution
folder; their descriptions say that they change nothing on the instance (`pull`
only reads it).

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
| `harness_default` | `cavelon harness default` | changing |
| `activate` | `cavelon activate` | changing |
| `deactivate` | `cavelon deactivate` | destructive |
| `chat` | `cavelon chat` | changing |
| `init` | `cavelon init` | destructive (local files only) |
| `pull` | `cavelon pull` | destructive (local files only) |
| `validate` | `cavelon validate` | read-only |
| `fmt` | `cavelon fmt` | changing (local files only) |
| `package_schema` | `cavelon schema` | read-only |
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
[command reference](commands.md), spelled in snake_case: `--make-default` is
`make_default`, `--keep-both` is `keep_both`, `--dry-run` is `dry_run`.
Options marked "CLI only" there, such as `--wait`, are not offered to the
agent. A call with an argument the tool's schema does not list is refused
(`unknown_argument`, exit code 2) and nothing is done; the error names the
closest argument. The CLI's spelling of a multi-word option (`make-default`)
is refused the same way, naming its snake_case form (`make_default`). An
option's former name is still taken for a release, with a warning: `apply`'s
and `pull`'s `tenant_wide` (0.1.7) is now `include_tenant_wide`, the
instance's name for it.

### Next steps over MCP

What a tool returns for the agent to do next (a hint, `next`, `resume`, a
preview's `confirm` or `default_route`) names the tool call, never a
`cavelon` command line: the tool's name and its arguments as JSON, with the
`tenant` and `env` the call was given. `operation_status` resumes with
`operation_status {"operation":["op_…"]}`, and `activate` names the default
route's change as

```text
harness_default {"solution":"support","tenant":"acme"}
harness_default {"solution":"support","confirm":"<confirm_token of its preview>","tenant":"acme"}
```

A value in angle brackets is the agent's to fill: a `confirm_token` comes from
calling that tool without `confirm` first. A command only a person runs
(`secrets set`, `login`) stays a command line for their terminal. The tools'
descriptions spell their arguments the same way (`make_default`, not
`--make-default`), and `init` as a tool names the `harness_new` call (with the
solution's slug and name) and then `pull` for a solution that is not on the
instance yet, since it creates none.

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

- **Nothing blocks for long.** Tools that start work (`kb_upload`, `test_run`,
  `loop_start`, `sandbox_seed`, `artifacts_export`) return operation ids at
  once; the agent reads them with `operation_status` and follows a loop with
  `loop_iterations`. `operation_status` returns the state at once, or, given a
  `timeout`, waits until the operations settle or the timeout passes, at most
  50 seconds (a longer timeout is cut there, with a warning). Its answer says
  `waited_ms`, and `timed_out` is true only when it waited the whole timeout.
- **What needs `confirm`.** `apply` returns a preview and imports only with
  `confirm` set to that preview's id. `limits_set`, `models_set_limit`,
  `loop_cancel`, `sandbox_seed`, `trigger_identity`, `harness_default`,
  `activate` with `make_default`, `deactivate`, and `api` for any operation that is not
  read-only (anything but GET, HEAD and OPTIONS), return what they would do
  (for `api`: the method, path, parameters and body) and a `confirm_token`,
  and act only when called again with the same arguments and `confirm` set to
  that token. The token is a hash of the change the preview showed, the tool,
  the tenant and the instance: a different change (another body, value or
  target) needs a new preview, a token of another change returns the new
  preview with `token_mismatch` and exit code 4, and `confirm: true` is
  refused (`confirm_token_required`). `kb_upload` with `replace` needs it only
  on an instance whose upload cannot replace a document itself: there it
  returns the documents it would deactivate after the upload, and uploads
  nothing without its token. The agent shows that to you first, and must show you any
  preview that reaches an active solution or production. Making a solution
  the tenant's default route changes which solution the tenant's chat and
  widget answer with, and deactivating one takes it out of live traffic, so
  the agent asks you before it confirms either. The same goes for `apply` with
  `include_tenant_wide`: it imports the package's tenant-wide sections
  (`tenant_settings`, `model_registry`, …) for every solution of the tenant,
  and its preview's `tenant_wide` names the active solutions the change
  reaches (`reaches_active_solutions`). Without it, a solution's import leaves
  those sections out, and `tenant_wide.left_out` says which. The preview it
  stores keeps the flag, so the confirm sends the same request. `pull` takes
  `include_tenant_wide` too, to write those sections into the folder.
- **What changes without `confirm`.** `init`, `pull` and `fmt` change nothing
  on the instance; they write files in the solution folder (`pull` refuses to
  replace a package file that is neither committed nor as the last pull or
  apply left it, unless `force`), and the other tools marked changing act at
  once:
  `use_tenant`, `tenant_create`, `harness_new`, `harness_clone`, `activate`
  (through the readiness gate), `chat` (one turn of a conversation with the
  solution it names, the way to try one that is not the default route),
  `variables_set`, `kb_upload` (without
  `replace`, or where the instance replaces itself), `test_run`,
  `loop_start`, `loop_pause`, `loop_resume`, `sandbox_validate`,
  `sandbox_refresh` and `artifacts_export`.
- **What no tool does, even with `confirm`.** `api` refuses an operation the
  instance keeps for a person (`operation_for_a_person`); a person does those
  in Cavelon or in their terminal. An instance marks them in its OpenAPI
  (`x-cavelon-person-only`, with the reason in
  `x-cavelon-person-only-reason`): setting or deleting a secret value,
  issuing, resetting or revoking a credential, and deciding an approval. `api`
  refuses exactly the operations marked, read-only or not, and the error
  carries the instance's reason. On an instance that marks none, `api` judges
  by the words of the path instead and refuses an operation that changes a
  secret, creates or revokes a credential (personal access tokens, API keys,
  sign-in) or decides an approval.
- **No secret value in a body.** `api` also refuses, even with `confirm`, a
  body that sets a field the instance marks as holding a secret value
  (`"x-cavelon-secret": true`, with `"writeOnly": true`), in nested objects
  and arrays too (`secret_field_for_a_person`). The error names the field and
  points to `cavelon secrets set` or the Admin; the agent can send the rest
  without the field. A field set to `null` passes, and an instance whose
  OpenAPI marks no field is checked as before. A secret typed into a free-form
  map, such as a headers or settings object, cannot be detected.
- **The same guards in the agent's shell.** When a coding agent runs
  `cavelon api` in its shell (`CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CURSOR_AGENT`,
  `GEMINI_CLI`, `COPILOT_CLI`, `COPILOT_AGENT`, `AI_AGENT` or
  `CAVELON_AGENT=1` is set), the rules of the `api` tool hold there too: it
  refuses what the tool refuses, keeps its files in the solution folder, and
  for an operation that is not read-only prints the request and a token and
  sends it only when run again with `--confirm <token>`.
  [Security](security.md#when-the-agent-runs-cavelon-in-its-shell) lists the
  variables and the limits of this guard.
- **Files stay in the solution folder.** Every path a tool takes (`api`'s
  `file` and `body` `@file`, `loop_start`'s `input` `@file`, `kb_upload`'s
  folder, `sandbox_seed`'s source, `artifacts_export`'s `out`, `init`'s
  `from`) must lead, after symlinks, into the folder of `cavelon.yaml`, or the
  folder the server started in when there is none (`path_outside_solution`),
  and never into cavelon's own config or cache directory, which hold the
  stored token (`path_in_kit_directory`). In your terminal, `cavelon` takes
  any path you name; `cavelon api` run by a coding agent confines its paths as
  the tool does.
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

The first result of a session, a failed one too, may carry one more warning:
that `cavelon`, the Cavelon plugin or the skills `cavelon init --agents` wrote
in the solution folder are behind, with the commands that update each, for the
agent to pass on to the person. The server looks the latest release up as it
starts, as the terminal's update notice does (once a day, from the same
cache), and holds that first call at most 1.5 seconds for it; a failed lookup
says nothing, and `CAVELON_NO_UPDATE_CHECK=1` turns it off.
[When you work only through a coding agent](installation.md#when-you-work-only-through-a-coding-agent)
shows the warning and what it names.
