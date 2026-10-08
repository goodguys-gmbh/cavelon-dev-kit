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
- **Solution as code:** [`init`](#cavelon-init), [`pull`](#cavelon-pull), [`validate`](#cavelon-validate), [`fmt`](#cavelon-fmt), [`schema`](#cavelon-schema), [`apply`](#cavelon-apply), [`activate`](#cavelon-activate), [`explain`](#cavelon-explain)
- **Tenants and solutions:** [`tenant create`](#cavelon-tenant-create), [`tenant list`](#cavelon-tenant-list), [`harness list`](#cavelon-harness-list), [`harness new`](#cavelon-harness-new), [`harness clone`](#cavelon-harness-clone), [`harness default`](#cavelon-harness-default)
- **Knowledge, tests and traces:** [`kb upload`](#cavelon-kb-upload), [`test run`](#cavelon-test-run), [`wait`](#cavelon-wait), [`watch`](#cavelon-watch), [`trace`](#cavelon-trace)
- **Database connections and queries:** [`db instance`](#cavelon-db-instance), [`db connections`](#cavelon-db-connections), [`db queries`](#cavelon-db-queries), [`db runs`](#cavelon-db-runs), [`db test`](#cavelon-db-test), [`db test-run`](#cavelon-db-test-run)
- **Variables and secrets:** [`variables list`](#cavelon-variables-list), [`variables get`](#cavelon-variables-get), [`variables set`](#cavelon-variables-set), [`variables delete`](#cavelon-variables-delete), [`secrets list`](#cavelon-secrets-list), [`secrets set`](#cavelon-secrets-set), [`secrets delete`](#cavelon-secrets-delete)
- **Limits and capacity:** [`limits`](#cavelon-limits), [`limits set`](#cavelon-limits-set), [`models list`](#cavelon-models-list), [`models set-limit`](#cavelon-models-set-limit)
- **Loops and triggers:** [`loop start`](#cavelon-loop-start), [`loop watch`](#cavelon-loop-watch), [`loop iterations`](#cavelon-loop-iterations), [`loop pause`](#cavelon-loop-pause), [`loop resume`](#cavelon-loop-resume), [`loop cancel`](#cavelon-loop-cancel), [`trigger identity`](#cavelon-trigger-identity)
- **Sandboxes:** [`sandbox list`](#cavelon-sandbox-list), [`sandbox validate`](#cavelon-sandbox-validate), [`sandbox files`](#cavelon-sandbox-files), [`sandbox cat`](#cavelon-sandbox-cat), [`sandbox activity`](#cavelon-sandbox-activity), [`sandbox logs`](#cavelon-sandbox-logs), [`sandbox receipt`](#cavelon-sandbox-receipt), [`sandbox seed`](#cavelon-sandbox-seed), [`sandbox refresh`](#cavelon-sandbox-refresh), [`artifacts export`](#cavelon-artifacts-export)
- **API and docs:** [`api list`](#cavelon-api-list), [`api describe`](#cavelon-api-describe), [`api`](#cavelon-api), [`docs search`](#cavelon-docs-search), [`docs get`](#cavelon-docs-get)
- **For agents:** [`commands`](#cavelon-commands), [`mcp`](#cavelon-mcp)
- **Other commands:** [`deactivate`](#cavelon-deactivate), [`chat`](#cavelon-chat), [`db connections create`](#cavelon-db-connections-create), [`db connections update`](#cavelon-db-connections-update), [`db connections delete`](#cavelon-db-connections-delete), [`db connections ca`](#cavelon-db-connections-ca), [`db login-script`](#cavelon-db-login-script), [`db schema`](#cavelon-db-schema)

## Session

Set up your coding agents, log in, choose a tenant, and see where you are.

### cavelon setup

Set up your coding agents for Cavelon and log in, in one guided step.

**changing (destructive)** · MCP tool: none (run it in a terminal)

```text
cavelon setup [options]
```

Finds Claude Code, Codex, Cursor, VS Code with GitHub Copilot, Gemini CLI, Kiro, OpenCode and Pi, shows what it will change for each, asks once and does it: Claude Code and Codex get the Cavelon plugin through their own plugin command, Gemini CLI the extension of this release (or the files, when the release has none); the others get the `cavelon` MCP server in their user MCP configuration and the skills in their user skills folder. It touches nothing else in those files and records what it did, so --remove undoes exactly that. Then it logs in if needed, choosing the tenant by name as `login` does. The server starts as `cavelon mcp` when cavelon is installed, otherwise through npx. --check reports what is set up and working: each agent's entry, the MCP server starting, and the login. An agent found but never set up for Cavelon is reported and skipped (exit 0 when the rest works); --strict, or naming it with --agents, counts it. Without a terminal it changes nothing unless --yes.

| Option | Description |
|---|---|
| `--agents <list>` | Only these agents: claude, codex, cursor, copilot, gemini, kiro, opencode, pi, or all (comma-separated). Default: every agent found. Repeatable. |
| `-y, --yes` | Make the changes without asking. |
| `--check` | Report what is set up and working; change nothing. |
| `--strict` | With --check: fail for every agent found that is not set up, not only the ones setup set up. |
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

Asks for the token without echoing it, or reads it from standard input with --token-stdin. It is never an argument. Create a personal access token (cvpat_…) on /account/access-tokens; a tenant API key (cbp_…) also works. The token is kept in the operating system's credential store, or in a file only you can read. Without --tenant, login finds the tenants the token reaches: one is used; from several, a person chooses on a terminal by number or name; without a terminal the token is stored and login prints one `cavelon use` line per tenant (exit 2). An operator's token that reaches every tenant asks for part of the tenant's name to start in; Enter leaves the choice for later (`cavelon use`). --tenant takes the tenant's name, slug or id. An older instance that lists no tenants places the token itself, or needs --tenant &lt;tenant-id&gt;.

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

Shows needs_a_person and the optional needs_a_person_when separately. Conditional identity guidance leaves ordinary requests usable; an omitted list stays unknown.

### cavelon use

Choose the tenant this instance's commands act in.

**changing** · MCP tool: `use_tenant`

```text
cavelon use [tenant] [options]
```

Stored per instance for your user. CAVELON_TENANT, --tenant and a cavelon.yaml tenant take precedence over it. Without a tenant, it lists the tenants the token reaches: a person chooses one on a terminal by number or part of its name; without a terminal it prints one `cavelon use` line per tenant, and as an MCP tool it returns them as choices and changes nothing. As an MCP tool it never changes the tenant stored for your user: it chooses the tenant for that MCP session only, until the session ends or it is cleared, so an agent's choice never moves where your own commands go.

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

For the folder's solution, shows readiness and whether activation would take the default chat and widget route. An omitted route flag is unknown. Readiness reserves no route state; activation reports the actual effect.

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

Never overwrites a file it did not create. AGENTS.md, .gitignore and an existing CLAUDE.md get at most a block between cavelon:begin and cavelon:end markers. --agents also writes the skills to .agents/skills/ and .claude/skills/ and each named agent's `cavelon mcp` entry, for agents without the Cavelon plugin. --update changes only those marked blocks and the fallback files a previous init wrote. --from writes an existing package file (JSON or YAML export) into package/ and tests/ as `pull` writes an export, so validate and apply take it from there; it refuses to change or remove a package file that holds something else unless --force, and names the sections the instance's schema does not know. Without --from, a folder without package/manifest.yaml gets a minimal one (package format and tenant), which the first pull replaces.

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution (harness) this folder holds, by name, slug or id; its slug goes into cavelon.yaml. One that is not on the instance yet is created as a draft with that name, unless an existing solution's name is close to it: then init refuses, naming that one, and --new creates the new one. Without it, init asks on a terminal. | yes |
| `--new` | Create the solution --harness names as a new draft, even when an existing solution has a similar name (refused when one has that very name or slug). | yes |
| `--agents <list>` | Write the fallback for these agents: claude, codex, cursor, copilot, gemini, kiro, opencode, pi, other or all (comma-separated). Repeatable. | yes |
| `--hook` | Add a git pre-commit hook that runs `cavelon validate`; never in a hooks folder outside the repository. | yes |
| `--update` | Only bring the marked blocks and fallback files to this version. | yes |
| `--from <file>` | Write this package file (a JSON or YAML export) into package/ and tests/. | yes |
| `--force` | With --from: replace package files that hold something else. | yes |

Examples:

```bash
cavelon init
cavelon init --instance https://cavelon.example.com --tenant "Acme Support" --harness "Support FAQ"
cavelon init --tenant acme --harness "Support FAQ v2" --new
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

With a solution (--harness, or cavelon.yaml's harness), exports that solution; without one, the tenant's full configuration. A file whose content did not change keeps its bytes, so `git diff` shows what changed on the instance; a field the export spells out that the file leaves out (an empty list, a default) is no change. A test suite goes back to the file it was pulled into or applied from, whatever its name. Files of sections the schema does not know are kept byte for byte. A solution's pull leaves the tenant-wide sections (the tenant's settings, its model list) out of the folder, unless --include-tenant-wide; it says when the export carries none. Refuses when package files have uncommitted changes, unless --force; outside a git repository, when a file it would overwrite or remove changed since the last pull. A file as the last pull or apply left it (digests in .cavelon/) counts as unchanged, committed or not.

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution to export, by name, slug or id; its slug is recorded in cavelon.yaml when it names none. | yes |
| `--force` | Overwrite package files that have uncommitted changes since the last pull or apply. | yes |
| `--include-tenant-wide` | With a solution, also write the tenant-wide sections (tenant_settings, model_registry, …): asked of the export where the instance takes include_tenant_wide. Only `apply --include-tenant-wide` sends them back, for the whole tenant. Formerly `--tenant-wide`, still taken with a warning. | yes |

Examples:

```bash
cavelon pull --harness support
cavelon pull --include-tenant-wide
cavelon pull && git status --short -- package tests
```

### cavelon validate

Check the package files against the instance's package schema, offline.

**read-only** · MCP tool: `validate`

```text
cavelon validate [options]
```

Uses the schema and error catalog cached by init, pull or apply; fetches them only when none is cached or a development build's copy is past its time-to-live, and never with --offline. A development build keeps one version while its schema changes, so its copy is read again after a minute (CAVELON_CONTRACT_TTL_SECONDS), or checked with the ETag the instance sent with it; --verbose says which copy was used. Warns (never fails) when a fan-out or Map loop's max_concurrency is above the instance's branch width, and when the tenant runs fan-outs and Map loops in sequence, from the limits the instance last published for the tenant. References to skills, tools, knowledge bases, solutions and models outside the package are checked against the tenant's lists in .cavelon/inventory.json (pull, models list); a list no command has read yet is read now, unless --offline, and a check that cannot be made is named (`skipped` in --json). A reference that is in neither is a warning, as it may be created on the instance before the import; the import preview blocks it otherwise, so validate does not say "Valid" then, and --strict fails on every warning (exit 3). For write queries, reads connections now unless --offline and warns only on explicit allows_writes: false; an omitted flag or unreadable list stays unknown. Warns when a direct query node requires confirmation it cannot collect. Each finding carries a code: `cavelon explain <code>` says more. The import preview checks everything again on the server.

With --json, `warnings` is always a list of `{code, message}` objects: the warning findings (at most --limit), then the warnings about the run, such as a stale copy of the schema, with code null. `warning_count` counts them all and `error_count` the errors (`errors` is the same number); `findings` has each finding's file, line and hint; `blocking_count` counts the warnings the import preview blocks on.

| Option | Description | MCP |
|---|---|---|
| `--offline` | Never contact the instance, even when nothing is cached. | yes |
| `--limit <n>` | Print at most n findings (default 50). | yes |
| `--verbose` | Also say which copy of the package schema was used: cached or read now, when, and its hash. | yes |
| `--strict` | Fail (exit 3) on warnings too, such as a reference the import preview will block unless it exists by then. | yes |

### cavelon fmt

Bring the package files into the export's form (field order and defaults from the package schema), offline.

**changing** · MCP tool: `fmt`

```text
cavelon fmt [options]
```

A file whose value the export would spell differently is rewritten: each field in the schema's order, and each field it leaves out set to what the instance gives it, as the export writes it: the schema's default, an empty list or object for a list or object field without one. The instance applies the same values, so nothing changes in what apply sends but the spelling, with one exception: an entry of a list that leaves out an `..._order` field (sort_order, display_order, step_order) gets its position, so the instance keeps the written order instead of ordering entries that all carry the default its own way (test cases by name). Lists become block lists; the persona file shows every field, the unset ones as comments. Comments in a rewritten file are not kept, as pull does not keep them: fmt names each file whose comments it drops (with --check, would drop), so keep notes you need elsewhere first. A file already in that form keeps its bytes, and so do the files of sections the schema does not know. Run it after writing package files by hand and before `apply`, so the next `pull` shows only what changed on the instance. --check writes nothing and exits 3 when a file would change. Uses the cached package schema (as validate does); --offline never contacts the instance.

| Option | Description | MCP |
|---|---|---|
| `--check` | Write nothing; exit 3 when a file would change. | yes |
| `--offline` | Never contact the instance, even when no schema is cached. | yes |

Examples:

```bash
cavelon fmt
cavelon fmt --check
```

### cavelon schema

Show the package schema the instance publishes: its sections, or the fields of a section or a nested type, with a minimal example.

**read-only** · MCP tool: `package_schema`

```text
cavelon schema [section] [options]
```

Without an argument, lists the sections with the file each is kept in. With a section, lists its fields (type, required, allowed values, default) and prints the smallest entry that has every required field, ready to copy into the file, and an example with one entry of each nested list. A field whose entries have fields of their own is reached by its path (`agents.handoffs`, `test_suites.test_cases.steps`) or by its type's name (`PackageAgentHandoff`); the section's output names them. Where entries take one of several shapes (a step's evaluation_criteria: a text, a judge criterion, an assertion by type), each shape is listed with its fields. Placeholders are written &lt;field&gt;. Reads the schema as `validate` does: the cached copy first, the instance otherwise.

| Argument | Description |
|---|---|
| `section` | A section of the package (agents), a path to a nested field (agents.handoffs, test_suites.test_cases.steps), or a type name (PackageAgentHandoff). |

| Option | Description | MCP |
|---|---|---|
| `--offline` | Use only the cached schema; never contact the instance. | yes |

Examples:

```bash
cavelon schema
cavelon schema agents
cavelon schema agents.handoffs
cavelon schema test_suites.test_cases.steps.evaluation_criteria --json
```

### cavelon apply

Preview the package files against the instance and print a preview id; --confirm &lt;id&gt; imports exactly that preview.

**changing (destructive)** · MCP tool: `apply`

```text
cavelon apply [options]
```

Without --confirm nothing is imported: the preview shows what changes, which active solutions it reaches, what the target still needs (secrets and variables with the command that sets each, grants, runtime bindings, trigger identities), loop budgets and ignored sections, and is stored in .cavelon/. A preview never creates the solution: one the env file names that is not on the instance yet gets the `cavelon harness new` command that creates it as a draft. A person sets the secrets (`cavelon secrets set <name>`, or in the Admin where the instance lets no token set one), never the agent. Where the instance says this credential cannot import (needs_a_person), it still previews but prints no confirm command: a person imports in the Admin or with their own personal access token. --confirm refuses before sending (exit 5). Show a preview that reaches an active solution or env/prod to a person before confirming. Such a preview (show_to_person: tenant-wide sections, an active solution, deletions, env/prod, or database query writes) a coding agent cannot confirm. Over MCP the client asks the person; from an agent's shell the person runs the confirm in their own terminal. A stale preview exits 4 and imports nothing: one whose target changed on the instance since, one whose package files changed since (what they hold, not their formatting; --allow-stale imports what the preview showed anyway), and one older than a day. So does an import its own check refuses when it applies, naming each blocker. --discard &lt;id\|all&gt; forgets stored previews; `cavelon status` lists them with when each expires. A solution's import leaves the package's tenant-wide sections (tenant_settings, model_registry, …) out; --include-tenant-wide imports them, for every solution of the tenant. An instance that does not publish include_tenant_wide imports them with every solution's package, and apply says so.

| Option | Description | MCP |
|---|---|---|
| `--env <name>` | Use env/&lt;name&gt;.yaml: its tenant, solution and runtime bindings. | yes |
| `--harness <harness>` | The solution (harness): its name, slug or id; default: env file, then cavelon.yaml. | yes |
| `--confirm <preview-id>` | Import exactly this stored preview. | yes |
| `--allow-stale` | With --confirm: import what the preview showed although the package files changed since it. | yes |
| `--discard <preview-id|all>` | Forget this stored preview, or all of them; changes nothing on the instance. | yes |
| `--mode <mode>` | overwrite (default) or replace (deletes what the package does not hold). | yes |
| `--include-tenant-wide` | With a solution, also import the package's tenant-wide sections (tenant_settings, model_registry, …): they change for every solution of the tenant, so a person sees the preview first. Formerly `--tenant-wide`, still taken with a warning. | yes |

Examples:

```bash
cavelon apply --env test
cavelon apply --confirm <preview-id>
cavelon apply --env test --include-tenant-wide
cavelon apply --env prod --json
cavelon apply --discard all
```

### cavelon activate

Activate a solution through the readiness gate (never by force); says whether it is the tenant's default route.

**changing** · MCP tool: `activate`

```text
cavelon activate [options]
```

Only when every readiness check passes, and with a personal access token only when it was created with "may activate". Activating without the evidence stays a person's decision in the Admin. A solution that a channel or an active trigger reaches goes live for them at once, so its activation previews first and only the person's --confirm activates it. Activation that takes the default chat and widget route also needs their yes, including assigning an unassigned route. Unknown reach or route effects need their confirmation too. A solution nothing reaches activates without --confirm only when readiness explicitly says takes_default_route=false. Readiness previews the route effect without reserving state; the activation result reports what actually happened. Afterwards it says whether the solution is the tenant's default route (the one the tenant's chat and widget answer with where no solution is named). --make-default previews making it the default; with --confirm as well, it changes it. That changes live traffic: show the preview to a person and confirm only with their yes. `cavelon harness default` does the same for an active solution. A coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal.

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution (harness): its name, slug or id; default: env file, then cavelon.yaml. | yes |
| `--env <name>` | Use env/&lt;name&gt;.yaml: its tenant, solution and runtime bindings. | yes |
| `--make-default` | Also make it the tenant's default route: previews the change; with --confirm, makes it. | yes |
| `--confirm [<token>]` | With --make-default: the person's yes to change the default route; otherwise, to activate when reach or the activation's route effect is true or unknown. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

Examples:

```bash
cavelon activate
cavelon activate --confirm
cavelon activate --make-default
cavelon activate --make-default --confirm
cavelon activate --make-default --confirm <token>
```

### cavelon explain

Look a code up in the instance's error catalog: what it means and how to fix it.

**read-only** · MCP tool: `explain`

```text
cavelon explain <code>
```

Rule codes come from the package and graph checks, API error codes from failed requests; cavelon's own codes (validate's findings, and errors the CLI raises itself, such as operation_not_found or uncommitted_changes) are known too. Uses the cached catalog first. Where the instance's fix names an API route, the command that does the same is added. An unknown code gets the closest known ones (a typo away, the same start). Also explains the test-case statuses that are neither pass nor fail: calibration_required, pending_review, not_run, not_evaluated, skip; and the values of a retrieval span's knowledge_outcome (usable_evidence, content_gap, unusable_hits, retrieval_fault, deliberately_unanswerable, no_usable_evidence), from the instance's catalog (area knowledge_outcome) where it lists them.

| Argument | Description |
|---|---|
| `code` | The code, e.g. from `cavelon validate` or an error's code, or a test-case status. Required. |

## Tenants and solutions

Create and list tenants and solutions (harnesses).

### cavelon tenant create

Create a tenant (personal access token in Platform mode with tenants.manage); previews first, --confirm creates it.

**changing** · MCP tool: `tenant_create`

```text
cavelon tenant create <slug> [options]
```

A tenant API key never can. Before sending, the token is checked: one that may not enter Platform mode, or enters it without tenants.manage, is refused with exit 7 and nothing is sent. Without --confirm nothing is created: the preview names the tenant, its plan and the instance it would be created on. A tenant is a platform change, so show the preview to a person and confirm only with their yes. With --use, the new tenant is chosen only once the instance confirms the token acts in it. Inviting people and assigning roles stay in the Admin. A coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal.

| Argument | Description |
|---|---|
| `slug` | Lower-case letters, digits and dashes. Required. |

| Option | Description | MCP |
|---|---|---|
| `--name <name>` | Display name (default: the slug). | yes |
| `--plan <plan>` | Licence plan, when the instance knows several. | yes |
| `--use` | Switch to the new tenant afterwards (`cavelon use`), once the token is known to act in it. | yes |
| `--idempotency-key <key>` | Send an Idempotency-Key, so a retry does not create a second one. | yes |
| `--confirm [<token>]` | Create the tenant (after a person saw the preview). In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

Examples:

```bash
cavelon tenant create newco --name NewCo
cavelon tenant create newco --name NewCo --confirm
```

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

List the tenant's solutions (harnesses), marking the default route.

**read-only** · MCP tool: `harness_list`

```text
cavelon harness list [options]
```

DEFAULT marks the tenant's default route: the solution that answers where a conversation names none (the tenant's chat and widget). An instance that does not say which one it is leaves the column out; `is_default` in --json is null then.

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

### cavelon harness default

Make a solution the tenant's default route; previews first, --confirm changes it.

**changing** · MCP tool: `harness_default`

```text
cavelon harness default [solution] [options]
```

The default route is the solution that answers where a conversation names none: the tenant's chat and widget. A new tenant's default is an empty `default` solution, so a solution built beside it answers nobody there until it becomes the default. Without --confirm nothing changes: the preview names the current default and the one that would replace it. This changes live traffic, so show the preview to a person and confirm only with their yes. `is_default` in harnesses.yaml is not applied by `apply`; this is the way to set it. A coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal.

| Argument | Description |
|---|---|
| `solution` | Name, slug or id of the solution; default: cavelon.yaml's harness. |

| Option | Description | MCP |
|---|---|---|
| `--confirm [<token>]` | Change the default route (after a person saw the preview). In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

Examples:

```bash
cavelon harness default support
cavelon harness default support --confirm
```

## Knowledge, tests and traces

Seed knowledge bases, run test suites, wait for the work and read what happened.

### cavelon kb upload

Upload a folder's documents into a knowledge base; returns operation ids.

**changing** · MCP tool: `kb_upload`

```text
cavelon kb upload <dir> [options]
```

Hidden files are skipped. Ingestion runs on the instance; `cavelon wait` follows it. Files are checked against the instance's published upload limits first. A .zip goes only to a tenant that expands archives, and only within its caps on file count, unpacked size and compression ratio. A file named like an active document of the knowledge base is listed, with what happens to that document. An instance that replaces same-named documents on upload does so (--keep-both keeps both); elsewhere the old one stays active. --replace replaces it: through the instance's own replacement where its upload offers one, else the kit deactivates the old document after the upload (after the wait with --wait), and then only with --confirm. --dry-run also names each file identical to an active document, which the upload would not create again, where the instance publishes its documents' file hashes.

| Argument | Description |
|---|---|
| `dir` | Folder (or single file) to upload. Required. |

| Option | Description | MCP |
|---|---|---|
| `--kb <kb>` | Knowledge base name or id (required). | yes |
| `-r, --recursive` | Include subfolders. | yes |
| `--ext <ext>` | Only these file extensions (pdf, md, …). Repeatable. | yes |
| `--replace` | Replace active documents with the same file name. | yes |
| `--keep-both` | Keep active documents with the same file name next to the new ones. | yes |
| `--confirm [<token>]` | With --replace, deactivate the old documents the instance does not replace itself; without it nothing is sent. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |
| `--dry-run` | List what would be uploaded, replaced and found identical; upload nothing. | yes |
| `--wait` | Wait for the work to finish (see `cavelon wait`). | CLI only |
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |

Examples:

```bash
cavelon kb upload ./docs --kb FAQ
cavelon kb upload ./docs/bergbahn-faq.md --kb FAQ --replace --dry-run
cavelon kb upload ./manuals --kb FAQ -r --ext pdf --wait --timeout 5m
```

### cavelon test run

Start test-suite runs; returns operation ids.

**changing** · MCP tool: `test_run`

```text
cavelon test run [options]
```

Without --suite, runs every suite of the solution (--harness, or cavelon.yaml's harness). With --wait, exits 1 when a case failed or a run measured nothing comparable (cases not run, technical errors), 5 when answers wait for a manual verdict or a value a case needs. --as-chat-user chooses a Chat User reader for these runs only, for knowledge and identity-bound database queries; it never edits a saved suite. Without the option, uses each suite's saved reader. Choose an id with `cavelon api list_chat_users -p tenant_id=<tenant_id>`; check email_verified for email-bound queries. Where the instance publishes the matching needs_a_person_when restriction, an API key cannot choose this reader (exit 5, nothing sent): a person chooses it in the Admin or with their personal access token. A key can still run a suite whose reader a person saved. Older instances that omit the restriction leave the decision to the server.

| Option | Description | MCP |
|---|---|---|
| `--suite <suite>` | Suite name or id. Repeatable. | yes |
| `--harness <harness>` | The solution to run against: its name, slug or id. | yes |
| `--as-chat-user <id>` | Read knowledge and identity-bound queries as this tenant's Chat User; needs knowledge_bases.view and end_users.read. | yes |
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

Exit 0 when all succeeded, 1 when one failed or was cancelled, 5 when one needs a person, 6 when one still runs at the end (timed_out says whether it waited the whole timeout; --timeout 0 reads the state once). A test run that finished with failed cases counts as failed, and its cases are named. The state is printed in every case with waited_ms, and a second `wait` resumes. As the MCP tool operation_status it returns the state at once unless given a timeout, and waits at most 50 s.

| Argument | Description |
|---|---|
| `operation` | Operation ids (op_…). Required. One or more. |

| Option | Description | MCP |
|---|---|---|
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. As an MCP tool: none by default (returns at once), at most 50s. | yes |

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

## Database connections and queries

Read what the instance offers for database connections, and the connections, saved queries and query runs behind a solution's database query tools; the tenant Owner also tests a connection and test-runs a query. A superadmin creates and changes them in the Admin.

### cavelon db instance

What this instance offers for database connections: dialects, firewall addresses and write-query support where published.

**read-only** · MCP tool: `db_instance`

```text
cavelon db instance
```

Read it before a database connection is set up: a connection of a dialect the instance does not run can be saved, but its test and queries answer unavailable, and the customer's database must let the instance's egress addresses in. An instance older than this route says only its dialects, in its capabilities.

Examples:

```bash
cavelon db instance
cavelon db instance --json
```

### cavelon db connections

The tenant's database connections: dialect, target, TLS mode, CA certificates, last test and query count; never a password.

**read-only** · MCP tool: `db_connections`

```text
cavelon db connections [options]
```

A token holding database_connectors.manage creates and changes connections; a person sets the password in the Admin. allows_writes, when published, is read-only here: enabling writes remains a dashboard action. A package names a connection by name and dialect, so the same name serves in every tenant and environment. A query tool is ready for agents only while its connection is enabled and its last test passed; the tenant Owner runs the test with `cavelon db test <connection>`. It warns of a CA certificate that has expired or expires within 30 days.

| Option | Description | MCP |
|---|---|---|
| `--limit <n>` | Return at most n connections (default 50). | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon db connections
cavelon db connections --json
```

### cavelon db queries

The tenant's saved database queries by tool slug; with a query, its SQL, parameters and limits.

**read-only** · MCP tool: `db_queries`

```text
cavelon db queries [query] [options]
```

Each saved query is one agent tool (tool_type database_query). The tenant Owner or a superadmin in Tenant mode writes it with database_connectors.manage: in the Admin or through apply with a personal access token and the person's approval. `cavelon pull` writes its definition into the package's tools. A parameter filled by end_user.* comes from the signed-in visitor, never from the model. Where published, kind is read or write; write settings are max_affected_rows, requires_confirmation and max_calls. Without a query: one line per query. With one (its tool's slug or the query's id): the whole query.

| Argument | Description |
|---|---|
| `query` | A query's tool slug or id: show it in full. |

| Option | Description | MCP |
|---|---|---|
| `--connection <connection>` | Only the queries of this connection (name or id). | yes |
| `--limit <n>` | Return at most n queries (default 50). | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon db queries
cavelon db queries --connection shop-db
cavelon db queries order_status --json
```

### cavelon db runs

A saved query's runs: outcome, counts and published write evidence (kind, affected_rows, committed, dry_run); never values or rows.

**read-only** · MCP tool: `db_runs`

```text
cavelon db runs <query> [options]
```

Every run leaves this evidence, an agent's call and a test run alike; the instance keeps no parameter value, row or SQL. `cavelon explain <code>` says what an error code means and how to fix it.

| Argument | Description |
|---|---|
| `query` | The query's tool slug or id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--limit <n>` | Return at most n runs (default 20, at most 200). | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon db runs order_status
cavelon db runs order_status --limit 50 --json
```

### cavelon db test

Test a database connection step by step (DNS, policy, TCP, TLS, login, SELECT 1, version, write privileges); exit 3 when a step fails.

**changing** · MCP tool: `db_test`

```text
cavelon db test <connection>
```

Needs the tenant Owner's permission (database_connectors.test). The result becomes the connection's last test: a query tool is ready for agents only while it passed, and a package's query needs a tested connection of its name to import. A failed step names its code; `cavelon explain <code>` says how to fix it. A finding under write_privileges means the database user can write: ask the database administrator for a read-only user. On SQL Server, which has no read-only transaction, the connection's queries then do not run (write_privileges_unacknowledged) until its login may only read or a superadmin acknowledges the write privileges in the Admin; a stored-procedure query (EXEC) runs only on a login the test found without write privileges, acknowledged or not. A passing test on SQL Server also reads again the procedure each stored-procedure query calls, and lists those that no longer pass the instance's check (procedure_findings); they stay as they are, and their next save or enable is refused until the procedure only reads again.

| Argument | Description |
|---|---|
| `connection` | The connection's name or id. Required. |

Examples:

```bash
cavelon db test shop-db
cavelon db test shop-db --json
```

### cavelon db test-run

Run a saved query once with the values given, identity parameters included; show what the model would see and the rows.

**changing** · MCP tool: `db_test_run`

```text
cavelon db test-run <query> [options]
```

Needs the tenant Owner's permission (database_connectors.test); it reads the customer's own data. Give each parameter with --value name=value, those the platform fills from the signed-in visitor (end_user.*) too: that is how an identity-scoped query is checked for one customer. The instance records the run (counts only) and audits it with your name. Where the instance publishes the matching needs_a_person_when restriction, the kit refuses an API key on an end_user.* query before sending (exit 5): a person tests it in the Admin or with their personal access token. Ordinary queries remain usable with an API key. On an older instance that omits the restriction, the server decides. The rows come back once and are never stored. A failed run names its code; `cavelon explain <code>` says more. A write query's test is a dry run that rolls back; it still needs the connection to allow writes. The result reports kind, dry_run, rolled_back, affected_rows and committed only where published; an omitted value stays unknown. Never retry an ambiguous write outcome. A read stored-procedure query (SQL Server) shows the procedure's first result set; the instance refuses its run (exit 4) while the connection's last test found write privileges or the procedure's definition writes or cannot be read, and a run whose procedure ended the connector's transaction comes back with a notice saying so and whether the query was switched off.

| Argument | Description |
|---|---|
| `query` | The query's tool slug or id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--value <name=value>` | One parameter's value, typed as the parameter's type. Repeatable. | yes |
| `--rows <n>` | Show at most n rows in the text (default 20); --json carries what the instance returned. | yes |

Examples:

```bash
cavelon db test-run order_status --value order_no=A-10023 --value email=ada@example.com
cavelon db test-run stock --value sku=4711 --json
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

Create a tenant variable, or replace one (previews first, --confirm replaces it).

**changing** · MCP tool: `variables_set`

```text
cavelon variables set <name> [value] [options]
```

The value is plain text that anyone who may view the tenant's settings reads; never put a credential into a variable, use `cavelon secrets set` (a person runs it). --stdin reads the value from standard input instead of the argument. A new variable is created at once. Replacing another value needs --confirm: without it nothing changes, and the preview shows the old and the new value. A variable is tenant-wide, so every solution that names it, active ones included, reads the new value: show the preview to a person and confirm only with their yes. A coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal.

| Argument | Description |
|---|---|
| `name` | The variable's name, as {{var:&lt;name&gt;}} uses it. Required. |
| `value` | The value (plain text, not a credential). |

| Option | Description | MCP |
|---|---|---|
| `--stdin` | Read the value from standard input. | CLI only |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. | yes |
| `--confirm [<token>]` | Replace an existing value (after a person saw the preview); a new variable needs none. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

Examples:

```bash
cavelon variables set crm_base_url https://crm.example.com
cavelon variables set greeting --stdin < greeting.txt
cavelon variables set crm_base_url https://crm2.example.com --confirm
cavelon variables set crm_base_url https://crm2.example.com --confirm <token>
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
| `--confirm [<token>]` | Delete it; without this nothing is deleted. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). |
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

Lists every secret that has a value or that an imported package declared, and in a solution folder the ones its package declares that the tenant does not know yet. A person sets a missing one with `cavelon secrets set <name>`, or in the Admin under Settings › Secrets where the instance lets no token set one; an agent never sets or reads a secret value.

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

Asks for the value without echoing it, or reads it from standard input when that is piped (one trailing line break is dropped). The value is never an argument, never printed and never read back. A tenant API key cannot set a secret, nor can a role the instance does not allow to manage secrets (a Builder): its refusal then names who can, a tenant Owner. An instance that lets only a person signed in to the Admin set a secret (its /meta/principal lists the operation in needs_a_person) refuses every token; there it is refused before it reads a value, naming the Admin page. Run by a coding agent in its shell, it is refused before it reads a value (operation_for_a_person).

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

Without --confirm, shows the secret's status and deletes nothing. A tool or prompt that names it fails until a person sets it again. A tenant API key cannot delete a secret, nor can any token on an instance that lets only a person signed in to the Admin do it (secret_needs_a_person). Run by a coding agent in its shell, it is refused, with or without --confirm (operation_for_a_person).

| Argument | Description |
|---|---|
| `name` | The secret's name. Required. |

| Option | Description |
|---|---|
| `--confirm [<token>]` | Delete it; without this nothing is deleted. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). |
| `--env <name>` | Act in the tenant that env/&lt;name&gt;.yaml names. |

Examples:

```bash
cavelon secrets delete old_token
cavelon secrets delete old_token --confirm
cavelon secrets delete old_token --confirm <token>
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

Reads the limit's published change (operation, body field, bounds, permissions, roles) and checks the value against it before sending. Without --confirm, shows the old and new value, the operation and who may run it, and changes nothing. Also changes the tenant quotas in tenant_quotas.changes (the inference budget, the monthly Processing Step cap). An operator's change (a run cap) is sent only with a personal access token in Platform mode of a role it names, without X-Tenant-Id; --tenant &lt;id\|slug&gt; then sets one tenant's own run cap. An environment or licence limit, a value out of bounds, an instance that does not publish how to change the limit, and a credential without the permission or the role are refused before anything is sent. Propose the change to the person; never raise a limit on your own. A coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal.

| Argument | Description |
|---|---|
| `key` | The limit's key, as `cavelon limits` lists it (e.g. kb_upload_max_file_size_mb). Required. |
| `value` | The new value in the limit's unit (50 or 50MB), a comma-separated list of file types, true/false, or none to clear the tenant's own value. Required. |

| Option | Description | MCP |
|---|---|---|
| `--confirm [<token>]` | Change it; without this nothing is changed. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |
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

Sets the row's max_concurrent_requests to &lt;n&gt;, or clears it with none. Without --confirm, shows the old and new value and changes nothing. A row without a base_url is refused before anything is sent: it reaches its provider through the platform's routes, which have their own limits. Every row with the same base_url shares the count. Propose a value to the person and let them decide; the instance's capacity tutorial says how to find it. A coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal.

| Argument | Description |
|---|---|
| `model` | The row's model_id, id or display name (`cavelon models list`). Required. |
| `limit` | Requests the endpoint serves at once (a whole number), or none to clear the limit. Required. |

| Option | Description | MCP |
|---|---|---|
| `--confirm [<token>]` | Change it; without this nothing is changed. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |
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

Start a loop through its trigger, as you; previews first, --confirm starts it and returns the run and operation ids.

**changing** · MCP tool: `loop_start`

```text
cavelon loop start <trigger> [options]
```

Calls the trigger's run-now route. The run (and its loop) acts as the caller: with a personal access token, the person. It runs on its own and spends the tenant's model budget, so without --confirm nothing starts: the preview names the trigger, its solution and the payload. Show it to a person and confirm only with their yes. For a trigger of a draft solution an agent confirms with the preview's token (--confirm &lt;token&gt;, or confirm over MCP); for any other, a coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal. Follow the run with `loop watch <run>`, or `wait <operation>`; `loop cancel <run>` stops it.

| Argument | Description |
|---|---|
| `trigger` | Trigger slug, name or id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--input <json|@file|->` | The run's payload: JSON, @file.json or - for stdin. | yes |
| `--wait` | Wait for the run to finish (see `cavelon wait`). | CLI only |
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |
| `--idempotency-key <uuid>` | The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice. | yes |
| `--confirm [<token>]` | Start the run (after a person saw the preview). In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

Examples:

```bash
cavelon loop start counter
cavelon loop start counter --confirm
cavelon loop start counter --confirm <token>
cavelon loop start orders --input @orders-request.json --confirm --json
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
| `--confirm [<token>]` | Stop the run; without it nothing is stopped. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

Examples:

```bash
cavelon loop cancel <run>
cavelon loop cancel <run> --confirm
cavelon loop cancel <run> --confirm <token>
```

### cavelon trigger identity

Show, bind or clear the API key a trigger's unattended runs act as (binding needs --confirm).

**changing (destructive)** · MCP tool: `trigger_identity`

```text
cavelon trigger identity <trigger> [key] [options]
```

Without &lt;key&gt; or --clear, shows the binding. Binding gives the trigger standing authority, so it is never part of `apply`: show the person, then run it with --confirm. It needs settings.manage and triggers.manage. Creating keys and Sandbox Access stay in the Admin. A personal access token is never an execution identity. A coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal.

| Argument | Description |
|---|---|
| `trigger` | Trigger slug, name or id. Required. |
| `key` | The API key's name or id (never its value). |

| Option | Description | MCP |
|---|---|---|
| `--clear` | Remove the binding; scheduled and webhook runs then cannot start. | yes |
| `--confirm [<token>]` | Make the change; without it nothing changes. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

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
| `--confirm [<token>]` | Send it; without it nothing changes. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |
| `--wait` | Wait for the job to finish (see `cavelon wait`). | CLI only |
| `--timeout <duration>` | Stop waiting after this long (90s, 5m; default 90s). The work goes on; run wait again to resume. | yes |
| `--idempotency-key <uuid>` | The Idempotency-Key to send (a UUID), so a retry of the same call does nothing twice. | yes |

Examples:

```bash
cavelon sandbox seed orders-test seeds/orders
cavelon sandbox seed orders-test seeds/orders --confirm --wait
cavelon sandbox seed orders-test seeds/orders --confirm <token> --wait
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

Shows needs_a_person_when separately from unconditional access restrictions; --usable keeps operations with conditional identity cases available for ordinary requests.

| Option | Description | MCP |
|---|---|---|
| `--tag <tag>` | Only operations with this OpenAPI tag. | yes |
| `--search <text>` | Only operations whose name, path or summary contains the text. | yes |
| `--method <method>` | Only this HTTP method (GET, POST, …). | yes |
| `--tags` | List the tags with their operation counts instead. | yes |
| `--limit <n>` | Return at most n operations (default 50, 0 for all). | yes |
| `--usable` | Leave out the operations the instance says this credential may not send. | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

### cavelon api describe

Show one operation's parameters, body and responses.

**read-only** · MCP tool: `api_describe`

```text
cavelon api describe <operation>
```

Shows the credential's published needs_a_person_when as advisory guidance. Its reason describes the condition; it does not refuse an ordinary request.

| Argument | Description |
|---|---|
| `operation` | operationId or its short name. Required. |

### cavelon api

Call any operation the instance publishes in its OpenAPI.

**changing (destructive)** · MCP tool: `api`

```text
cavelon api <operation> [params...] [options]
```

The operation is its operationId or the short name before FastAPI's path suffix (list_harnesses). Parameters: -p name=value or name=value (not --name). Body: --body '&lt;json&gt;', --body @file.json or --body - (stdin); --json &lt;body&gt; still works for now but is deprecated: --json alone prints JSON, as on every command. The body is checked against the operation's schema before it is sent. As an MCP tool, or run by a coding agent (CLAUDECODE, CODEX_THREAD_ID, CODEX_CI, CODEX_SANDBOX, CURSOR_AGENT, GEMINI_CLI, COPILOT_CLI, COPILOT_AGENT, AGENT_CONTEXT_OUT, TERM_PROGRAM=kiro, OPENCODE, PI_SESSION_ID, GROK_AGENT, AI_AGENT or CAVELON_AGENT=1 is set), an operation that changes something returns what it would send and a confirm token, and sends it only with that token and the person's yes: as an MCP tool, confirm: "&lt;token&gt;", after which the client asks the person; from an agent's shell, the person sends it from their own terminal. A changed request needs a new preview; confirm: true is refused. Run by an agent, one the instance marks for a person only (x-cavelon-person-only) is refused, as is a body that sets a field the instance marks as a secret value (x-cavelon-secret) and a file outside the solution folder. On an instance that marks no operation, one that changes a secret, creates or revokes a credential or decides an approval is refused. A person's own terminal sends at once. In a solution folder, the persona operations (get_bot_persona, upsert_bot_persona, …) get the folder's solution as harness_id when none is passed, since without it they reach the tenant's default route.

| Argument | Description |
|---|---|
| `operation` | operationId or its short name. Required. |
| `params` | Parameters as name=value. One or more. |

| Option | Description | MCP |
|---|---|---|
| `-p, --param <name=value>` | A path, query or header parameter. Repeatable. | yes |
| `--body <json|@file|->` | The request body: JSON, @file.json or - for stdin (--json &lt;body&gt; is a deprecated alias). | yes |
| `--file <field=path>` | Attach a file to a multipart body. Repeatable. | yes |
| `--output <file>` | Write the response body to a file instead of printing it. | CLI only |
| `--confirm <token>` | Send an operation that changes something: run by a coding agent or as an MCP tool, the token its preview returned. Without it, nothing is sent. A person's terminal sends at once. | yes |
| `--limit <n>` | Show at most n items of a list response (default 50, 0 for all). | yes |

Examples:

```bash
cavelon api list_harnesses
cavelon api get_harness_by_slug slug=support
cavelon api create_knowledge_base --body '{"name": "FAQ"}'
```

### cavelon docs search

Search this instance's docs (titles and summaries).

**read-only** · MCP tool: `docs_search`

```text
cavelon docs search <query...> [options]
```

Ranks the pages of the instance's docs index by the words of the question in their titles, addresses and summaries, rare words counting more than common ones. Stop words (English and German) are ignored, words match whole ("test" finds "testing", not "latest"), and German words for the core concepts are looked up in English (Wissensbasis: knowledge base). Only pages that match well are listed.

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
| `page` | section/slug from `docs search`, a title, the page URL, or `index` for the list of all pages. Required. |

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

## Other commands

### cavelon deactivate

Take an active solution out of service (status inactive); previews first, --confirm deactivates.

**changing (destructive)** · MCP tool: `deactivate`

```text
cavelon deactivate [options]
```

An active solution answers live traffic: the conversations, channels and API keys that name it. Deactivating sets its status to inactive, not back to draft (a draft has not been activated yet; an inactive solution was taken out of service). It keeps its configuration and answers no live traffic until it is activated again (`cavelon activate`, through its readiness gate). Without --confirm nothing changes: the preview says what would stop. Show it to a person and confirm only with their yes. The tenant's default route is refused before anything is sent: make another solution the default first (`cavelon harness default <solution>`). An instance that publishes no deactivate route is said so; a person deactivates in the Admin there. A coding agent cannot confirm it: over MCP the client asks the person, and from an agent's shell the person runs the confirm in their own terminal.

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution (harness): its name, slug or id; default: env file, then cavelon.yaml. | yes |
| `--env <name>` | Use env/&lt;name&gt;.yaml: its tenant and solution. | yes |
| `--confirm [<token>]` | Deactivate it (after a person saw the preview). In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

Examples:

```bash
cavelon deactivate --harness support-faq
cavelon deactivate --harness support-faq --confirm
cavelon deactivate --harness support-faq --confirm <token>
```

### cavelon chat

Send one message to a solution and print its answer, with the session to continue and the conversation to trace.

**changing** · MCP tool: `chat`

```text
cavelon chat <message> [options]
```

The tenant's chat and widget answer only with the default route; this names the solution, so an active solution that is not the default, or a draft, can be tried before it answers anyone. A draft answers a person's token as a Playground run (counted as testing), never a tenant API key. Without --harness: the env file's or cavelon.yaml's solution, else the tenant's default route. Each call is one turn; --session continues a conversation. Not streamed: waits for the whole answer, at most --timeout (default 2m; 50 s as an MCP tool). --as-chat-user reads knowledge and binds database query identity as that Chat User, with a personal access token. Choose an id with `cavelon api list_chat_users -p tenant_id=<tenant_id>`; email_verified says whether an email-bound query can bind that address. Without the option, keeps the usual reader.

| Argument | Description |
|---|---|
| `message` | What the user says. Required. |

| Option | Description | MCP |
|---|---|---|
| `--harness <harness>` | The solution (harness): its name, slug or id; default: env file, then cavelon.yaml. | yes |
| `--env <name>` | Use env/&lt;name&gt;.yaml: its tenant and solution. | yes |
| `--session <session_id>` | Continue this conversation (the session_id a previous chat printed). | yes |
| `--as-chat-user <id>` | Read knowledge and identity-bound queries as this tenant's Chat User; needs knowledge_bases.view and end_users.read. | yes |
| `--timeout <duration>` | Wait at most this long for the answer (90s, 5m; default 2m). | yes |

Examples:

```bash
cavelon chat "When are you open?" --harness support-faq
cavelon chat "And on Saturdays?" --session <session_id>
cavelon chat "Hello" --json
```

### cavelon db connections create

Create a connection without a password (database_connectors.manage); print the Admin password step.

**changing** · MCP tool: `db_connection_create`

```text
cavelon db connections create <name> [options]
```

The tenant Owner (legacy Admin), or a superadmin in Tenant mode, creates it with a personal access token. Fields and defaults come from this instance's OpenAPI. No password argument, environment value, stdin or file is read. A person sets the password in Settings › Security & access › Databases before testing. Connections stay outside packages.

| Argument | Description |
|---|---|
| `name` | Connection name, the same in every environment that uses the package. Required. |

| Option | Description | MCP |
|---|---|---|
| `--dialect <dialect>` | Database type, checked against this instance's published create/update schema. | yes |
| `--host <host>` | One DNS name or IP address, without port, path or user. | yes |
| `--port <port>` | Database port; required on create (the instance validates its bounds). | yes |
| `--database-name <name>` | Database name on this server. | yes |
| `--username <name>` | Database login name; its password is set only in the Admin. | yes |
| `--tls-mode <mode>` | TLS mode, checked against the published schema; omitted on create uses the instance's default. | yes |
| `--statement-timeout-ms <ms>` | Statement timeout in milliseconds, within the instance's bounds. | yes |
| `--enabled <true|false>` | Enable or disable the connection (true or false); omitted leaves the instance's default or current value. | yes |

Examples:

```bash
cavelon db connections create shop-db --dialect postgresql --host db.example.com --port 5432 --database-name shop --username cavelon_reader
```

### cavelon db connections update

Change only given public connection fields (database_connectors.manage); never a password or allows_writes.

**changing** · MCP tool: `db_connection_update`

```text
cavelon db connections update <connection> [options]
```

A person must move a password-bearing connection to another host, port or dialect in the Admin with its password. The instance refuses that change from the kit; an uncredentialed connection moves freely. Test again after changing it. Enabling writes and acknowledging write privileges remain dashboard actions and never enter a package.

| Argument | Description |
|---|---|
| `connection` | Connection name or id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--name <name>` | New connection name. | yes |
| `--dialect <dialect>` | Database type, checked against this instance's published create/update schema. | yes |
| `--host <host>` | One DNS name or IP address, without port, path or user. | yes |
| `--port <port>` | Database port; required on create (the instance validates its bounds). | yes |
| `--database-name <name>` | Database name on this server. | yes |
| `--username <name>` | Database login name; its password is set only in the Admin. | yes |
| `--tls-mode <mode>` | TLS mode, checked against the published schema; omitted on create uses the instance's default. | yes |
| `--statement-timeout-ms <ms>` | Statement timeout in milliseconds, within the instance's bounds. | yes |
| `--enabled <true|false>` | Enable or disable the connection (true or false); omitted leaves the instance's default or current value. | yes |

Examples:

```bash
cavelon db connections update shop-db --statement-timeout-ms 3000
cavelon db connections update shop-db --enabled false
```

### cavelon db connections delete

Delete an unused connection (database_connectors.manage); previews first, --confirm deletes it.

**changing (destructive)** · MCP tool: `db_connection_delete`

```text
cavelon db connections delete <connection> [options]
```

Without --confirm nothing is deleted. The instance refuses deletion while queries still use the connection.

| Argument | Description |
|---|---|
| `connection` | Connection name or id. Required. |

| Option | Description | MCP |
|---|---|---|
| `--confirm [<token>]` | Delete the previewed connection. In a person's terminal the flag alone confirms; run by a coding agent, `--confirm <token>` with the token its preview printed (the bare flag only shows the preview there, exit 5). | yes |

Examples:

```bash
cavelon db connections delete unused-db
cavelon db connections delete unused-db --confirm
```

### cavelon db connections ca

Upload a public CA certificate bundle (database_connectors.manage); refuse private keys before sending.

**changing** · MCP tool: `db_connection_ca`

```text
cavelon db connections ca <connection> <file>
```

The file must contain only valid PEM CERTIFICATE blocks. It is bounded by the instance's published CA limit. The output keeps certificate metadata and fingerprints, never the PEM. Test the connection again after uploading it.

| Argument | Description |
|---|---|
| `connection` | Connection name or id. Required. |
| `file` | Public PEM certificate file, never a private key. Required. |

Examples:

```bash
cavelon db connections ca shop-db ./public-ca.pem
```

### cavelon db login-script

Print the instance's published read-only login SQL for a dialect or saved connection; no database is contacted.

**read-only** · MCP tool: `db_login_script`

```text
cavelon db login-script [dialect] [options]
```

Needs database_connectors.view. The DBA replaces the script's password placeholder locally, outside the kit. Only variants this instance publishes are offered; this build publishes read_only. Omitted inputs use its defaults. For SQL Server, connection_limit_enforced is false; --schema scopes SELECT instead of granting db_datareader.

| Argument | Description |
|---|---|
| `dialect` | Database dialect; omit only with --connection. |

| Option | Description | MCP |
|---|---|---|
| `--connection <connection>` | Use dialect, database, user and TLS from this saved connection (name or id). | yes |
| `--database-name <name>` | Database the login may read (without --connection). | yes |
| `--username <name>` | Database login name (without --connection). | yes |
| `--schema <name>` | Schema the read grants cover. | yes |
| `--egress-ip <ip>` | Outbound IP address; omitted uses the instance's configured addresses. Repeatable. | yes |
| `--connection-limit <n>` | Connections to allow; omitted uses the instance's pool size times four. | yes |
| `--require-tls <true|false>` | MySQL REQUIRE SSL (true or false, without --connection). | yes |

Examples:

```bash
cavelon db login-script postgresql --database-name shop --username cavelon_reader
cavelon db login-script --connection shop-db --schema public
```

### cavelon db schema

Explore readable schemas or one schema's tables and columns (database_connectors.manage); read-only.

**read-only** · MCP tool: `db_schema`

```text
cavelon db schema <connection> [schema] [options]
```

Reads only the database catalog, under the connection's timeout and read-only boundary. The instance records counts in its audit log. It caps schemas/tables at 500 and columns at 2,000; truncated flags say what was cut. Only the tenant Owner (legacy Admin) or a superadmin in Tenant mode may explore, using a session or personal access token.

| Argument | Description |
|---|---|
| `connection` | Connection name or id. Required. |
| `schema` | Schema to inspect; omitted lists schemas. |

| Option | Description | MCP |
|---|---|---|
| `--limit <n>` | Return at most n schemas or tables (default 50, maximum 500). | yes |
| `--cursor <cursor>` | Continue after the previous page (its next_cursor). | yes |

Examples:

```bash
cavelon db schema shop-db
cavelon db schema shop-db public --json
```
