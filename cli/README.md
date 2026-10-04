# `cavelon`: the Cavelon CLI and MCP server

`cavelon` lets a developer, or the coding agent working for them, build, seed and
test Cavelon solutions from a repository instead of the Admin. It is generic: it
learns each instance's API, features and docs from what the instance publishes
(its OpenAPI, `/api/v1/meta/capabilities`, `/api/v1/meta/error-catalog` and
`/llms.txt`), so a new core release needs no new `cavelon` release.

Node.js 20.3 or newer. Run it through `npx`, which needs no install; to type
`cavelon`, install it globally (or define an alias for the `npx` command):

```bash
npx -y @cavelon/cli --help
npm i -g @cavelon/cli
```

Without Node.js, one line installs a standalone `cavelon` into your user
folder: `curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh`
on macOS and Linux, `irm https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.ps1 | iex`
in Windows PowerShell.

The full documentation is in the repository's
[`docs/`](https://github.com/goodguys-gmbh/cavelon-dev-kit/tree/main/docs):
[installation](https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/installation.md)
(with the plugin for Claude Code and Codex),
[getting started](https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/getting-started.md),
[concepts](https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/concepts.md),
the [command reference](https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/commands.md),
[troubleshooting](https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/troubleshooting.md)
and [security](https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/security.md).
This page is a compact reference.

## Log in (a person does this once per instance)

1. Create a personal access token on `/account/access-tokens` in the Admin. It
   starts with `cvpat_`. A tenant API key (`cbp_…`) works too, for one tenant.
   An instance with personal access tokens turned off refuses every `cvpat_`
   token; `login` and every later command then answer
   `personal_access_tokens_disabled` (exit 7) and name the operator's setting,
   `PERSONAL_ACCESS_TOKENS_ENABLED`.
2. Run, in a terminal:

   ```bash
   cavelon login --instance https://cavelon.example.com
   ```

   `https://cavelon.example.com` stands for your instance's address, the URL you
   open Cavelon at in the browser.

   It asks for the token without echoing it. `--token-stdin` reads it from
   standard input instead. **`cavelon` never takes a token as an argument**, so it
   stays out of shell history. Run it in a terminal of your own: an agent's
   shell (`!` in Claude Code) has no terminal to type the token into.
   `login` finds the tenants the token reaches: it uses the only one, or asks
   you to choose by number or part of a name. Without a terminal it stores the
   token and prints one `cavelon use <tenant>` line per tenant (exit 2).
3. `cavelon whoami` shows who the token acts as, in which tenant (name, slug
   and id), its name and when it expires (it warns from seven days before), and
   whether it may activate solutions. `cavelon use` chooses another tenant from
   the same list.

The token goes into the operating system's credential store (Keychain, Windows
Credential Manager, Secret Service). Where there is none, it goes into
`~/.config/cavelon/credentials.json`, readable only by you (0600). `logout`
deletes it. The coding agent never sees the token: it calls `cavelon`, and
`cavelon` sends it.

`login` reads the instance's capabilities and warns when its contract versions
are newer than this `cavelon` understands. It also caches the OpenAPI and the
error catalog under `~/.cache/cavelon/<instance>/<version>/`.

### CI, scripts and cloud agents

Environment variables replace the login:

| Variable | Holds |
|---|---|
| `CAVELON_URL` | the instance URL |
| `CAVELON_TOKEN` | a personal access token (`cvpat_…`) or a tenant API key (`cbp_…`); needs `CAVELON_URL` |
| `CAVELON_TENANT` | the tenant's name, slug or id, for a personal token that reaches several tenants |

### Which instance, token and tenant

Highest first:

1. command-line options: `--instance <url>`, `--tenant <name, slug or id>`
   (there is no token option);
2. `CAVELON_URL`, `CAVELON_TOKEN`, `CAVELON_TENANT`;
3. the nearest `cavelon.yaml` from the current directory upwards (instance URL
   and tenant, never a token);
4. the stored login, and the tenant chosen with `cavelon use`.

`CAVELON_TOKEN` is used only together with `CAVELON_URL`, and only for that
instance: an option or a `cavelon.yaml` (perhaps from a cloned repository) that
names another instance never receives it. Plain `http://` is refused except for
`localhost` (or with `CAVELON_ALLOW_HTTP=1`).

`cavelon.yaml` is written by `cavelon init` (see "Solution as code"). Keys the
binary does not know are kept and ignored. With `--env <name>`, `env/<name>.yaml`
names the tenant between `CAVELON_TENANT` and `cavelon.yaml`.

## Commands

Every command takes `--json` (one JSON document on stdout, errors included),
`--instance` and `--tenant`, and `--help`. Each is marked read-only or changing
(`cavelon commands` lists them; `cavelon <command> --help` says it).

| Command | Marked | What it does |
|---|---|---|
| `login [--token-stdin]` | changing | Store a token for an instance. A person runs this. |
| `logout [--all]` | changing | Delete the stored token. |
| `whoami` | read-only | Owner or key, tenant (name, slug and id), role, and where the credential came from. |
| `use [<tenant>]` / `use --clear` | changing | Choose the tenant for this instance, by name, slug or id, or from a list. |
| `status [--offline]` | read-only | Instance, credential, tenant, solution folder, running operations, quotas close to full. |
| `limits [--key <key>] [--source <source>]` | read-only | The instance's limits for this tenant by source, who changes each and how; the tenant's quotas with their use (the monthly Processing Step cap among them); branch concurrency. |
| `limits set <key> <value> [--confirm]` | changing (destructive) | Change a limit through the operation the instance names: a tenant admin's, a quota of the Tenant Owner's (inference budget, Processing Step cap), or an operator's run cap with a Platform-mode token; without `--confirm`, shows the old and new value. |
| `models list` | read-only | The tenant's Model Registry rows with their endpoint and `max_concurrent_requests`; never a key. |
| `models set-limit <model> <n\|none> [--confirm]` | changing (destructive) | Set or clear a row's `max_concurrent_requests`; without `--confirm`, shows the old and new value. |
| `tenant create <slug> [--name] [--use]` | changing | Create a tenant (personal token in Platform mode with `tenants.manage`). |
| `tenant list [--search]` | read-only | Tenants the token can see, with name, slug, role and id. |
| `harness list [--readiness]` | read-only | The tenant's solutions, with slug, name, status and id. |
| `harness new <slug> [--name] [--description]` | changing | Create an empty draft solution. |
| `harness clone <source> [--slug] [--name] [--no-tests] [--no-triggers]` | changing | Copy a solution into a new draft. |
| `activate [--harness] [--env]` | changing | Activate through the readiness gate only, never by force. |
| `init [--harness] [--agents <list>] [--hook] [--update] [--from <file> [--force]]` | changing (files) | Make this folder a solution: `cavelon.yaml`, `package/`, `tests/`, `env/`, `.cavelon/`; on a terminal it asks for the tenant and the solution (or a new one by name); `--from` writes a package file into it. |
| `pull [--harness] [--force]` | changing (files) | Write the instance's package into `package/` and `tests/`, the inventory into `.cavelon/`. |
| `validate [--offline]` | read-only | Check the package files against the cached package schema. |
| `apply [--env] [--harness] [--mode]` | changing | Preview the files against the instance; prints and stores a preview id. |
| `apply --confirm <preview-id>` | changing | Import exactly that preview; a stale one, or one the import's own check refuses (it names the blockers), exits 4. |
| `explain <code>` | read-only | Look a code up in the instance's error catalog. |
| `variables list` / `variables get <name>` | read-only | The tenant's plain-text variables (`{{var:…}}`) with their values. |
| `variables set <name> <value> [--stdin]` | changing | Create or replace a variable. Never a credential. |
| `variables delete <name> [--confirm]` | changing (destructive) | Delete a variable; without `--confirm`, shows it. |
| `secrets list [--missing]` | read-only | The tenant's secret names (`{{secret:…}}`): set or not, declared, changed when. Never a value. |
| `secrets set <name>` | changing | Set a secret's value from the terminal or stdin. A person runs this. |
| `secrets delete <name> [--confirm]` | changing (destructive) | Delete a secret's value; without `--confirm`, shows its status. A person runs this. |
| `api <operation> [name=value…] [--json <body>]` | changing | Call any operation of the instance's OpenAPI. |
| `api list [--tag] [--search] [--method] [--tags]` | read-only | The operations the instance publishes. |
| `api describe <operation>` | read-only | One operation's parameters, body and responses. |
| `docs search <query>` | read-only | Search the instance's own docs. |
| `docs get <page> [--max-chars] [--cursor]` | read-only | One docs page as markdown. |
| `wait <operation…> [--timeout 90s]` | read-only | Wait for operations; resumable. A test run with failed cases is a failure. |
| `watch <operation> [--timeout 10m]` | read-only | Stream an operation's changes (server-sent events). |
| `kb upload <dir> --kb <kb> [-r] [--ext pdf] [--wait]` | changing | Upload documents; returns operation ids. |
| `test run [--suite <s>] [--harness <h>] [--wait]` | changing | Start test-suite runs; returns operation ids. |
| `trace <run> [--trace <id>] [--span <id>]` | read-only | Summarise a run's traces (or a test run's results, with why a case did not pass), then one trace's spans, then one span. |
| `loop start <trigger> [--input <json>] [--wait]` | changing | Start a loop through its trigger, as you; returns the run and operation ids. |
| `loop cancel <run> [--confirm]` | changing (destructive) | Stop a trigger run and its loops; without `--confirm`, shows what would stop. |
| `loop watch <run> [--loop] [--timeout 10m]` | read-only | One line per decided iteration and per state change, then the loop's outcome; returns when it ends or pauses. |
| `loop iterations <run> [--loop] [--limit] [--cursor]` | read-only | A loop's state, budget and iterations. |
| `loop pause <run>` / `loop resume <run> [--reason <pause_reason>]` | changing | Pause at the next safe point; resume a paused loop (a verdict on the task names its pause reason as reviewed). |
| `trigger identity <trigger> [<key> \| --clear] [--confirm]` | changing (destructive) | Show, bind or clear the API key a trigger's unattended runs act as. |
| `sandbox list` | read-only | The tenant's Sandboxes: mode, state, revision, what each mode offers. |
| `sandbox validate <sandbox>` | changing | Run the Sandbox's readiness checks; exit 3 when one fails. |
| `sandbox files <sandbox> [<path>]` / `sandbox cat <sandbox> <path>` | read-only | List a workspace folder; print a file a page at a time. |
| `sandbox activity <sandbox> [<id>]` / `sandbox logs` / `sandbox receipt` | read-only | What ran in the Sandbox, one activity's log, its validation receipt. |
| `sandbox seed <sandbox> <folder\|tar> [--confirm]` | changing (destructive) | Replace an isolated container's workspace with an archive. |
| `sandbox refresh <sandbox>` | changing | Accept a customer VM's files as the new baseline. |
| `artifacts export <sandbox> [--path] [--out] [--wait \| --job <id>]` | changing | Take files out of an isolated container as a tar. |
| `commands` | read-only | Every command with its marking and MCP tool. |
| `mcp` | changing | Serve the commands as MCP tools on stdio. |

### `cavelon api`

```bash
cavelon api list --search harness
cavelon api describe create_harness
cavelon api get_harness_by_slug slug=support
cavelon api create_knowledge_base --json '{"name": "FAQ"}'
cavelon api create_knowledge_base --json @kb.json      # or --json - for stdin
```

An operation is named by its `operationId` or by its short name (the part before
FastAPI's path suffix, `list_harnesses` for `list_harnesses_api_v1_harnesses_get`).
Parameters are `name=value` or `-p name=value`; the body is checked against the
operation's schema before it is sent. On `api`, `--json` followed by a value is
the body; a bare `--json` is the output switch as everywhere else.

### Limits

`cavelon limits` shows what the instance allows this tenant, from the `limits`
it publishes in `/api/v1/meta/capabilities`: upload size and file types, agent
turns and tool calls, timeouts, rate limits, the licence's cap on solutions.
They are grouped by where each value comes from (`tenant`, `platform`,
`licence`), and each names who changes it (a tenant admin or the instance
operator), the setting, and the docs page (`cavelon docs get <page>`). The
tenant's quotas follow with their current use, read from the path the limits
link to (`/api/v1/tenants/current/quota-usage`); `status` names the ones at 80 %
or more (or at the quota's own `warning_ratio`).

Two commands check them before they send anything:

- **`kb upload`** refuses a file larger than `kb_upload_max_file_size_mb` or of
  a type outside `kb_upload_allowed_extensions` (exit 3, with the instance's own
  code, `upload_file_too_large` or `upload_file_type_unsupported`), naming the
  files, the limit, its source and who changes it. `--dry-run` checks the same.
  A `.zip` is sent only while the tenant has archive uploads on
  (`kb_upload_archive_enabled`;
  `archive_uploads_disabled` otherwise, whatever the formats list) and
  `kb_upload_archive_formats` lists `zip` (`archive_format_disabled`), and only
  when the files its directory declares stay within
  `kb_upload_archive_max_entries`, `kb_upload_archive_max_total_uncompressed_mb`
  and `kb_upload_archive_max_compression_ratio` (per file), as the instance
  counts them (directories do not count). A limit whose `binds_when` names an
  on/off limit that is off does not bind and is not checked. On an instance
  without the switch, an empty list of formats means archives are off. The
  instance checks each file inside against the types itself. On an instance
  that publishes no archive entries, the zip is sent and the instance decides.
  A knowledge base may set lower limits of its own, which the instance checks.
- **`harness new`** refuses when the tenant's quotas list a solution quota that
  is used up (exit 3, `tenant_quota_reached`), or when the tenant alone already
  has as many solutions that are not archived as `licence_max_harnesses` allows
  (exit 7, `license_limit_reached`, as the instance answers). The licence counts
  every tenant's solutions, so below the cap the instance decides.

A limit the instance does not publish is never assumed: on an instance older
than the published limits, `limits` says so and the commands send as before.

**Limits that bind only while another is on**.
The archive caps are published whether archive uploads are on or off, with
`binds_when: "kb_upload_archive_enabled"`. `limits` lists them under "Only while
another limit is on" ("applies while archive uploads are on", and whether they
bind now), and `--json` adds `binds_now` to each. A tenant admin may set a cap
before turning archives on, and turns them on with
`limits set kb_upload_archive_enabled true`. The formats are the platform's
(`changeable_by: operator`); `limits set kb_upload_archive_formats` refuses and
names the switch.

**The monthly Processing Step cap**. The instance
publishes it in `tenant_quotas.values`, with this billing month's use, its
`state` (`none`, `ok`, `reached`, `unavailable`) and its change. `limits` lists
it under the tenant quotas ("close to the cap" from 80 %, "cap reached"), and
leaves out the quota-usage row that names the same change. A Tenant Owner
(`settings.manage`) sets it with `limits set monthly_processing_step_cap <n>`
and removes it with `none`. `cavelon explain processing_step_cap` explains the
refusal of new work at the cap (`PROCESSING_STEP_CAP_REACHED`), with the cap,
its use, when it resets and who raises it.

**Branch concurrency**. `limits` shows the width
per node (`orchestration_max_branch_concurrency`: a fan-out's or Map loop's
`max_concurrency` above it is capped), the branch slots one process shares
(`orchestration_process_max_branch_inflight`), and whether this tenant's
branches run concurrently (`orchestration_parallel_branches`). With branches
off, it names the switch that turned them off (the platform's
`ORCHESTRATION_PARALLEL_FANOUT_ENABLED`, or the tenant's feature flag) and who
turns it on. `validate` warns, never fails, when a fan-out or Map loop in the
package (an orchestration node's or graph edge's `config`, or a handoff's
`orchestration_config`) sets `max_concurrency` above the width
(`branch_width_capped`), and when the tenant runs fan-outs and Map loops in
sequence (`branches_run_in_sequence`). It reads the limits the instance last
published (cached by any command that read them), so it stays offline.

**Run capacity**. The run caps
(`max_concurrent_agent_runs_per_tenant`, `max_concurrent_agent_runs_global`)
also name their `origin` where the instance publishes one: a platform setting
the operator changes in the Admin (Platform › Operations › Rate limits), the
environment, or the default; `limits` then adds an origin column and says where
each cap is set. A tenant's own cap shows under
`max_concurrent_agent_runs_per_tenant` with source `tenant`; the operator sets
it with `PATCH /api/v1/tenants/{tenant_id}/limits`. `status` prints the run caps
with source and origin, and the slot waits (`agent_run_slot_wait_seconds`,
`model_endpoint_slot_wait_seconds`). An entry without `origin` shows as before.

**Changing a limit**. Each limit a tenant admin
may change publishes its `change`: the operation (`operationId`, method, path),
the body field that carries the value, the permissions of which the caller
needs one, and its bounds (`minimum`, `maximum`; a rate limit's `maximum` is the
operator's ceiling, named in `maximum_setting`; the per-visitor rate limits
`rate_limit_chat_visitor_rpm` and `rate_limit_widget_visitor_rpm` among them).
The inference budget, a quota,
is listed in `tenant_quotas.changes`. `limits set <key> <value>` reads that and
checks the value offline: a whole number in the limit's unit (`50` or `50MB`,
`100rpm`), a comma-separated list of file types, `true`/`false` for a switch,
or `none` to clear the tenant's own value so the platform's applies again.
Without `--confirm` it shows the old and the new value, the operation with its
body and who may run it, and changes nothing; with `--confirm` it sends exactly
that operation and prints the new value from the instance's answer. Where the
tenant's quota row names the change, the preview
of a quota shows its current value from the row's `change.field`.

```bash
cavelon limits set kb_upload_max_file_size_mb 50             # shows the change
cavelon limits set kb_upload_max_file_size_mb 50 --confirm   # PATCH /api/v1/tenants/current/upload-defaults
cavelon limits set rate_limit_chat_rpm none --confirm         # back to the platform's value
cavelon limits set monthly_inference_token_budget 2000000     # PATCH /api/v1/tenants/{tenant_id}/limits, this tenant
cavelon limits set monthly_processing_step_cap none --confirm # a Tenant Owner removes the cap
```

**An operator's change**. The run caps publish a
`change` too, with `requires_role` (the global roles, any one of which the
caller needs) and `mode: platform`. `limits set` sends it only when
`/api/v1/meta/principal`, asked without `X-Tenant-Id`, answers in Platform mode
for a personal access token whose ceiling role is one of those roles (and the
person's global role from `/api/v1/auth/me` too), and sends the change without
`X-Tenant-Id`. Otherwise it refuses before sending (exit 7,
`platform_role_required`), naming the role and the Admin page (Platform ›
Operations › Rate limits › Run caps, a tenant's Limits section, or Configure ›
Feature Flags). The limits are still read for a tenant, so name one with
`--tenant` or `cavelon use`. With `--tenant <id|slug>`, a limit's
`tenant_change` applies instead: `max_concurrent_agent_runs_per_tenant` then
sets that tenant's own cap, with the tenant's id in the path. The tenant's flag
behind concurrent branches is the change on `orchestration_parallel_branches`:
a `PUT` to
`/api/v1/admin/feature-flags/{tenant_id}/ORCHESTRATION_PARALLEL_FANOUT_ENABLED`,
the tenant's id from `--tenant` and the flag from the published path (the
OpenAPI's `{flag_key}`); `on`/`off` (or `true`/`false`), and the preview shows
the flag's own state. An operator limit without a `change` cannot be changed at
runtime, and `limits set` says so. A tenant on Processing-Step terms is not
offered the inference budget: the instance leaves its change out, so `limits set` refuses it as not listed.

```bash
cavelon limits set max_concurrent_agent_runs_global 150 --tenant acme --confirm   # superadmin, Platform mode
cavelon limits set max_concurrent_agent_runs_per_tenant 6 --tenant acme --confirm # acme's own cap
cavelon limits set orchestration_parallel_branches false --tenant acme --confirm  # acme's flag, platform admin
```

It refuses before sending anything:

- an `operator` or licence limit without a `change` (exit 7,
  `limit_changed_by_operator`), naming who changes it and where (its `setting`,
  `origin` and docs page);
- an operator's change without a Platform-mode token of its role (exit 7,
  `platform_role_required`);
- a value outside the published bounds (exit 3, `request_invalid`, as the
  instance answers); a rate limit above the ceiling names the operator's
  setting that raises it, with the instance's `limit_above_platform_ceiling`
  where its error catalog lists the code (its
  fields `setting`, `value`, `maximum` and `maximum_setting` in the details).
  When the instance itself refuses with that code (its ceiling changed since it
  published), the error names the ceiling, the setting and that only the
  operator raises it; `cavelon explain limit_above_platform_ceiling` lists
  today's ceilings;
- an entry without `change`, on an older instance (exit 1,
  `operation_unavailable`: this instance does not publish how to change it);
- a credential whose `permissions`, as `/api/v1/meta/principal` lists them,
  share no name with the change's (exit 7,
  `forbidden`, naming the permission): a tenant admin's token for the
  Processing Step cap, for example. On an instance that publishes no
  `permissions`, an API key whose scopes are neither `admin` nor one of the
  permissions is refused, and for a person the instance decides; its 403 exits
  7 and names the permissions.

The MCP tool `limits_set` carries the destructive annotation and takes
`confirm` like the CLI. `cavelon limits` names the command under the limits a
tenant admin changes, and the limits an operator changes in Platform mode.

**Model endpoint limits**. `models list` shows the
tenant's Model Registry rows with their endpoint (the `base_url`'s scheme, host,
port and path: user info and query are left out) and `max_concurrent_requests`,
and which rows share an endpoint, and so its count. It never shows a key, only
its kind (`api_key_type`). `models set-limit <model> <n|none>` shows the old and
the new value and changes nothing; with `--confirm` it sends only that field to
the row's update operation (`PATCH /api/v1/model-registry/{model_registry_id}`,
`agents.manage_llm_config`). The value is checked against the instance's own
schema, and a row without a `base_url` is refused before anything is sent
(exit 3, `model_endpoint_limit_without_base_url`). The MCP tool
`models_set_limit` carries the destructive annotation, so the person confirms it
in the client.

### Variables and secrets

Prompts, tools, guardrails and test suites name tenant **variables** as
`{{var:<name>}}` and **secrets** as `{{secret:<name>}}`. A package carries only
their names: `package/required_variables.yaml` and
`package/required_secrets.yaml` declare what the solution needs (a `name` and a
`description` each), and `pull` and `apply` keep them. `apply` lists every
name the target has no value for, with the command that sets it (`--json`:
`set_commands`), and reminds of them after `--confirm`.

```bash
cavelon variables set crm_base_url https://crm.example.com
cavelon secrets list --missing
cavelon secrets set crm_api_token               # asks for the value, without echo
op read op://dev/crm/token | cavelon secrets set crm_api_token
```

- A **variable** is plain text: anyone who may view the tenant's settings
  reads it, and the agent may set it (MCP: `variables_list`, `variables_get`,
  `variables_set`). `variables set` refuses a value that looks like a token.
- A **secret's** value is never an argument, never printed, never written to a
  file and never read back. `secrets set` reads it from the terminal without
  echo, or from standard input when that is piped (one trailing line break is
  dropped), and refuses a value given as an argument without repeating it.
  Setting or deleting one needs a person (a session or a personal access
  token): with a tenant API key, `cavelon` refuses before it asks for the value
  or sends anything (exit 7, `secret_needs_a_person`, as the instance would
  answer). MCP offers only `secrets_list`; an agent tells the person the exact
  `cavelon secrets set <name>` command instead.
- `--env <name>` acts in the tenant `env/<name>.yaml` names, like `apply`. A
  name without its env file is refused (exit 2) before anything is sent.

### Long-running work

`kb upload` and `test run` return operation ids at once. `--wait` waits for them,
or run `wait`:

```bash
cavelon wait op_test_run_… --timeout 5m
```

`wait` returns when every operation has finished or needs a person, or when the
timeout passes. It prints the state in every case; when time ran out, the work
goes on, and the same `wait` again resumes it. `watch` streams each change.
An operation only says that the work finished: for a test run, `wait`,
`watch` and `test run --wait` also read the run's summary. A run whose cases
failed or errored, or that measured nothing comparable (steps not run,
technical errors, missing results, or no pass rate), exits 1 with the counts,
the failed cases and the reason the instance recorded; a run whose answers
wait for a manual verdict or for a value a case needs exits 5 (`--json`:
`failed_results`, each with `counts`, `comparable` and `exit_code`). `trace <test run>` lists every case that did not pass with
its error, the judge's reasoning and the command that opens its traces (by its
conversation id, or for a trigger case by the run it started), and the judge's
reasoning for each scored pass the instance sent it for. `test run --wait` ends,
when its wait ran out, with the one `wait` command that resumes.

A trigger or channel run that meets a full run cap stays `queued` and the
instance retries it every 5–20 s. The run says so itself
(`waiting_for_capacity`; for an operation, the
kit reads the run its `result_ref` names), so `wait`, `watch`, `loop watch`,
`trace`, `status` and `loop cancel` say **waiting for run capacity** from the
first poll (`--json`: `capacity_waits`, or `capacity_wait` on the run), name
the run caps and where each is set, and keep waiting within the timeout. On an
instance that does not publish the field, they say it once a run has been
queued for more than 30 s, and mark the wait `inferred: true`.
A run or call refused for capacity (`run_capacity_busy`, `model_endpoint_busy`)
gets the instance's catalog entry plus which limit to raise and who can
(`--json`: `capacity_refusals`; `explain`: `kit_hint`), and that retrying later
is fine.

## Loops and Sandboxes

A Masterloop loop runs a solution in bounded iterations; it starts only
through its trigger, and stopping the trigger run stops it. A Sandbox is the
workspace a loop works in, in one of two modes, which offer different things:

| | `isolated_container` | `customer_vm` |
|---|---|---|
| Put files in | `sandbox seed <sandbox> <folder>` (archive import) | put them on the VM, then `sandbox refresh <sandbox>` |
| Take results out | `artifacts export <sandbox>` (archive export) | `sandbox cat <sandbox> <path>` |
| Validation receipt | `sandbox receipt` | none: completion is agent-reported |

`cavelon` reads each Sandbox's mode and refuses a command the mode does not
offer before sending anything, naming the mode (exit 3, with the instance's
own code: `sandbox_capability_unavailable`, `sandbox_workspace_refresh_unavailable`
or `sandbox_validation_receipt_unavailable`). It also refuses Sandbox and loop
commands when the instance's capabilities say the feature is off.

```bash
cavelon sandbox validate orders-test
cavelon sandbox seed orders-test seeds/orders            # shows what it would send
cavelon sandbox seed orders-test seeds/orders --confirm  # the archive becomes the workspace
cavelon trigger identity orders loop-runner              # shows the change
cavelon trigger identity orders loop-runner --confirm    # binds the API key
cavelon loop start orders --input @request.json
cavelon loop watch <run>
cavelon sandbox cat orders-test output/summary.json
cavelon artifacts export orders-test --path output --wait --out results.tar
```

- **`loop start`** calls the trigger's run-now route; the run acts as you (with
  a personal access token, the person). It returns the run id and the run's
  operation id, so `wait` and `watch` follow it (and `trace <operation>` reads
  the run's traces); a paused loop makes `wait` exit 5. It sends an
  `Idempotency-Key` (`--idempotency-key`, a new UUID by default; `--json`:
  `idempotency_key`). When the start ends in exit 8 (a timeout, a cut
  connection, a 5xx), the run may have started: the error's hint names the key,
  and the same command with `--idempotency-key <key>` starts no second run.
  With `--wait`, a run that ended without starting a loop exits 1 and names the
  stage that recorded an error.
- **`loop watch`** prints each iteration once the loop decided on it: accepted
  (with the outcome of its `loop.continuation.v1` result), rejected, or failed
  when its child failed, with the reason. Usage is the iteration's actual usage;
  until the instance reports it, the line says what the iteration reserved.
  Then each state change, and at the end the loop's outcome: its reason, what
  it charged and, for a paused loop, how it goes on (`go_on`): the `loop
  resume` a person runs after fixing the cause, with `--reason <the pause
  reason>` when the pause is a verdict on the task; or, when it cannot be
  resumed, why not, `loop cancel <run> --confirm` and `loop start <trigger>`.
  The kit follows the loop's `resume` where the instance publishes it;
  until then it rules a resume out only from the
  loop's published state (its run stopping, its deadline, `resume_enabled`,
  unknown operations), and names the `--reason` command for when the instance
  asks for a review. The catalog's sentence for the pause reason is shown when
  it lists one. `--json` gives one object per line (`iteration`, `loop`,
  `outcome`). Exit 0 completed, 1 failed or cancelled, 5 at once when the loop
  pauses, 6 when the timeout came first. A run that ended without a loop names
  the stage that recorded an error. `loop iterations` reads the same a page at
  a time; `trace <child_run_id>` reads one iteration's run.
- **`loop pause`**, **`loop resume`** send the loop's version and an
  `Idempotency-Key` (`--idempotency-key` makes a retry safe; an exit-8 error
  names the key it sent); a loop that
  changed in between answers 409 (exit 4). `loop resume --reason` must be the
  loop's pause reason (exit 2 otherwise, before anything is sent). A pause that
  needs a review and has none exits 5 (`loop_resume_review_required`) with the
  command to run; one that cannot be resumed exits 4 with what to do instead. Without `--loop`, they act on the
  run's only loop that can be paused or resumed.
- **`loop cancel`** and **`sandbox seed`** change nothing without `--confirm`;
  they show what would happen.
- **`trigger identity`** binds through the trigger's versioned
  `execution-identity` route, with the version it read; `apply` never binds
  one. The key is named by its name or id, never its value (a value that looks
  like a key or token is refused and not echoed). Without `--confirm` it shows
  the change. It warns when the key does not reach the solutions the trigger
  needs or a Sandbox's Access does not list it; both are fixed in the Admin.
- **Sandbox reads** (`files`, `cat`, `activity`, `logs`, `receipt`) and jobs
  go through a solution the Sandbox allows: `--harness`, else `cavelon.yaml`'s,
  else the Sandbox's only allowed solution. One it does not allow exits 7.
- **`sandbox seed`** sends a folder as an uncompressed USTAR archive (files and
  folders only; links and special files are refused), a `.tar` as it is, or
  any other file under its own name, up to the size the instance's OpenAPI
  allows (64 MiB). Names are checked before they go in, and the archive's bytes
  depend only on the files, so the same seed again is the same job: running it
  again resumes it. The archive goes up once the job has taken the workspace;
  `sandbox seed` waits up to 30 seconds for that (over MCP too), and otherwise
  exits 6 with the command that resumes it.
- **`artifacts export`** starts an export job and returns its operation id;
  with `--wait`, or later with `--job <id>`, it writes the tar to `--out`
  (default `sandbox-<job>.tar`) after checking its SHA-256, and never over an
  existing file (exit 4).

## Solution as code

A solution is a folder with a `cavelon.yaml`; `cavelon` finds the nearest one
from the working directory upwards, so a monorepo can hold several.

```text
solution/
  cavelon.yaml      instance, tenant, solution (harness), package format, layout; never a token
  package/          one file per top-level section of the instance's package schema
  tests/            one file per test suite (the schema's test_suites section)
  seeds/            your seed scripts and data manifests
  env/test.yaml     where `apply --env test` goes: tenant, harness, mode, runtime_bindings
  env/prod.yaml
  .cavelon/         local state, never committed: inventory.md, pull.json, previews/
  AGENTS.md         a short Cavelon block between markers
```

```bash
cavelon init --instance https://cavelon.example.com --tenant acme --harness support
cavelon pull                      # the live solution into package/ and tests/
$EDITOR package/agents.yaml
cavelon validate                  # offline, against the cached package schema
cavelon apply --env test          # preview: prints and stores a preview id
cavelon apply --confirm <id> --env test
cavelon activate --harness support
```

- **`init`** creates its own files (`cavelon.yaml`, `package/`, `tests/`,
  `seeds/`, `env/test.yaml`, `env/prod.yaml`, `.cavelon/`) and never overwrites
  them. `AGENTS.md`, `.gitignore` and an existing `CLAUDE.md` (with an
  `@AGENTS.md` import) get at most one block between `cavelon:begin` and
  `cavelon:end` markers; a file whose markers are broken is left alone with a
  warning. `--hook` adds a git pre-commit hook that runs `cavelon validate`, as a
  marked block after a hook's shebang. Only an invalid package (exit 3) stops the
  commit; when the check cannot run, the hook warns and lets the commit through. `--update` touches only the marked
  blocks and the fallback files a previous `init` wrote.
- **`init --from <file>`** brings an existing package file into the solution:
  a blueprint package,
  an export from another instance, a package attached to an issue. It reads JSON
  or YAML and writes it as `pull` writes an export, one `package/<section>.yaml`
  per top-level section and one `tests/<suite>.yaml` per test suite, so
  `validate` and `apply` take it from there; it never goes through the Admin's
  import, and the repository stays the source. A file that already holds the
  same value keeps its bytes. One that would change, or go away because the
  package lacks its section or suite, stops the import before anything is written
  (exit 4, `package_files_differ`, the files in `details.files`) unless `--force`.
  Sections the instance's package schema does not know are written, reported as
  `ignored` and warned about, as `validate` does. With no `--harness`,
  a package with one harness names the solution in a new `cavelon.yaml` and
  `env/test.yaml`, so `apply --env test` creates that draft. The rest of `init`
  runs as without `--from`: its own files, the marked blocks.

  ```bash
  mkdir counter && cd counter
  cavelon init --instance https://cavelon.example.com --tenant acme --from ../counter-parent.json
  cavelon validate --offline
  cavelon apply --env test
  ```
- **`init --agents <list>`** is the fallback for agents without the Cavelon
  plugin: the skills go into `.agents/skills/cavelon-*/` and
  `.claude/skills/cavelon-*/`, marked as generated, and each named agent gets the
  `cavelon mcp` entry: `claude` (`.mcp.json`), `codex` (`.codex/config.toml`, a
  marked block), `cursor` (`.cursor/mcp.json`), `copilot` (`.vscode/mcp.json`),
  `gemini` (`.gemini/settings.json`), `kiro` (`.kiro/settings/mcp.json`); `pi` and
  `other` need only `AGENTS.md`. A JSON file is changed only when rewriting it
  keeps every other byte; otherwise `init` says what to add.
- **`pull`** exports the solution (`--harness`, or `cavelon.yaml`'s), or without
  one the tenant's full configuration, and splits it along the top-level sections
  of the instance's published package schema, so no entity type is built into
  the binary. A file whose content did not change keeps its bytes, so `git diff`
  shows what changed on the instance; files of sections the schema does not know
  are kept byte for byte. It refuses when package files have uncommitted changes
  (exit 4) unless `--force`, and writes the tenant's solutions, knowledge bases,
  tools, test suites and sandboxes to `.cavelon/inventory.md`.
- **`validate`** checks the files against the package schema that `init`, `pull`
  or `apply` cached, and the package version against those the instance accepts.
  It contacts the instance only when nothing is cached (never with `--offline`).
  Each finding has a file, line, path and code; exit 3 on errors. A Model
  Registry row's `max_concurrent_requests` needs a `base_url`
  (`model_endpoint_limit_without_base_url`); where the package schema does not
  carry the field, a warning says the import ignores it.
- **`apply`** validates, then calls the import preview and prints what changes,
  which active solutions it reaches, what the target still needs (secret values,
  OAuth grants, runtime bindings, trigger execution identities), loop budgets and
  ignored sections, with the preview id. It stores the exact request in
  `.cavelon/previews/`, so **`apply --confirm <id>`** imports exactly what was
  previewed, even if the files changed since (it warns). A target that changed
  since the preview answers `409 import_preview_stale`: exit 4, and the hint says
  how to preview again. An import whose own check, re-run when it applies,
  finds what the preview did not answers `409 package_requirements_changed`
  with `blockers`: exit 4, each blocker on its own line (in `--json`, the
  error's `blockers`), "nothing was imported; preview again", and for a code
  the kit knows (such as `runtime_draft_iteration_needs_draft_parent`) its hint. When the env file names a solution that does not exist
  yet, `apply` creates it as a draft first, named as `package/harnesses.yaml`
  names the harness with that slug (or its only harness), and after the slug
  where the package has none; `runtime_bindings` from the env file
  bind the package's runtime requirements. A preview that reaches an active
  solution, deletes, or goes to `env/prod` says to show it to a person first.
- **`explain <code>`** looks a rule code or API error code up in the instance's
  error catalog (and the codes `validate` reports itself): meaning, fix and docs
  link. For `run_capacity_busy` and `model_endpoint_busy` it adds which limit to
  raise, who can, and today's values from `limits`, and the instance's pages on
  capacity (`concepts/capacity-and-concurrency`, `tutorials/plan-model-capacity`)
  where its docs index lists them (`--json`: `read`).
- **`activate`** reads the readiness gate and activates only when it passes,
  never with `force`. A personal access token without "may activate" is refused
  before anything is sent (exit 7); a solution that is not ready exits 3 with its
  blockers.
- **A Masterloop parent and its iteration solution** activate without the
  override in one order: apply the iteration, apply the parent, run the
  parent's loop suite, activate the iteration, activate the parent.
  When `apply` meets
  `runtime_draft_iteration_needs_draft_parent` or
  `runtime_external_iteration_harness_unavailable`, or `activate` meets the
  parent's `masterloop_iteration_harness_draft`, its `hint` gives the catalog's
  sentence and hint, the step it points at, and the order; `explain` adds the
  same under `order`.

Import needs a personal access token (or an Admin session): an instance refuses
it to a tenant API key.

## Built for agents

- **No prompts.** Only `login` asks, and only on a terminal; everywhere else it
  needs `--token-stdin`.
- **`--json` everywhere**; no colours or progress lines without a terminal, or with
  `NO_COLOR` set.
- **Bounded waits**: `wait` defaults to 90 seconds, `watch` and `loop watch` to 10 minutes.
- **Commands to copy**: a command printed in a hint quotes every name for the
  shell cavelon runs in (POSIX shells, PowerShell, cmd), so a Sandbox named
  `Lab VM 4073` stays one argument. `CAVELON_SHELL=posix|powershell|cmd` names
  the shell when the guess is wrong.
- **Confirm what is destructive**: `apply`, `loop cancel`, `sandbox seed` and
  `trigger identity` show what they would do, and act only with `--confirm`.
- **Bounded output**: lists take `--limit` and `--cursor` and print the next
  cursor; traces are summarised, with the command for each span's detail.
- **Read-only or changing**, on every command and MCP tool.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | anything else (not found, an operation failed or was cancelled, a test case failed) |
| 2 | usage: unknown command or option, a missing argument, no instance chosen |
| 3 | validation failed: the arguments or body do not match the instance's schema, or the instance refused them (400, 422) |
| 4 | conflict or stale preview (409, 412) |
| 5 | needs a person (`needs_action`): the reason and the Admin link are printed |
| 6 | timed out: the operation is still running; `wait` again to resume |
| 7 | not authorised: no token, or the instance refused it (401, 403) |
| 8 | server or network error (5xx, 429, unreachable, request timeout) |

With `--json`, an error is `{"error": {"code", "message", "hint", "docs", "status", "exit_code"}}`,
carrying the instance's own error code where it sent one.

## `cavelon mcp`

The same commands as MCP tools over stdio, for agents that prefer tools to a
shell. The tools are coarse, one per workflow command plus `api`, `api_list`,
`api_describe`, `docs_search` and `docs_get`, and carry the standard read-only and
destructive annotations. The repository tools (`init`, `pull`, `validate`,
`apply`, `explain`, `activate`) and `sandbox_seed` and `artifacts_export` work in
the folder the agent started `cavelon mcp` in. They never block: `kb_upload`,
`test_run`, `loop_start`, `sandbox_seed` and `artifacts_export` return operation
ids, `operation_status` reads them, and `loop_iterations` follows a loop
(`loop watch` and `watch` stream, so they are no tools). `loop_cancel`,
`sandbox_seed` and `trigger_identity` are marked destructive and change nothing
without `confirm: true`. `limits` is read-only; the server's instructions tell
the agent to read it before planning a solution. `login` and `logout` are not
tools; a person runs them.

```json
{
  "mcpServers": {
    "cavelon": { "command": "npx", "args": ["-y", "@cavelon/cli@0.1", "mcp"] }
  }
}
```

The Cavelon plugin for Claude Code and Codex (`plugin/.mcp.json`) and
`init --agents` carry this entry. It runs the released package through `npx`,
pinned to the kit's minor version: in 0.x a new minor may break, and it reaches
an agent only with a new plugin or `init --update`. With `cavelon` installed,
`{ "command": "cavelon", "args": ["mcp"] }` works as well.

## Files on your machine

| Path | Holds |
|---|---|
| `~/.config/cavelon/config.json` | the current instance, the tenant chosen with `use`, which store holds the token. Never a token. |
| `~/.config/cavelon/credentials.json` | the token per instance (0600), only where there is no OS credential store |
| `~/.cache/cavelon/<instance>/<version>/` | the instance's capabilities, OpenAPI, error catalog, package schema and docs index |
| `~/.cache/cavelon/update-check.json` | when the latest release was last looked up and announced; `CAVELON_NO_UPDATE_CHECK=1` turns the check off |

`CAVELON_CONFIG_DIR` and `CAVELON_CACHE_DIR` move them; `XDG_CONFIG_HOME` and
`XDG_CACHE_HOME` are honoured. `CAVELON_CREDENTIAL_STORE=file` skips the OS store.
A release's cached copies are kept until the instance reports another version.
A development build (a version with `dev`, `snapshot` or `local` in it) keeps
one version while what it publishes changes, so its copies are read again after
a minute, or checked with the ETag the instance sent with them;
`CAVELON_CONTRACT_TTL_SECONDS` sets that time. `cavelon validate --verbose` says
which copy of the package schema it used.
In the working directory, only `init`, `pull` and `apply` write, as described
in "Solution as code", and `artifacts export`, which writes the tar it
downloads to a new file.
