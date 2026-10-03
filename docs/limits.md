# Limits

Every Cavelon instance limits what a tenant may do: how large an upload may be,
how many requests per minute a channel takes, how many runs execute at once,
how many tokens a month may use. The instance publishes each limit with its
value, where the value comes from, and who may change it. `cavelon` reads that,
shows it, checks your work against it before sending anything, and changes a
limit through the operation the instance names.

## Reading the limits

```bash
cavelon limits                                  # every limit and the tenant's quotas
cavelon limits --key kb_upload_max_file_size_mb # one limit
cavelon limits --source tenant                  # only the tenant's own values
cavelon limits --json                           # everything, for scripts and agents
```

`limits` groups the values by where each comes from:

| Source | Meaning |
|---|---|
| `tenant` | the tenant's own setting, which overrides the platform's |
| `platform` | the instance's value for every tenant, set by its operator |
| `licence` | what the instance's licence allows |

Each row names who changes the limit (**a tenant admin** or **the instance
operator**), the setting behind it, and the docs page that explains it
(`cavelon docs get <page>`). For a platform value, an origin column says
whether the operator set it in the Admin, in the environment, or whether it is
the built-in default.

Below the limits, **tenant quotas** show what the tenant has used: knowledge
bases, documents, storage, agents, tools, and the monthly inference and
Processing Step budgets, each with its use and state. `cavelon status` names
every quota at 80 % or more.

A limit the instance does not publish is never assumed. An older instance that
publishes no limits gets a note from `limits`, and the other commands send
their requests and let the instance decide.

## Checked before sending

- **`kb upload`** refuses a file larger than `kb_upload_max_file_size_mb` or of
  a type outside `kb_upload_allowed_extensions` (exit 3), naming the files, the
  limit, and who changes it. `--dry-run` runs the same checks and uploads
  nothing. A `.zip` goes only to a tenant with archive uploads on
  (`kb_upload_archive_enabled`) whose formats include `zip`, and only within
  the archive caps on file count, unpacked size and compression ratio. A
  knowledge base may have lower limits of its own, which the instance checks.
- **`harness new`** refuses when the tenant's solution quota is used up
  (`tenant_quota_reached`, exit 3) or the licence's cap on solutions is reached
  (`license_limit_reached`, exit 7).
- **`validate`** warns when a fan-out or Map loop asks for more parallel
  branches than the instance runs per node (`branch_width_capped`), or when the
  tenant runs branches one after another (`branches_run_in_sequence`). It reads
  the limits cached by an earlier command, so it stays offline.

## Who may change what

| Who | What | How |
|---|---|---|
| **A tenant admin** | the tenant's upload defaults, archive uploads and caps, agent defaults, rate limits, the monthly inference budget | `cavelon limits set` with their personal access token or a tenant API key with the permission |
| **A Tenant Owner** | additionally the monthly Processing Step cap | `cavelon limits set monthly_processing_step_cap …` |
| **The instance operator** | platform values, the run caps, a single tenant's run cap, whether a tenant's branches run concurrently | the Admin, or `cavelon limits set … --tenant <tenant>` with a Platform-mode token |
| **Nobody at runtime** | values from the licence or the instance's environment, without a published change | `limits` names the setting; the operator changes the deployment |

The instance decides who holds which permission. `cavelon` reads the
permissions the instance publishes for your credential and refuses before
sending a change you could not make (`forbidden`, exit 7, naming the
permission).

## Changing a limit

`limits set` shows the change first and sends it only with `--confirm`:

```bash
cavelon limits set kb_upload_max_file_size_mb 50             # shows the old and new value, and the operation
cavelon limits set kb_upload_max_file_size_mb 50 --confirm   # sends it
```

Values are checked against the limit's unit and bounds before anything is sent:

| Kind of limit | Value |
|---|---|
| a number | a whole number in the limit's unit: `50`, `50MB`, `100rpm` |
| a list of file types | comma-separated: `pdf,md,docx` |
| on/off | `true` or `false` (also `on`/`off`, `yes`/`no`) |
| any of the tenant's own values | `none`: remove the tenant's value, so the platform's applies again |

```bash
cavelon limits set kb_upload_archive_enabled true --confirm   # turn archive uploads on
cavelon limits set rate_limit_chat_rpm none --confirm         # back to the platform's value
cavelon limits set monthly_processing_step_cap none --confirm # a Tenant Owner removes the cap
```

A value above an operator's ceiling (a rate limit above the platform's
maximum, for example) is refused with `limit_above_platform_ceiling`, naming
the ceiling and the setting the operator raises. `cavelon explain
limit_above_platform_ceiling` lists today's ceilings.

`limits set` refuses, before sending, when:

| Code | Exit | Why |
|---|---|---|
| `limit_changed_by_operator` | 7 | only the operator changes this limit; the message names the setting and where |
| `platform_role_required` | 7 | an operator's change needs a Platform-mode token of the role it names |
| `forbidden` | 7 | your credential lacks the permission the change needs |
| `request_invalid` | 3 | the value is outside the published bounds or the wrong kind |
| `operation_unavailable` | 1 | this instance does not publish how to change the limit (an older version); change it in the Admin |
| `limit_not_found` | 1 | the instance publishes no such limit, or none you can change; `cavelon limits` lists them |

## Archive uploads

The archive caps (`kb_upload_archive_max_entries`,
`kb_upload_archive_max_total_uncompressed_mb`,
`kb_upload_archive_max_compression_ratio`) apply only while archive uploads are
on. `limits` lists them under "Only while another limit is on", and says
whether they bind now. A tenant admin may set the caps before turning archives
on. The archive formats themselves are the operator's.

## Run capacity

Two caps decide how many runs execute at once: per tenant
(`max_concurrent_agent_runs_per_tenant`) and for the whole instance
(`max_concurrent_agent_runs_global`). A run started by a trigger or a channel
that meets a full cap waits in the queue, and the instance retries it every few
seconds. `wait`, `watch`, `loop watch`, `trace` and `status` say **waiting for
run capacity** instead of calling the run stuck, name the caps and where they
are set, and keep waiting within the timeout.

A call refused for capacity (`run_capacity_busy`, or `model_endpoint_busy` for
a model endpoint at its limit) can be retried later. `cavelon explain
run_capacity_busy` names the limit to raise, who raises it and today's values,
and points to the instance's own pages on capacity planning.

## Branch concurrency

A fan-out or Map loop runs its branches in parallel up to a width per node
(`orchestration_max_branch_concurrency`); all runs in one process share a pool
of branch slots (`orchestration_process_max_branch_inflight`). Whether a
tenant's branches run concurrently at all is a switch
(`orchestration_parallel_branches`) that the operator turns on or off. `limits`
shows all three, and which switch turned branches off, if one did.

## Model endpoints

A self-hosted model endpoint usually handles only so many requests at once.
`cavelon models list` shows the tenant's model rows with their endpoint (never a
key) and `max_concurrent_requests`, and which rows share an endpoint and so its
count:

```bash
cavelon models list
cavelon models set-limit llama-3-70b 4             # shows the change
cavelon models set-limit llama-3-70b 4 --confirm   # sets it
cavelon models set-limit llama-3-70b none --confirm
```

A package can carry `max_concurrent_requests` on its model rows too;
`validate` reports one without a `base_url` as an error.

## Operators' changes

The run caps and the tenant's branch switch carry a change for the operator.
`limits set` sends it in Platform mode, without a tenant header, only when your
personal access token allows Platform mode and its role is one the change
names; otherwise it refuses with `platform_role_required` and names the role
and the Admin page. The limits are still read for a tenant, so name one:

```bash
cavelon limits set max_concurrent_agent_runs_global 150 --tenant acme --confirm    # every tenant
cavelon limits set max_concurrent_agent_runs_per_tenant 6 --tenant acme --confirm  # acme's own cap
cavelon limits set orchestration_parallel_branches false --tenant acme --confirm   # acme's branches in sequence
```

## For agents

The MCP tool `limits` is read-only, and the server tells agents to read it
before planning a solution. `limits_set` and `models_set_limit` are marked
destructive: an agent proposes the old and new value and lets you decide, and an
operator's limit goes to the operator. See [MCP server](mcp.md).
