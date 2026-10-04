# Command reference

<!-- Generated from the commands' own help by cli/test/commands-doc.test.ts. Do not edit by hand: run `npm run docs:commands` in cli/. -->

Every command prints text for a person, or one JSON document with `--json`. Every command runs without a prompt
(only `login` and `secrets set` read a value, from a terminal or stdin), and is marked **read-only** (changes
nothing) or **changing**; a changing command that may delete or overwrite something is **destructive**. The same
commands are tools of the [MCP server](mcp.md), named in each section. `cavelon <command> --help` prints the same
help in the terminal.

In a `--json` document, `warnings` is always a list, never a count, and carries the warnings printed on stderr:
messages, or for `validate` objects with `code` and `message`.

## Global options

Every command takes these:

| Option | Description |
|---|---|
| `--json` | Print one JSON document instead of text. |
| `--instance <url>` | The instance URL (overrides CAVELON_URL and cavelon.yaml). |
| `--tenant <tenant>` | Tenant slug, name or id (overrides CAVELON_TENANT and cavelon.yaml). |
| `-h, --help` | Show help for the command. |

The instance, tenant and token can also come from the environment (`CAVELON_URL`, `CAVELON_TENANT`,
`CAVELON_TOKEN`) or from the solution's `cavelon.yaml` and `env/<name>.yaml`; an option wins over the environment,
the environment over the files. The exit codes are listed in [Troubleshooting](troubleshooting.md#exit-codes).

## Contents

- **Session:** [`setup`](#cavelon-setup), [`login`](#cavelon-login), [`logout`](#cavelon-logout), [`whoami`](#cavelon-whoami), [`use`](#cavelon-use), [`status`](#cavelon-status)
- **Solution as code:** [`init`](#cavelon-init), [`pull`](#cavelon-pull), [`validate`](#cavelon-validate), [`apply`](#cavelon-apply), [`activate`](#cavelon-activate), [`explain`](#cavelon-explain)
- **Tenants and solutions:** [`tenant create`](#cavelon-tenant-create), [`tenant list`](#cavelon-tenant-list), [`harness list`](#cavelon-harness-list), [`harness new`](#cavelon-harness-new), [`harness clone`](#cavelon-harness-clone)
- **Knowledge, tests and traces:** [`kb upload`](#cavelon-kb-upload), [`test run`](#cavelon-test-run), [`wait`](#cavelon-wait), [`watch`](#cavelon-watch), [`trace`](#cavelon-trace)
- **Variables and secrets:** [`variables list`](#cavelon-variables-list), [`variables get`](#cavelon-variables-get), [`variables set`](#cavelon-variables-set), [`variables delete`](#cavelon-variables-delete), [`secrets list`](#cavelon-secrets-list), [`secrets set`](#cavelon-secrets-set), [`secrets delete`](#cavelon-secrets-delete)
- **Limits and capacity:** [`limits`](#cavelon-limits), [`limits set`](#cavelon-limits-set), [`models list`](#cavelon-models-list), [`models set-limit`](#cavelon-models-set-limit)
- **Loops and triggers:** [`loop start`](#cavelon-loop-start), [`loop watch`](#cavelon-loop-watch), [`loop iterations`](#cavelon-loop-iterations), [`loop pause`](#cavelon-loop-pause), [`loop resume`](#cavelon-loop-resume), [`loop cancel`](#cavelon-loop-cancel), [`trigger identity`](#cavelon-trigger-identity)
- **Sandboxes:** [`sandbox list`](#cavelon-sandbox-list), [`sandbox validate`](#cavelon-sandbox-validate), [`sandbox files`](#cavelon-sandbox-files), [`sandbox cat`](#cavelon-sandbox-cat), [`sandbox activity`](#cavelon-sandbox-activity), [`sandbox logs`](#cavelon-sandbox-logs), [`sandbox receipt`](#cavelon-sandbox-receipt), [`sandbox seed`](#cavelon-sandbox-seed), [`sandbox refresh`](#cavelon-sandbox-refresh), [`artifacts export`](#cavelon-artifacts-export)
- **API and docs:** [`api list`](#cavelon-api-list), [`api describe`](#cavelon-api-describe), [`api`](#cavelon-api), [`docs search`](#cavelon-docs-search), [`docs get`](#cavelon-docs-get)
- **For agents:** [`commands`](#cavelon-commands), [`mcp`](#cavelon-mcp)

## Session

Set up your coding agents, log in, choose a tenant, and see where you are.

### cavelon setup

Set up your coding agents for Cavelon and log in, in one guided step.

**changing (destructive)** · MCP tool: none (run it in a terminal)

```text
cavelon setup [options]
```

Finds Claude Code, Codex, Cursor, VS Code with GitHub Copilot, Gemini CLI and Kiro, shows what it will change for each, asks once and does it: Claude Code and Codex get the Cavelon plugin through their own plugin command; the others get the `cavelon` MCP server in their user MCP configuration and the skills in their user skills folder. It touches nothing else in those files and records what it did, so --remove undoes exactly that. Then it logs in if needed, choosing the tenant by name as `login` does. The server starts as `cavelon mcp` when cavelon is installed, otherwise through npx. --check reports what is set up and working: each agent's entry, the MCP server starting, and the login. Without a terminal it changes nothing unless --yes.

| Option | Description |
|---|---|
| `--agents <list>` | Only these agents: claude, codex, cursor, copilot, gemini, kiro, or all (comma-separated). Default: every agent found. Repeatable. |
| `-y, --yes` | Make the changes without asking. |
| `--check` | Report what is set up and working; change nothing. |
| `--remove` | Undo what setup did (your login stays). |

Examples:

```bash
cavelon setup
cavelon setup --agents claude,codex --instance https://cavelon.example.com --yes
cavelon setup --check
cavelon setup --remove
```

### cavelon login

Store a token for an instance (a person runs this, never the agent).

**changing** · MCP tool: none (run it in a terminal)

```text
cavelon login [options]
```

Asks for the token without echoing it, or reads it from standard input with --token-stdin. It is never an argument. Create a personal access token (cvpat_…) on /account/access-tokens; a tenant API key (cbp_…) also works. The token is kept in the operating system's credential store, or in a file only you can read. Without --tenant, login finds the tenants the token reaches: one is used; from several, a person chooses on a terminal by number or name; without a terminal the token is stored and login prints one `cavelon use` line per tenant (exit 2). An operator's token that reaches every tenant asks for part of the tenant's name. --tenant takes the tenant's name, slug or id. An older instance that lists no tenants places the token itself, or needs --tenant &lt;tenant-id&gt;.

| Option | Description |
|---|---|
| `--token-stdin` | Read the token from standard input. |

Examples:

```bash
cavelon login --instance https://cavelon.example.com
cavelon login --instance https://cavelon.example.com --tenant "Acme Support"
op read op://dev/cavelon/token | cavelon login --token-stdin --tenant acme-support
```

### cavelon logout

Delete the stored token for an instance.

**changing (destructive)** · MCP tool: none (run it in a terminal)

```text
cavelon logout [options]
```

| Option | Description |
|---|---|
| `--all` | Log out of every instance. |

### cavelon whoami

Show who the token acts as, in which tenant, and where the token came from.

**read-only** · MCP tool: `whoami`

```text
cavelon whoami
```

### cavelon use

Choose the tenant this instance's commands act in.

**changing** · MCP tool: `use_tenant`

```text
cavelon use [tenant] [options]
```

Stored per instance for your user. CAVELON_TENANT, --tenant and a cavelon.yaml tenant take precedence over it. Without a tenant, it lists the tenants the token reaches: a person chooses one on a terminal by number or part of its name; without a terminal it prints one `cavelon use` line per tenant, and as an MCP tool it returns them as choices and changes nothing.

| Argument | Description |
|---|---|
| `tenant` | The tenant's name, slug or id; leave it out to choose from a list. |

| Option | Description | MCP |
|---|---|---|
| `--clear` | Forget the chosen tenant. | yes |

Examples:

```bash
cavelon use
cavelon use acme-support
cavelon use "Acme Support"
```

### cavelon status

Show the instance, tenant, solution, running operations and quotas close to full for this directory.

**read-only** · MCP tool: `status`

```text
cavelon status [options]
```

| Option | Description | MCP |
|---|---|---|
| `--offline` | Do not contact the instance. | yes |

## Solution as code

Turn a folder into a solution, check it, preview it, import it and activate it.

### cavelon init

Make this folder a Cavelon solution: cavelon.yaml, package/, tests/, env/ and .cavelon/.

**changing (destructive)** · MCP tool: `init`

```text
cavelon init [options]
```

Never overwrites a file it did not create. AGENTS.md, .gitignore and an existing CLAUDE.md get at most a block between cavelon:begin and cavelon:end markers. --agents also writes the skills to .agents/skills/ and .claude/skills/ and each named agent's `cavelon mcp` entry, for agents without the Cavelon plugin. --update changes only those marked blocks and the fallback files a previous init wrote. --from writes an existing package file (JSON or YAML export) into package/ and tests/ as `pull` writes an export, so validate and apply take it from there; it refuses to change or remove a package file that holds something else unless --force, and names the sections the instance's schema does not know.

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution (harness) this folder holds, by name, slug or id; its slug goes into cavelon.yaml. Without it, init asks on a terminal. | yes |
| `--agents <list>` | Write the fallback for these agents: claude, codex, cursor, copilot, gemini, kiro, pi, other or all (comma-separated). Repeatable. | yes |
| `--hook` | Add a git pre-commit hook that runs `cavelon validate`; never in a hooks folder outside the repository. | yes |
| `--update` | Only bring the marked blocks and fallback files to this version. | yes |
| `--from <file>` | Write this package file (a JSON or YAML export) into package/ and tests/. | yes |
| `--force` | With --from: replace package files that hold something else. | yes |

Examples:

```bash
cavelon init
cavelon init --instance https://cavelon.example.com --tenant "Acme Support" --harness "Support FAQ"
cavelon init --agents codex,cursor --hook
cavelon init --update
cavelon init --instance https://cavelon.example.com --tenant acme --from ./blueprint.json
```

### cavelon pull

Write the instance's package into package/ (split along the schema's sections) and the inventory into .cavelon/.

**changing (destructive)** · MCP tool: `pull`

```text
cavelon pull [options]
```

With a solution (--harness, or cavelon.yaml's harness), exports that solution; without one, the tenant's full configuration. A file whose content did not change keeps its bytes, so `git diff` shows what changed on the instance. Files of sections the schema does not know are kept byte for byte. Refuses when package files have uncommitted changes, unless --force; outside a git repository, when a file it would overwrite or remove changed since the last pull.

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution to export, by name, slug or id; its slug is recorded in cavelon.yaml when it names none. | yes |
| `--force` | Overwrite package files that have uncommitted changes (outside git: changes since the last pull). | yes |

Examples:

```bash
cavelon pull --harness support
cavelon pull && git diff -- package tests
```

### cavelon validate

Check the package files against the instance's package schema, offline.

**read-only** · MCP tool: `validate`

```text
cavelon validate [options]
```

Uses the schema and error catalog cached by init, pull or apply; fetches them only when none is cached or a development build's copy is past its time-to-live, and never with --offline. A development build keeps one version while its schema changes, so its copy is read again after a minute (CAVELON_CONTRACT_TTL_SECONDS), or checked with the ETag the instance sent with it; --verbose says which copy was used. Warns (never fails) when a fan-out or Map loop's max_concurrency is above the instance's branch width, and when the tenant runs fan-outs and Map loops in sequence, from the limits the instance last published. Each finding carries a code: `cavelon explain <code>` says more. The import preview checks everything again on the server.

With --json, `warnings` is always a list of `{code, message}` objects: the warning findings (at most --limit), then the warnings about the run, such as a stale copy of the schema, with code null. `warning_count` counts them all and `error_count` the errors (`errors` is the same number); `findings` has each finding's file, line and hint.

| Option | Description | MCP |
|---|---|---|
| `--offline` | Never contact the instance, even when nothing is cached. | yes |
| `--limit <n>` | Print at most n findings (default 50). | yes |
| `--verbose` | Also say which copy of the package schema was used: cached or read now, when, and its hash. | yes |

### cavelon apply

Preview the package files against the instance and print a preview id; --confirm &lt;id&gt; imports exactly that preview.

**changing (destructive)** · MCP tool: `apply`

```text
cavelon apply [options]
```

Without --confirm nothing is imported: the preview shows what changes, which active solutions it reaches, what the target still needs (secrets and variables with the command that sets each, grants, runtime bindings, trigger identities), loop budgets and ignored sections, and is stored in .cavelon/. When the env file names a solution that does not exist yet, apply creates it as a draft first. A person sets the secrets (`cavelon secrets set <name>`), never the agent. Show a preview that reaches an active solution or env/prod to a person before confirming. A stale preview exits 4; so does an import its own check refuses when it applies, naming each blocker.

| Option | Description | MCP |
|---|---|---|
| `--env <name>` | Use env/&lt;name&gt;.yaml: its tenant, solution and runtime bindings. | yes |
| `--harness <harness>` | The solution (harness): its name, slug or id; default: env file, then cavelon.yaml. | yes |
| `--confirm <preview-id>` | Import exactly this stored preview. | yes |
| `--mode <mode>` | overwrite (default) or replace (deletes what the package does not hold). | yes |

Examples:

```bash
cavelon apply --env test
cavelon apply --confirm <preview-id>
cavelon apply --env prod --json
```

### cavelon activate

Activate a solution through the readiness gate (never by force).

**changing** · MCP tool: `activate`

```text
cavelon activate [options]
```

Only when every readiness check passes, and with a personal access token only when it was created with "may activate". Activating without the evidence stays a person's decision in the Admin.

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution (harness): its name, slug or id; default: env file, then cavelon.yaml. | yes |
| `--env <name>` | Use env/&lt;name&gt;.yaml: its tenant, solution and runtime bindings. | yes |

### cavelon explain

Look a code up in the instance's error catalog: what it means and how to fix it.

**read-only** · MCP tool: `explain`

```text
cavelon explain <code>
```

Rule codes come from the package and graph checks, API error codes from failed requests. Uses the cached catalog first. Also explains the test-case statuses that are neither pass nor fail: calibration_required, pending_review, not_run, not_evaluated, skip.

| Argument | Description |
|---|---|
| `code` | The code, e.g. from `cavelon validate` or an error's code, or a test-case status. Required. |

## Tenants and solutions

Create and list tenants and solutions (harnesses).

### cavelon tenant create

Create a tenant (personal access token in Platform mode with tenants.manage).

**changing** · MCP tool: `tenant_create`

```text
cavelon tenant create <slug> [options]
```

A tenant API key never can. Inviting people and assigning roles stay in the Admin.

| Argument | Description |
|---|---|
| `slug` | Lower-case letters, digits and dashes. Required. |

| Option | Description | MCP |
|---|---|---|
| `--name <name>` | Display name (default: the slug). | yes |
| `--plan <plan>` | Licence plan, when the instance knows several. | yes |
| `--use` | Switch to the new tenant afterwards (`cavelon use`). | yes |
| `--idempotency-key <key>` | Send an Idempotency-Key, so a retry does not create a second one. | yes |

### cavelon tenant list

List the tenants this token can see, with name, slug and id.

**read-only** · MCP tool: `tenant_list`

```text
cavelon tenant list [options]
```

A personal access token in Platform mode sees every tenant; any other sees the tenants it reaches. An operator's token that reaches every tenant lists the person's own and finds any other with --search.

| Option | Description | MCP |
|---|---|---|
| `--search <text>` | Only tenants whose name or slug contains the text. | yes |
| `--limit <n>` | Return at most n items. | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

### cavelon harness list

List the tenant's solutions (harnesses).

**read-only** · MCP tool: `harness_list`

```text
cavelon harness list [options]
```

| Option | Description | MCP |
|---|---|---|
| `--readiness` | Include whether each one is ready to activate (slower). | yes |
| `--limit <n>` | Return at most n items. | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

### cavelon harness new

Create an empty draft solution (harness).

**changing** · MCP tool: `harness_new`

```text
cavelon harness new <slug> [options]
```

| Argument | Description |
|---|---|
| `slug` | The new solution's slug. Required. |

| Option | Description | MCP |
|---|---|---|
| `--name <name>` | Display name (default: the slug). | yes |
| `--description <text>` | What the solution is for. | yes |
| `--idempotency-key <key>` | Send an Idempotency-Key, so a retry does not create a second one. | yes |

### cavelon harness clone

Copy a solution into a new draft solution.

**changing** · MCP tool: `harness_clone`

```text
cavelon harness clone <source> [options]
```

| Argument | Description |
|---|---|
| `source` | Name, slug or id of the solution to copy. Required. |

| Option | Description | MCP |
|---|---|---|
| `--slug <slug>` | The copy's slug. | yes |
| `--name <name>` | The copy's display name. | yes |
| `--description <text>` | The copy's description. | yes |
| `--suffix <suffix>` | Appended to the slugs of copied elements. | yes |
| `--no-tests` | Do not copy the test suites. | yes |
| `--no-triggers` | Do not copy the triggers. | yes |
| `--idempotency-key <key>` | Send an Idempotency-Key, so a retry does not create a second one. | yes |

## Knowledge, tests and traces

Seed knowledge bases, run test suites, wait for the work and read what happened.

### cavelon kb upload

Upload a folder's documents into a knowledge base; returns operation ids.

**changing** · MCP tool: `kb_upload`

```text
cavelon kb upload <dir> [options]
```

Hidden files are skipped. Ingestion runs on the instance; `cavelon wait` follows it. Files are checked against the instance's published upload limits first. A .zip goes only to a tenant that expands archives, and only within its caps on file count, unpacked size and compression ratio.

| Argument | Description |
|---|---|
| `dir` | Folder (or single file) to upload. Required. |

| Option | Description | MCP |
|---|---|---|
| `--kb <kb>` | Knowledge base name or id (required). | yes |
| `-r, --recursive` | Include subfolders. | yes |
| `--ext <ext>` | Only these file extensions (pdf, md, …). Repeatable. | yes |
| `--dry-run` | List what would be uploaded, upload nothing. | yes |
| `--wait` | Wait for the work to finish (see `cavelon wait`). | CLI only |
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |

Examples:

```bash
cavelon kb upload ./docs --kb FAQ
cavelon kb upload ./manuals --kb FAQ -r --ext pdf --wait --timeout 5m
```

### cavelon test run

Start test-suite runs; returns operation ids.

**changing** · MCP tool: `test_run`

```text
cavelon test run [options]
```

Without --suite, runs every suite of the solution (--harness, or cavelon.yaml's harness). With --wait, exits 1 when a case failed or a run measured nothing comparable (cases not run, technical errors), 5 when answers wait for a manual verdict or a value a case needs.

| Option | Description | MCP |
|---|---|---|
| `--suite <suite>` | Suite name or id. Repeatable. | yes |
| `--harness <harness>` | The solution to run against: its name, slug or id. | yes |
| `--wait` | Wait for the work to finish (see `cavelon wait`). | CLI only |
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |
| `--idempotency-key <key>` | Send an Idempotency-Key with each start. | yes |

Examples:

```bash
cavelon test run --suite smoke --wait --timeout 10m
cavelon test run --harness support --json
```

### cavelon wait

Wait until operations finish, need a person, or the timeout passes.

**read-only** · MCP tool: `operation_status`

```text
cavelon wait <operation...> [options]
```

Exit 0 when all succeeded, 1 when one failed or was cancelled, 5 when one needs a person, 6 when the timeout passed first. A test run that finished with failed cases counts as failed, and its cases are named. The state is printed in every case, and a second `wait` resumes.

| Argument | Description |
|---|---|
| `operation` | Operation ids (op_…). Required. One or more. |

| Option | Description | MCP |
|---|---|---|
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |

Examples:

```bash
cavelon wait op_test_run_0f…
cavelon wait op_a op_b --timeout 5m --json
```

### cavelon watch

Stream an operation's changes until it ends (server-sent events).

**read-only** · MCP tool: none (run it in a terminal)

```text
cavelon watch <operation> [options]
```

Prints one line per change (one JSON object per line with --json). A needs_action state is shown and the stream goes on.

| Argument | Description |
|---|---|
| `operation` | Operation id (op_…). Required. |

| Option | Description |
|---|---|
| `--timeout <duration>` | Stop watching after this long (default 10m). |

### cavelon trace

Summarise the traces of a run, with a command for each span's detail.

**read-only** · MCP tool: `trace`

```text
cavelon trace <run> [options]
```

&lt;run&gt; is a trigger run id, a test run id, a conversation id or an operation id (op_…). Without --trace: one line per trace (or per test result). With --trace: its spans. With --span: one span in full.

| Argument | Description |
|---|---|
| `run` | Run, conversation or operation id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--kind <kind>` | trigger, test or conversation (default: found out). | yes |
| `--trace <trace_id>` | Show this trace's spans. | yes |
| `--span <span_id>` | Show one span's input, output and error (needs --trace). | yes |
| `--full` | Do not shorten span input and output. | yes |
| `--limit <n>` | Return at most n items. | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon trace op_test_run_…
cavelon trace <run> --trace <trace_id>
cavelon trace <run> --trace <trace_id> --span <span_id>
```

## Variables and secrets

Tenant values a package refers to as `{{var:…}}` and `{{secret:…}}`. A secret's value is set by a person, never by the agent.

### cavelon variables list

List the tenant's variables ({{var:…}}) with their values.

**read-only** · MCP tool: `variables_list`

```text
cavelon variables list [options]
```

Variables are plain text: anyone who may view the tenant's settings reads them. A credential belongs in a secret. A value longer than 200 characters is cut here; `cavelon variables get <name>` returns it whole.

| Option | Description | MCP |
|---|---|---|
| `--limit <n>` | Return at most n items. | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. | yes |

Examples:

```bash
cavelon variables list
cavelon variables list --env prod --json
```

### cavelon variables get

Show one tenant variable with its whole value.

**read-only** · MCP tool: `variables_get`

```text
cavelon variables get <name> [options]
```

| Argument | Description |
|---|---|
| `name` | The variable's name, as {{var:&lt;name&gt;}} uses it. Required. |

| Option | Description | MCP |
|---|---|---|
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. | yes |

### cavelon variables set

Create or replace a tenant variable.

**changing** · MCP tool: `variables_set`

```text
cavelon variables set <name> [value] [options]
```

The value is plain text that anyone who may view the tenant's settings reads; never put a credential into a variable, use `cavelon secrets set` (a person runs it). --stdin reads the value from standard input instead of the argument.

| Argument | Description |
|---|---|
| `name` | The variable's name, as {{var:&lt;name&gt;}} uses it. Required. |
| `value` | The value (plain text, not a credential). |

| Option | Description | MCP |
|---|---|---|
| `--stdin` | Read the value from standard input. | CLI only |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. | yes |

Examples:

```bash
cavelon variables set crm_base_url https://crm.example.com
cavelon variables set greeting --stdin < greeting.txt
```

### cavelon variables delete

Delete a tenant variable (needs --confirm).

**changing (destructive)** · MCP tool: none (run it in a terminal)

```text
cavelon variables delete <name> [options]
```

Without --confirm, shows the variable and deletes nothing. A prompt or tool that names it gets no value afterwards.

| Argument | Description |
|---|---|
| `name` | The variable's name. Required. |

| Option | Description |
|---|---|
| `--confirm` | Delete it; without this nothing is deleted. |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. |

Examples:

```bash
cavelon variables delete old_url
cavelon variables delete old_url --confirm
```

### cavelon secrets list

List the tenant's secret names ({{secret:…}}) with whether each is set; never a value.

**read-only** · MCP tool: `secrets_list`

```text
cavelon secrets list [options]
```

Lists every secret that has a value or that an imported package declared. A person sets a missing one with `cavelon secrets set <name>`; an agent never sets or reads a secret value.

| Option | Description | MCP |
|---|---|---|
| `--missing` | Only the secrets that are not set. | yes |
| `--limit <n>` | Return at most n items. | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. | yes |

Examples:

```bash
cavelon secrets list
cavelon secrets list --missing --json
```

### cavelon secrets set

Set a secret's value (a person runs this, never the agent).

**changing** · MCP tool: none (run it in a terminal)

```text
cavelon secrets set <name> [options]
```

Asks for the value without echoing it, or reads it from standard input when that is piped (one trailing line break is dropped). The value is never an argument, never printed and never read back. A tenant API key cannot set a secret.

| Argument | Description |
|---|---|
| `name` | The secret's name, as {{secret:&lt;name&gt;}} uses it. Required. |

| Option | Description |
|---|---|
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. |

Examples:

```bash
cavelon secrets set crm_api_token
op read op://dev/crm/token | cavelon secrets set crm_api_token
```

### cavelon secrets delete

Delete a secret's value (needs --confirm; a person runs this).

**changing (destructive)** · MCP tool: none (run it in a terminal)

```text
cavelon secrets delete <name> [options]
```

Without --confirm, shows the secret's status and deletes nothing. A tool or prompt that names it fails until a person sets it again. A tenant API key cannot delete a secret.

| Argument | Description |
|---|---|
| `name` | The secret's name. Required. |

| Option | Description |
|---|---|
| `--confirm` | Delete it; without this nothing is deleted. |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. |

Examples:

```bash
cavelon secrets delete old_token
cavelon secrets delete old_token --confirm
```

## Limits and capacity

Read the instance's limits and change those you may change. See [Limits](limits.md).

### cavelon limits

Show the instance's limits for this tenant, who can change each, and the tenant's quotas with their use.

**read-only** · MCP tool: `limits`

```text
cavelon limits [options]
```

Read them before planning a solution: upload sizes and file types, run and tool limits, timeouts, rate limits, licence caps. Grouped by source (tenant, platform, licence); each names who changes it (a tenant admin or the operator) and the setting. A run cap also names its origin when the instance says: a platform setting (the Admin), the environment or the default. A limit that binds only while another is on says so (the archive caps apply while archive uploads are on). Branch concurrency: the width per node, the ceiling per process, and whether branches run concurrently (and which switch is off). The tenant quotas include the monthly Processing Step cap with this billing month's use, where the instance publishes it. A limit the instance does not list does not bind there. An instance older than the published limits lists none.

| Option | Description | MCP |
|---|---|---|
| `--key <key>` | Only these limits (e.g. kb_upload_max_file_size_mb). Repeatable. | yes |
| `--source <source>` | Only limits from this source: tenant, platform or licence. | yes |

Examples:

```bash
cavelon limits
cavelon limits --key kb_upload_max_file_size_mb --json
cavelon limits --source tenant
```

### cavelon limits set

Change a limit through the operation the instance names: a tenant's, or an operator's in Platform mode (needs --confirm).

**changing (destructive)** · MCP tool: `limits_set`

```text
cavelon limits set <key> <value> [options]
```

Reads the limit's published change (operation, body field, bounds, permissions, roles) and checks the value against it before sending. Without --confirm, shows the old and new value, the operation and who may run it, and changes nothing. Also changes the tenant quotas in tenant_quotas.changes (the inference budget, the monthly Processing Step cap). An operator's change (a run cap) is sent only with a personal access token in Platform mode of a role it names, without X-Tenant-Id; --tenant &lt;id\|slug&gt; then sets one tenant's own run cap. An environment or licence limit, a value out of bounds, an instance that does not publish how to change the limit, and a credential without the permission or the role are refused before anything is sent. Propose the change to the person; never raise a limit on your own.

| Argument | Description |
|---|---|
| `key` | The limit's key, as `cavelon limits` lists it (e.g. kb_upload_max_file_size_mb). Required. |
| `value` | The new value in the limit's unit (50 or 50MB), a comma-separated list of file types, true/false, or none to clear the tenant's own value. Required. |

| Option | Description | MCP |
|---|---|---|
| `--confirm` | Change it; without this nothing is changed. | yes |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. | yes |

Examples:

```bash
cavelon limits set kb_upload_max_file_size_mb 50
cavelon limits set kb_upload_max_file_size_mb 50 --confirm
cavelon limits set rate_limit_chat_rpm none --confirm
cavelon limits set monthly_inference_token_budget 2000000
cavelon limits set monthly_processing_step_cap none --confirm
cavelon limits set max_concurrent_agent_runs_global 150 --confirm
cavelon limits set max_concurrent_agent_runs_per_tenant 6 --tenant acme --confirm
```

### cavelon models list

List the tenant's Model Registry rows with their endpoint and max_concurrent_requests; never a key.

**read-only** · MCP tool: `models_list`

```text
cavelon models list [options]
```

Each row's endpoint (scheme, host, port, path of its base_url) and how many requests it may send there at once (max_concurrent_requests; none means no limit). Rows with the same base_url share that count. A row without a base_url reaches its provider through the platform's routes and takes no limit. Keys are never shown, only their kind.

| Option | Description | MCP |
|---|---|---|
| `--limit <n>` | Return at most n items. | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. | yes |

Examples:

```bash
cavelon models list
cavelon models list --json
```

### cavelon models set-limit

Set or clear how many requests a Model Registry row's endpoint gets at once (needs --confirm).

**changing (destructive)** · MCP tool: `models_set_limit`

```text
cavelon models set-limit <model> <limit> [options]
```

Sets the row's max_concurrent_requests to &lt;n&gt;, or clears it with none. Without --confirm, shows the old and new value and changes nothing. A row without a base_url is refused before anything is sent: it reaches its provider through the platform's routes, which have their own limits. Every row with the same base_url shares the count. Propose a value to the person and let them decide; the instance's capacity tutorial says how to find it.

| Argument | Description |
|---|---|
| `model` | The row's model_id, id or display name (`cavelon models list`). Required. |
| `limit` | Requests the endpoint serves at once (a whole number), or none to clear the limit. Required. |

| Option | Description | MCP |
|---|---|---|
| `--confirm` | Change it; without this nothing is changed. | yes |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. | yes |

Examples:

```bash
cavelon models set-limit llama-70b 8
cavelon models set-limit llama-70b 8 --confirm
cavelon models set-limit llama-70b none --confirm
```

## Loops and triggers

Start, follow and control long-running loops, and the identity a trigger's unattended runs act as.

### cavelon loop start

Start a loop through its trigger, as you; returns the run and operation ids.

**changing** · MCP tool: `loop_start`

```text
cavelon loop start <trigger> [options]
```

Calls the trigger's run-now route. The run (and its loop) acts as the caller: with a personal access token, the person. Follow it with `loop watch <run>`, or `wait <operation>`; `loop cancel <run>` stops it.

| Argument | Description |
|---|---|
| `trigger` | Trigger slug, name or id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--input <json|@file|->` | The run's payload: JSON, @file.json or - for stdin. | yes |
| `--wait` | Wait for the run to finish (see `cavelon wait`). | CLI only |
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |
| `--idempotency-key <uuid>` | The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice. | yes |

Examples:

```bash
cavelon loop start counter
cavelon loop start orders --input @orders-request.json --json
```

### cavelon loop watch

Follow a loop: one line per decided iteration and per state change, then the loop's outcome.

**read-only** · MCP tool: none (run it in a terminal)

```text
cavelon loop watch <run> [options]
```

Prints each iteration once the loop accepted it, rejected it or its child failed, with its outcome and usage (one JSON object per line with --json), and the loop's outcome when it ends or pauses. Exit 0 when the loop completed, 1 when it failed or was cancelled, 5 at once when it pauses (a person reviews and resumes it), 6 when the timeout passed first.

| Argument | Description |
|---|---|
| `run` | The trigger run id. Required. |

| Option | Description |
|---|---|
| `--loop <loop_id>` | The loop, when the run has more than one. |
| `--timeout <duration>` | Stop watching after this long (default 10m). |

Examples:

```bash
cavelon loop watch <run>
cavelon loop watch <run> --json --timeout 5m
```

### cavelon loop iterations

A loop's state, budget and iterations, a page at a time.

**read-only** · MCP tool: `loop_iterations`

```text
cavelon loop iterations <run> [options]
```

Each iteration's verdict: accepted, rejected or failed (the child failed), ended (not yet accepted) or running; the outcome of its accepted result (continue, wait, done, blocked), and its usage once the instance reports it.

| Argument | Description |
|---|---|
| `run` | The trigger run id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--loop <loop_id>` | The loop, when the run has more than one. | yes |
| `--limit <n>` | Return at most n iterations (at most 20). | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon loop iterations <run>
cavelon loop iterations <run> --cursor 20 --json
```

### cavelon loop pause

Ask a loop to pause at its next safe point.

**changing** · MCP tool: `loop_pause`

```text
cavelon loop pause <run> [options]
```

The current iteration finishes first. A paused loop waits for `loop resume`; `wait` on its run exits 5 meanwhile.

| Argument | Description |
|---|---|
| `run` | The trigger run id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--loop <loop_id>` | The loop, when the run has more than one. | yes |
| `--idempotency-key <uuid>` | The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice. | yes |

Examples:

```bash
cavelon loop pause <run>
cavelon loop pause <run> --loop <loop_id>
```

### cavelon loop resume

Resume a paused loop.

**changing** · MCP tool: `loop_resume`

```text
cavelon loop resume <run> [options]
```

The instance checks the loop's budget, deadline and Sandbox again before it goes on. A pause that is a verdict on the task needs --reason with the pause reason a person reviewed, exactly as the loop names it (`loop watch` prints the command); any other pause resumes without it. A pause that cannot be resumed is refused with what to do instead.

| Argument | Description |
|---|---|
| `run` | The trigger run id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--loop <loop_id>` | The loop, when the run has more than one. | yes |
| `--reason <pause_reason>` | The pause reason a person reviewed, exactly as the loop names it (task_blocked, not free text); only a verdict on the task needs it. | yes |
| `--idempotency-key <uuid>` | The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice. | yes |

Examples:

```bash
cavelon loop resume <run>
cavelon loop resume <run> --loop <loop_id> --reason task_blocked
```

### cavelon loop cancel

Stop a trigger run and its loops (needs --confirm).

**changing (destructive)** · MCP tool: `loop_cancel`

```text
cavelon loop cancel <run> [options]
```

Without --confirm, shows what would stop and stops nothing. Stopping the run stops every loop of it.

| Argument | Description |
|---|---|
| `run` | The trigger run id (from `loop start`). Required. |

| Option | Description | MCP |
|---|---|---|
| `--confirm` | Stop the run; without it nothing is stopped. | yes |

Examples:

```bash
cavelon loop cancel <run>
cavelon loop cancel <run> --confirm
```

### cavelon trigger identity

Show, bind or clear the API key a trigger's unattended runs act as (binding needs --confirm).

**changing (destructive)** · MCP tool: `trigger_identity`

```text
cavelon trigger identity <trigger> [key] [options]
```

Without &lt;key&gt; or --clear, shows the binding. Binding gives the trigger standing authority, so it is never part of `apply`: show the person, then run it with --confirm. It needs settings.manage and triggers.manage. Creating keys and Sandbox Access stay in the Admin. A personal access token is never an execution identity.

| Argument | Description |
|---|---|
| `trigger` | Trigger slug, name or id. Required. |
| `key` | The API key's name or id (never its value). |

| Option | Description | MCP |
|---|---|---|
| `--clear` | Remove the binding; scheduled and webhook runs then cannot start. | yes |
| `--confirm` | Make the change; without it nothing changes. | yes |

Examples:

```bash
cavelon trigger identity orders
cavelon trigger identity orders loop-runner --confirm
cavelon trigger identity orders --clear --confirm
```

## Sandboxes

Inspect and prepare the Sandboxes a solution runs code in.

### cavelon sandbox list

The tenant's Sandboxes: mode, state, revision, and what each mode offers.

**read-only** · MCP tool: `sandbox_list`

```text
cavelon sandbox list [options]
```

| Option | Description | MCP |
|---|---|---|
| `--limit <n>` | Return at most n Sandboxes (at most 100). | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon sandbox list
cavelon sandbox list --json
```

### cavelon sandbox validate

Run the Sandbox's readiness checks on its runner; exit 3 when one fails.

**changing** · MCP tool: `sandbox_validate`

```text
cavelon sandbox validate <sandbox>
```

Needs sandboxes.manage. A Sandbox that is not ready refuses loops and seeds.

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |

Examples:

```bash
cavelon sandbox validate orders-test
```

### cavelon sandbox files

List a folder of the Sandbox's workspace.

**read-only** · MCP tool: `sandbox_files`

```text
cavelon sandbox files <sandbox> [path] [options]
```

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |
| `path` | Folder in the workspace (default: its root). |

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution the Sandbox is read for, by name, slug or id (default: cavelon.yaml's, or the Sandbox's only allowed one). | yes |
| `--limit <n>` | Return at most n entries (at most 100). | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon sandbox files orders-test
cavelon sandbox files orders-test output --json
```

### cavelon sandbox cat

Print a file of the Sandbox's workspace, a page at a time.

**read-only** · MCP tool: `sandbox_cat`

```text
cavelon sandbox cat <sandbox> <path> [options]
```

At most 32 KiB per call; --offset reads on. --base64 for a binary file.

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |
| `path` | File in the workspace. Required. |

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution the Sandbox is read for, by name, slug or id (default: cavelon.yaml's, or the Sandbox's only allowed one). | yes |
| `--offset <bytes>` | Start at this byte. | yes |
| `--length <bytes>` | Read at most this many bytes (at most 32768). | yes |
| `--base64` | Return the bytes as base64. | yes |

Examples:

```bash
cavelon sandbox cat orders-test output/summary.json
cavelon sandbox cat orders-test data.bin --base64 --json
```

### cavelon sandbox activity

What ran in the Sandbox for a solution: commands, transfers, validations; or one of them.

**read-only** · MCP tool: `sandbox_activity`

```text
cavelon sandbox activity <sandbox> [activity] [options]
```

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |
| `activity` | One activity's id, for its detail. |

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution the Sandbox is read for, by name, slug or id (default: cavelon.yaml's, or the Sandbox's only allowed one). | yes |
| `--limit <n>` | Return at most n entries (at most 100). | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon sandbox activity orders-test
cavelon sandbox activity orders-test <activity_id> --json
```

### cavelon sandbox logs

One activity's log output, a page at a time.

**read-only** · MCP tool: `sandbox_logs`

```text
cavelon sandbox logs <sandbox> <activity> [options]
```

The runner keeps a bounded tail; the next page needs the same --snapshot, which each page prints.

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |
| `activity` | The activity id (from `sandbox activity`). Required. |

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution the Sandbox is read for, by name, slug or id (default: cavelon.yaml's, or the Sandbox's only allowed one). | yes |
| `--offset <bytes>` | Start at this byte. | yes |
| `--length <bytes>` | Read at most this many bytes (at most 32768). | yes |
| `--snapshot <digest>` | The snapshot digest of the first page, to read on. | yes |

Examples:

```bash
cavelon sandbox logs orders-test <activity_id>
```

### cavelon sandbox receipt

The runner's validation receipt of one activity (isolated container only).

**read-only** · MCP tool: `sandbox_receipt`

```text
cavelon sandbox receipt <sandbox> <activity> [options]
```

A trusted receipt exists only on an isolated container; a customer VM reports agent_reported completion.

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |
| `activity` | The activity id (from `sandbox activity`). Required. |

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution the Sandbox is read for, by name, slug or id (default: cavelon.yaml's, or the Sandbox's only allowed one). | yes |

Examples:

```bash
cavelon sandbox receipt orders-test <activity_id> --json
```

### cavelon sandbox seed

Replace an isolated container's workspace with a folder or tar archive (needs --confirm).

**changing (destructive)** · MCP tool: `sandbox_seed`

```text
cavelon sandbox seed <sandbox> <source> [options]
```

Isolated container only; on a customer VM, put the files on the VM and run `sandbox refresh`. The folder is sent as an uncompressed tar (files and folders only); a .tar is sent as it is; any other file lands under its own name. The archive becomes the workspace. Without --confirm, shows what would be sent. Running the same seed again resumes it.

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |
| `source` | A folder, an uncompressed .tar, or one file. Required. |

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution the Sandbox is read for, by name, slug or id (default: cavelon.yaml's, or the Sandbox's only allowed one). | yes |
| `--revision <revision>` | The workspace revision the job expects (default: the current one). | yes |
| `--confirm` | Send it; without it nothing changes. | yes |
| `--wait` | Wait for the job to finish (see `cavelon wait`). | CLI only |
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |
| `--idempotency-key <uuid>` | The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice. | yes |

Examples:

```bash
cavelon sandbox seed orders-test seeds/orders
cavelon sandbox seed orders-test seeds/orders --confirm --wait
```

### cavelon sandbox refresh

Accept a customer VM's workspace as it is now, after files were put on the VM (customer VM only).

**changing** · MCP tool: `sandbox_refresh`

```text
cavelon sandbox refresh <sandbox> [options]
```

Edits on the VM outside Cavelon are legitimate; refresh makes the current files the new baseline revision.

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--idempotency-key <uuid>` | The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice. | yes |

Examples:

```bash
cavelon sandbox refresh spec-vm
```

### cavelon artifacts export

Take files out of an isolated container as a tar archive (isolated container only).

**changing** · MCP tool: `artifacts_export`

```text
cavelon artifacts export <sandbox> [options]
```

Starts an export job and returns its operation id; with --wait (or later with --job &lt;id&gt;) the tar is written to --out (default sandbox-&lt;job&gt;.tar), never over an existing file. On a customer VM, read results with `sandbox cat`.

| Argument | Description |
|---|---|
| `sandbox` | Sandbox name or id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--path <path>` | Export only these workspace paths (repeatable; default: all). Repeatable. | yes |
| `--out <file>` | Where to write the tar (default: sandbox-&lt;job&gt;.tar). | yes |
| `--job <job_id>` | Download a job started earlier, instead of starting one. | yes |
| `--harness <harness>` | The solution the Sandbox is read for, by name, slug or id (default: cavelon.yaml's, or the Sandbox's only allowed one). | yes |
| `--revision <revision>` | The workspace revision the job expects (default: the current one). | yes |
| `--wait` | Wait for the job to finish (see `cavelon wait`). | CLI only |
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |
| `--idempotency-key <uuid>` | The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice. | yes |

Examples:

```bash
cavelon artifacts export orders-test --path output --wait
cavelon artifacts export orders-test --job <job_id> --out results.tar
```

## API and docs

Call any operation the instance publishes, and read the instance's documentation.

### cavelon api list

List the operations the instance publishes.

**read-only** · MCP tool: `api_list`

```text
cavelon api list [options]
```

| Option | Description | MCP |
|---|---|---|
| `--tag <tag>` | Only operations with this OpenAPI tag. | yes |
| `--search <text>` | Only operations whose name, path or summary contains the text. | yes |
| `--method <method>` | Only this HTTP method (GET, POST, …). | yes |
| `--tags` | List the tags with their operation counts instead. | yes |
| `--limit <n>` | Return at most n items. | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

### cavelon api describe

Show one operation's parameters, body and responses.

**read-only** · MCP tool: `api_describe`

```text
cavelon api describe <operation>
```

| Argument | Description |
|---|---|
| `operation` | operationId or its short name. Required. |

### cavelon api

Call any operation the instance publishes in its OpenAPI.

**changing (destructive)** · MCP tool: `api`

```text
cavelon api <operation> [params...] [options]
```

The operation is its operationId or the short name before FastAPI's path suffix (list_harnesses). Parameters: -p name=value or name=value. Body: --json '&lt;json&gt;', --json @file.json or --json - (stdin). The body is checked against the operation's schema before it is sent. As an MCP tool, or run by a coding agent (CLAUDECODE, CODEX_THREAD_ID, CODEX_SANDBOX, CURSOR_AGENT, GEMINI_CLI, COPILOT_CLI, COPILOT_AGENT, AI_AGENT or CAVELON_AGENT=1 is set), an operation that changes something returns what it would send and sends it only with confirm (as an MCP tool) or --confirm &lt;token&gt; (the token the preview printed). Run by an agent, one the instance marks for a person only (x-cavelon-person-only) is refused, as is a body that sets a field the instance marks as a secret value (x-cavelon-secret) and a file outside the solution folder. On an instance that marks no operation, one that changes a secret, creates or revokes a credential or decides an approval is refused. A person's own terminal sends at once.

| Argument | Description |
|---|---|
| `operation` | operationId or its short name. Required. |
| `params` | Parameters as name=value. One or more. |

| Option | Description | MCP |
|---|---|---|
| `-p, --param <name=value>` | A path, query or header parameter. Repeatable. | yes |
| `--body <json|@file|->` | The request body (also accepted as --json &lt;body&gt;). | yes |
| `--file <field=path>` | Attach a file to a multipart body. Repeatable. | yes |
| `--output <file>` | Write the response body to a file instead of printing it. | CLI only |
| `--confirm <token>` | Send an operation that changes something: run by a coding agent, the token its preview printed; as an MCP tool, true. Without it, nothing is sent. A person's terminal sends at once. | yes |
| `--limit <n>` | Show at most n items of a list response (default 50, 0 for all). | yes |

Examples:

```bash
cavelon api list_harnesses
cavelon api get_harness_by_slug slug=support
cavelon api create_knowledge_base --json '{"name": "FAQ"}'
```

### cavelon docs search

Search this instance's docs (titles and summaries).

**read-only** · MCP tool: `docs_search`

```text
cavelon docs search <query...> [options]
```

| Argument | Description |
|---|---|
| `query` | What to look for. Required. One or more. |

| Option | Description | MCP |
|---|---|---|
| `--limit <n>` | Return at most n pages (default 10). | yes |

### cavelon docs get

Print one docs page as markdown.

**read-only** · MCP tool: `docs_get`

```text
cavelon docs get <page> [options]
```

| Argument | Description |
|---|---|
| `page` | section/slug from `docs search`, a title, or the page URL. Required. |

| Option | Description | MCP |
|---|---|---|
| `--max-chars <n>` | Print at most n characters (default 40000). | yes |
| `--cursor <offset>` | Continue a long page where the previous output stopped. | yes |

## For agents

The command list and the MCP server. See [MCP server](mcp.md).

### cavelon commands

List every command, whether it is read-only, and its MCP tool.

**read-only** · MCP tool: none (run it in a terminal)

```text
cavelon commands
```

### cavelon mcp

Serve the commands as MCP tools on stdio (for coding agents).

**changing** · MCP tool: none (run it in a terminal)

```text
cavelon mcp
```

Started by the agent's plugin (`cavelon mcp`); it does not return until the agent disconnects.
