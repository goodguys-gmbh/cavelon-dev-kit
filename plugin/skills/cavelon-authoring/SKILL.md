---
name: cavelon-authoring
description: Writing and changing a Cavelon solution package in a repository - the package/ files split by schema section, the package schema, environments in env/, declaring the variables and secrets a solution needs, and fixing validation codes with cavelon explain. Use when editing files under package/, tests/ or env/ of a folder with cavelon.yaml, when cavelon validate or apply reports an error code, when the user asks to add or change agents, tools, skills, knowledge bases or triggers of a Cavelon solution, or when a limit of the tenant needs changing (cavelon limits set) or they set up a self-hosted model endpoint or its concurrency limit (max_concurrent_requests).
license: Apache-2.0
---

# Authoring a Cavelon package

The package is the solution's configuration. The instance publishes its
format as a JSON Schema; `cavelon` splits it along that schema's top-level
sections, so the files follow whatever the instance version defines. Do not
assume a section or field exists: check the schema or the docs first.

## Before you plan: the instance's limits

Read `cavelon limits` (or the `limits` MCP tool) before you design or change a
solution. It lists, for this tenant, every limit the instance enforces that a
solution can run into: knowledge-base upload size and file types, structured
knowledge-base sizes, agent turns and tool calls, pipeline stages and
`harness_call` depth, webhook, API Request, MCP and model timeouts and sizes,
rate limits, the licence's cap on solutions, and branch concurrency; and the
tenant's quotas (agents, tools, knowledge bases, storage, monthly tokens, the
monthly Processing Step cap) with their use.

- Design within them: a webhook timeout above `webhook_max_timeout_seconds`
  or a document above `kb_upload_max_file_size_mb` fails on the instance.
- Each limit says where its value comes from (`source`: tenant, platform or
  licence), who can change it (`changeable_by`: a tenant admin or the
  operator) and the `setting`. A tenant admin's limit can be changed with
  `cavelon limits set <key> <value>` (see below), or in the Admin; an operator
  changes environment settings or the licence. The run caps
  also name their `origin`: a platform setting the operator changes in the
  Admin, the environment, or the default. Ask the person rather than working
  around a limit, and never edit a limit into the package.
- A fan-out or Map loop runs at most `orchestration_max_branch_concurrency`
  branches at once: a `max_concurrency` above it is capped, and `cavelon
  validate` warns (`branch_width_capped`). When `limits` says branches do not
  run concurrently, every fan-out and Map loop runs one branch after another
  (same result, slower); `validate` warns (`branches_run_in_sequence`) and
  `limits` names the switch that is off and who turns it on. Plan the time a
  long document takes with that, and tell the person.
- A limit the instance does not list does not bind there. `cavelon docs get
  <page>` with a limit's `docs` path explains it.

## Changing a limit

When a solution needs more than a limit allows, or less (a lower rate limit
for a public widget), **propose the change; the person decides.**

- Run `cavelon limits set <key> <value>` without `--confirm` (MCP: `limits_set`
  without `confirm`). It changes nothing and shows the old and the new value,
  the operation it would send and the permissions it needs. Show that to the
  person with your reason (what fails or waits now), and wait for their answer.
- Only after they agreed, run it again with `--confirm`. Never raise a limit on
  your own, never pick a value higher than the need you named, and never change
  one without telling them.
- The same goes for the tenant's monthly inference budget
  (`monthly_inference_token_budget`) and the monthly Processing Step cap
  (`monthly_processing_step_cap`, a Tenant Owner's; `none` removes it): both
  decide what the tenant pays. When new work is refused at the cap,
  `cavelon explain processing_step_cap` says when it resets and who raises it.
- An operator's or the licence's limit (`changeable_by: operator`: the run
  caps, the slot waits, timeouts, `licence_max_harnesses`) goes to the
  operator. Where it publishes a `change` (the run caps), `limits set` sends it
  only with a personal access token in Platform mode of the role it names, and
  otherwise refuses naming the role and the Admin page; `--tenant <tenant>`
  then sets one tenant's own run cap. Without a `change` it cannot be changed
  at runtime. Tell the person who changes it and where, and design within it
  meanwhile; never ask for an operator's token.
- A rate limit only goes down to what the operator allows; above the ceiling
  (`maximum_setting`), it is the operator's too. That holds for the per-visitor
  limits (`rate_limit_chat_visitor_rpm`, `rate_limit_widget_visitor_rpm`) as
  well. A refusal `limit_above_platform_ceiling` names the ceiling and the
  operator's setting; `cavelon explain limit_above_platform_ceiling` lists them.
- Archive uploads are one switch, `kb_upload_archive_enabled` (`true` or
  `false`). The archive caps apply only while it is on (`binds_when` in
  `limits`), and can be set before. The formats are the platform's.
- A refusal for permissions (exit 7) means this credential may not change it:
  ask a person who holds one of the permissions it names. The kit refuses
  before sending when the instance publishes the credential's permissions. An
  instance that does not publish how to change a limit is changed in the Admin.

## Self-hosted model endpoints

A model served from the customer's own endpoint (vLLM, TGI, an on-prem
gateway: a Model Registry row with a `base_url`) answers only so many requests
at once. Declare that number as the row's `max_concurrent_requests`, so chat,
triggers and ingestion wait in line for a free slot instead of overloading the
endpoint.

- Only on a row with a `base_url`; empty means no limit. `cavelon validate`
  refuses the field on a row without one.
- The count is shared by every row that points to the same endpoint (the same
  `base_url`), across tenants: give each such row the same number.
- Ask the person for the number the endpoint serves (for vLLM, its concurrent
  sequences); do not guess high.
- Plan it with the instance's own tutorial before you propose a number:
  `cavelon docs get tutorials/plan-model-capacity` goes from what the server
  serves to the endpoint limit, the run caps and a load test, at this
  instance's version.
- A call that finds no free slot within `model_endpoint_slot_wait_seconds`
  (`cavelon limits`) fails with `model_endpoint_busy`; `cavelon explain
  model_endpoint_busy` says what to raise.
- On rows that already exist, `cavelon models list` shows each row's endpoint
  and `max_concurrent_requests` (never a key). `cavelon models set-limit
  <model_id> <n|none>` shows the old and the new value and changes nothing;
  with `--confirm` it changes the row. It refuses a row without a `base_url`.
  Where this instance's package format does not carry the field, `validate`
  warns that the import ignores it; set it this way instead.

**Propose a limit; the person decides.** Say which value you would set and
why (what the endpoint serves, which rows share it, what waits or fails now),
then wait for the person's answer. Run `models set-limit --confirm` only after
they agreed, and never raise or lower a limit without telling them. A limit
`cavelon limits` names as the operator's (the run caps, the slot waits, the
licence) is not yours or the tenant's to change: tell the person who changes
it and where, as the output says.

## The files

| Path | Holds |
|---|---|
| `cavelon.yaml` | instance, tenant, solution (`harness`), package format version, layout. Never a token. |
| `package/<section>.yaml` | one top-level section of the package each (`manifest`, `agents`, `tools`, …) |
| `tests/<suite>.yaml` | one test suite each, when the layout maps test suites there |
| `env/<name>.yaml` | where `apply --env <name>` goes: `tenant`, `harness`, `mode`, `runtime_bindings` |
| `seeds/` | your seed scripts and data manifests |
| `.cavelon/` | local state (inventory, previews); never committed, never edit |

A file of a section the instance does not know is kept as it is; the preview
lists it under "ignored". `package/manifest.yaml` names the package format
version; leave it as `pull` wrote it.

## Finding out what a section takes

1. Start from what exists: `cavelon pull`, then read the section files. Copy
   the shape of a similar entry rather than inventing fields. A blueprint or
   another instance's export comes in through `cavelon init --from <file>`
   (JSON or YAML): it writes the same files as `pull`, refuses to change files
   that hold something else unless `--force`, and names the sections this
   instance ignores.
2. The schema: `cavelon validate` checks the files against the instance's
   package schema, and each error names the file, line and field.
3. Concepts and fields: `cavelon docs search <topic>` (for example "agent
   graph", "tools", "knowledge base", "triggers"), then `cavelon docs get
   <page>`.
4. A code from `validate`, `apply` or a failed request: `cavelon explain
   <code>`. It gives the meaning, the fix and a docs link.

## Rules that keep a package portable

- **Slugs are identities.** An entry is matched by its slug on import; renaming
  a slug creates a new entry and, with `--mode replace`, deletes the old one.
- **Secrets and variables are references only:** write `{{secret:<name>}}` or
  `{{var:<name>}}` where a value is needed, and declare the name (below). Never
  write a secret value into any file, an argument or a message.
- **Environment specifics go into `env/`, not `package/`.** Runtime
  requirements (Sandboxes, other solutions) are bound per environment in
  `runtime_bindings`, keyed by the requirement's key, to the target tenant's
  resource id. The preview lists unbound ones under "needs bindings".
- **OAuth grants and trigger execution identities** are never in the package.
  The preview names them with the Admin path where a person sets them.
- **Knowledge-base documents** are not in the repository: the package declares
  the knowledge bases; `cavelon kb upload` brings the documents.

## Variables and secrets the solution needs

A package carries names, never values. Declare every variable and secret the
solution needs in two sections of the package (check that the instance's
schema has them: `cavelon validate` reports an unknown section):

```yaml
# package/required_variables.yaml
- name: crm_base_url
  description: Base URL of the CRM API, e.g. https://crm.example.com
```

```yaml
# package/required_secrets.yaml
- name: crm_api_token
  description: API token of the CRM integration user
```

- A name is what the placeholder uses: letters, digits, `_`, `.` and `-`. The
  description tells the person setting it what to enter.
- `pull` and `apply` keep both files; the instance sorts the entries by name.
- `cavelon apply` lists each declared or referenced name the target has no
  value for, under "needs variables" and "needs secrets", with the command
  that sets it (`--json`: `set_commands`).
- **Variables** are plain text that anyone who may view the tenant's settings
  reads. You may set one with `cavelon variables set <name> <value>` (the
  `variables_set` tool) when the value is not a credential and you know it;
  ask the person otherwise. `cavelon variables list` shows them.
- **Secrets are set by a person, never by you.** Tell the person the exact
  command `apply` printed, `cavelon secrets set <name>` (with `--env <name>`
  when there is one), to run in their own terminal; it asks for the value
  without echoing it. Never ask for the value, never put it into a file,
  an argument or a message, and never put a credential into a variable.
  `cavelon secrets list` (the `secrets_list` tool) shows which are set,
  never a value. A tenant API key cannot set a secret at all.

## After each edit

1. `cavelon validate` until it reports no errors.
2. `cavelon apply --env test` to see what the instance makes of it; the
   preview re-checks everything on the server, including rules that only the
   instance can check (graph rules, references between sections).
3. Follow the cavelon-loop skill for confirming and testing.
