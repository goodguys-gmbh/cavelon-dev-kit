---
name: cavelon-authoring
description: Writing and changing a Cavelon solution package in a repository - the package/ files split by schema section, the package schema, the persona (who the assistant is, its greeting and fallback), environments in env/, declaring the variables and secrets a solution needs, and fixing validation codes with cavelon explain. Use when editing files under package/, tests/ or env/ of a folder with cavelon.yaml, when cavelon validate or apply reports an error code, when the user asks to add or change agents, tools, skills, knowledge bases or triggers of a Cavelon solution, or when a limit of the tenant needs changing (cavelon limits set) or they set up a self-hosted model endpoint or its concurrency limit (max_concurrent_requests).
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
- The confirm is the person's. Over MCP, call `limits_set` again with the
  same arguments and `confirm` set to the preview's `confirm_token`: the
  client then asks the person, and nothing changes without their yes. From
  your shell, the preview's `confirm` is the command the person runs in their
  own terminal: give it to them as it stands (it keeps the `--env` and
  `--tenant` of the preview). Never raise a limit on
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
  meanwhile; never ask for an operator's token. A docs page marked "Platform
  page" describes such an operator's task: this token can read it, not do it.
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
  the confirm changes the row, with the person's yes (over MCP the client asks
  them; from your shell they run the confirm command in their own terminal).
  It refuses a row without a `base_url`.
  Where this instance's package format does not carry the field, `validate`
  warns that the import ignores it; set it this way instead.
- `model_registry` is tenant-wide: in a solution's folder, `cavelon apply`
  leaves it out of the import unless `--include-tenant-wide`, which changes it
  for every solution of the tenant (`validate` says so on each finding in the
  file). For one row's limit, prefer `cavelon models set-limit`.

**Propose a limit; the person decides.** Say which value you would set and
why (what the endpoint serves, which rows share it, what waits or fails now),
then wait for the person's answer. Run the confirm command of `models set-limit` only after
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
version and the tenant the package is for; leave it as `pull` or `init`
wrote it (`init` writes a minimal one for a new solution, and the first `pull`
replaces it). Some fields are not applied by an
import: the preview lists them under "not applied", each with the command
that sets it (a solution's `status` with `cavelon activate`, its `is_default`
with `cavelon harness default`).

## Finding out what a section takes

1. Start from what exists: `cavelon pull`, then read the section files. Copy
   the shape of a similar entry rather than inventing fields. A blueprint or
   another instance's export comes in through `cavelon init --from <file>`
   (JSON or YAML): it writes the same files as `pull`, refuses to change files
   that hold something else unless `--force`, and names the sections this
   instance ignores.
2. The schema: `cavelon schema` lists the sections and the file each is kept
   in; `cavelon schema <section>` (the `package_schema` tool) lists a section's
   fields with type, required, allowed values and default, and prints the
   smallest entry with every required field, to copy into the file, and one
   with an entry of each nested list. A nested entry has its own fields: reach
   them by path or type name, as the section's output lists them
   (`cavelon schema agents.handoffs`, `cavelon schema test_suites.test_cases.steps`,
   `cavelon schema PackageAgentHandoff`); where entries take several shapes
   (`test_suites.test_cases.steps.evaluation_criteria`), each shape is listed.
   A pulled file that is `[]` shows no shape; this does. `cavelon validate`
   checks the files against the same schema, and each error names the file,
   line and field. It also checks the references: a duplicate slug, and a
   handoff or a test assertion (`answered_by`, `handoff_to`) naming an agent
   the package lacks, are errors; a skill, tool, knowledge base or solution
   that is neither in the package nor in the tenant's list, a field the schema
   does not have (`package_field_unknown`, "did you mean temperature?"), an
   `llm_model` outside the tenant's model list, and a package naming another
   solution than `cavelon.yaml` (`solution_slug_mismatch`) are warnings. A
   finding's `suggestion` (with `--json`) is the closest name. The import
   preview blocks a name the instance does not have: then `validate` does not
   say "Valid", and `cavelon validate --strict` fails on every warning.
3. Concepts and fields: `cavelon docs search <topic>` (for example "agent
   graph", "tools", "knowledge base", "triggers"), then `cavelon docs get
   <page>`.
4. A code from `validate`, `apply`, a failed request or `cavelon` itself:
   `cavelon explain <code>`. It gives the meaning, the fix (with the command
   that does it, where the instance's fix names an API route) and a docs link;
   for a code it does not know, the closest known ones. `cavelon api describe
   <operation>` shows a body's fields, and the item fields of a list
   (`updates[]`).

## The persona: who the assistant is

Every solution has a persona in `package/persona.yaml`. It is not an agent's
instructions:

- **The persona says who** the assistant is, for every agent of the solution:
  its name (`bot_name`), its voice and its boundaries (`persona_prompt`), the
  greeting a conversation opens with and the fallback it gives when it has no
  answer, its language (`language_hint`), response style, disclaimer and the
  widget's copy.
- **An agent's `system_prompt` says what** that one agent does: its task, its
  tools, when it hands off. Put a rule about tone or identity into the
  persona, and a rule about a task into the agent; `cavelon docs get
  concepts/personas` explains the split.

`pull` and `init` write every field the instance's schema lists; a field that
is not set is a comment with its default (`# bot_name: null`). Remove the `#`
and fill the field in to set it. A file of comments only sets nothing.

- Set at least `bot_name` and `persona_prompt` for a solution people talk to.
- Write `greeting_message` and `fallback_message` in the content language,
  the language the assistant answers in (the knowledge base's, the
  customer's), not the language of this conversation. `language_hint` names
  it.
- A greeting or fallback that is on (`greeting_enabled`,
  `fallback_message_enabled`, both on by default) with an empty text shows
  nothing of the solution's own; `cavelon validate` warns
  (`persona_message_empty`). Write the text, or turn it off.
- Leave the persona out (all fields commented) only for a solution nobody
  talks to directly: a pipeline, a loop, a solution another solution calls.
- Without `harness_id`, the persona operations of `cavelon api`
  (`get_bot_persona`, `upsert_bot_persona`) reach the tenant's default route;
  in a solution folder, `cavelon api` sends the folder's solution, and says
  so. Prefer the package file and `apply` over those operations.

## Rules that keep a package portable

- **Slugs are identities.** An entry is matched by its slug on import; renaming
  a slug creates a new entry and, with `--mode replace`, deletes the old one.
- **Secrets and variables are references only:** write `{{secret:<name>}}` or
  `{{var:<name>}}` where a value is needed, and declare the name (below). Never
  write a secret value into any file, an argument or a message. `cavelon api`
  refuses a body that sets a field the instance marks as a secret value
  (`x-cavelon-secret`: provider keys, passwords and the like): leave the field
  out and let the person enter the value in the Admin.
- **Environment specifics go into `env/`, not `package/`.** Runtime
  requirements (Sandboxes, other solutions) are bound per environment in
  `runtime_bindings`, keyed by the requirement's key, to the target tenant's
  resource id. The preview lists unbound ones under "needs bindings".
- **OAuth grants and trigger execution identities** are never in the package.
  The preview names them with the Admin path where a person sets them.
- **Knowledge-base documents** are not in the repository: the package declares
  the knowledge bases; `cavelon kb upload` brings the documents.
- **A knowledge base reaches an agent only through a tool that reads it.**
  Naming it in a skill's `knowledge_base_assignments` only scopes the tools;
  the skill (or the agent) also needs a built-in that reads a knowledge base in
  its `tool_assignments`: `search_documents` searches it, `list_documents`
  lists its documents by their metadata, and `read_document` reads one by the
  id a search or list returned (`cavelon docs get reference/builtin-tools`).
  A tenant tool whose `builtin_key` is one of them counts too; naming
  `knowledge_base_names` on any other tool (a webhook, an MCP tool) reaches
  nothing. Without such a tool the
  agent answers from memory; `cavelon validate` warns
  (`knowledge_base_without_search_tool`).
- **The model comes from the tenant.** Set an agent's `llm_model` and
  `llm_provider` to a row of `cavelon models list` (MODEL_ID, PROVIDER); the
  models differ per instance and tenant, and the preview blocks one the tenant
  does not have. On a reasoning model (the GPT-5 family, the o-series) from
  OpenAI, Azure OpenAI or Anthropic the instance sends no `temperature` (the
  schema still requires one: keep the default 0.4, and the preview flags any
  other value); the reasoning level is what tunes such a model. Ask the
  person to set it in the agent's **Model** tab in the Admin (Node
  Workbench), then `cavelon pull` brings what the instance stored into
  `package/agents.yaml`. `cavelon docs get concepts/choosing-models` says which
  models take a temperature.
- **Who approves goes on the Approval node, not into the memo.** When the
  brief says who approves, or that nobody approves their own request, set the
  node's `approvers` (tenant roles or access groups, directly or in `tiers`
  chosen by a number at `by`, such as the amount) and `forbid_self_approval:
  true`, where the package schema publishes them; the instance then refuses
  anyone else. Read the approval node in the schema and the human-in-the-loop
  docs for the shape. A test only shows the approval is reached; a person
  decides once per branch.

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
  ask the person otherwise. Setting one needs the permission a secret needs: a
  Builder's role may not (`cavelon whoami` says "may set variables: no", and
  `apply` says so under "needs variables"); then tell the person that a tenant
  Owner sets it, in the Admin under Settings › Variables or with their own
  token. `cavelon variables list` shows them. A variable
  is tenant-wide: replacing a value previews the old and the new one and
  changes nothing without `--confirm` (the `confirm_token` over MCP); every
  solution of the tenant reads it, active ones too, so the confirm needs the
  person's yes: over MCP the client asks them, and from your shell they run
  the confirm command in their own terminal. A new variable is set at once.
- **Secrets are set by a person, never by you.** Tell the person the exact
  command `apply` printed, `cavelon secrets set <name>` (with the `--env` and
  `--tenant` it printed), to run in their own terminal; it asks for the value
  without echoing it. Never ask for the value, never put it into a file,
  an argument or a message, and never put a credential into a variable.
  `cavelon secrets list` (the `secrets_list` tool) shows which are set,
  never a value. A tenant API key cannot set a secret at all, and neither can
  a person whose role may not manage secrets (a Builder): `cavelon whoami`
  says "may set secrets: no", and `secrets set`, `activate` and `status` then
  name who does instead. Tell the person that a tenant Owner sets it, in the
  Admin under Settings › Secrets or with their own token; do not suggest the
  command to someone whose role cannot run it. Where the instance lets no
  token set a secret (`secret_needs_a_person`; the preview names the Admin
  instead of the command), the person sets it signed in to the Admin under
  Settings › Secrets.

## Database query tools

A database query tool lets an agent answer from a customer's live database. A
saved query of explicit `kind: read` or `kind: write` is one tool (`tool_type: database_query` in
`package/tools.yaml`); the model only calls it and fills the parameters it is
given, and never writes SQL. `cavelon schema tools.database_query` lists the
fields this instance takes; `cavelon docs get administration/database-connectors`
says who does what on the instance.

```yaml
- slug: order_status          # the function name the model calls: a-z, 0-9, - and _
  name: Order status          # the label in the Admin
  description: Status and shipping date of one of the signed-in visitor's orders, by order number.
  tool_type: database_query
  scope: tenant_local
  database_query:
    connection: { name: shop-db, dialect: postgresql }   # by name only: never a host, user or password; postgresql, mysql or mssql
    sql_text: SELECT number, status, shipped_at FROM orders WHERE number = :order_no AND email = :email LIMIT 5
    parameters:
      - name: order_no
        type: string
        description: Order number as printed on the confirmation, e.g. A-10023
        pattern: "^[A-Z]-[0-9]{4,8}$"
        max_length: 20
      - name: email
        source: end_user.email   # filled by the instance from the signed-in visitor
        type: string
    max_rows: 5
    allows_anonymous: false
```

- **Who writes a query.** A personal access token whose principal holds
  `database_connectors.manage` may create or change a query with `cavelon
  apply`: the tenant Owner (or Admin) and a superadmin in Tenant mode hold
  that permission. Read `cavelon whoami` and the instance's
  `database_connector.may_write_queries`; the instance decides. The query's
  SQL, parameters, limits and `allows_anonymous`, and the tool's own `slug`, `name` and
  `description`, are all part of the query. `cavelon validate` warns
  (`database_query_changed`) for each query tool that differs from the last
  pull or apply. Edit the definition in `package/tools.yaml`, validate it and
  preview with `cavelon apply`. If the preview's
  `database_queries.would_write` is nonempty, the person approves even for a
  draft: over MCP the client asks them when you confirm the preview id; from
  an agent's shell they run the printed confirm in their own terminal. Only
  after their yes does cavelon request the instance's confirmation id and
  send it with that exact import. An unchanged definition needs no query
  confirmation. A credential without manage is blocked with
  `database_query_needs_superadmin`, stopping the whole import; its hint
  names who this instance permits (older instances can still require a
  superadmin in the Admin). What you may change
  freely is how agents and skills use the tool: the assignment
  (`tool_assignments` with `config_overrides` `name`, `description` or
  `max_calls`) is no query change. `params_json_schema` and `default_config`
  of a query tool are derived from the query, and the instance ignores the
  package's (`database_query_fields_ignored`).
- **Identity parameters.** A parameter with `source: end_user.id`,
  `end_user.external_subject` or `end_user.email` is filled by the instance
  from the signed-in visitor's verified identity (an email only once
  verified), never by the model: it is a required string without
  constraints. Scope every query that returns a person's data by such a
  parameter, so a visitor only reads their own rows. Without a signed-in
  visitor the call answers `identity_required` and the query does not run.
- **`allows_anonymous`.** Set it to true only for public data (stock, prices,
  opening hours) and only on a query without an identity parameter; the
  instance refuses it otherwise (`anonymous_with_context_parameter`).
- **Read query design.** One `SELECT` or `WITH` statement; select only the
  columns the answer needs (never `SELECT *`); always bound the rows (`LIMIT`,
  `TOP`, `FETCH FIRST`) and keep `max_rows` small; constrain every model
  parameter (`pattern`, `max_length`, `enum`, `minimum`/`maximum`) and
  describe it, since the model fills it from the conversation; where a lookup
  has no identity parameter, ask for a second factor (an order number and its
  postal code) rather than one guessable key. Each `:name` in the SQL needs
  exactly one parameter of that name (a literal colon is `\:`); validate checks
  this (`bind_mismatch`) and each parameter's type and constraints.
- **Read stored procedures (SQL Server only).** On an `mssql` connection the SQL
  may instead be exactly one call, `EXEC [schema].[procedure] @p1 = :p1, @p2 =
  :p2`: every argument a placeholder with a declared parameter, no literal,
  `OUTPUT`, option or dynamic SQL (`procedure_call_form`; on another dialect
  `not_select`). `cavelon validate` warns of both. Put fixed values inside the
  procedure. The model gets the first result set. The instance saves, enables
  and runs such a query only while the connection's last test found no write
  privileges, acknowledged or not (`write_privileges_block_procedure`), and
  only for a procedure whose definition the login may read and that only
  reads (`procedure_definition_unreadable`, `procedure_definition_writes`):
  ask the person for a read-only login with `EXECUTE` and `VIEW DEFINITION`
  on procedures that read. Where a procedure is not needed, write a `SELECT`.
- `cavelon explain <code>` explains every code the connector uses: what
  `validate` and the preview name, the codes of a failed call (`timeout`,
  `identity_required`, …) and of a connection test.

### Authoring a write query

Read the instance's schema before using these fields. Set `kind: write`
explicitly, keep `max_affected_rows` small (default 1, at most 100), and keep
`requires_confirmation: true` (the default) so the signed-in person confirms
in chat before execution. `max_calls` takes 1–1000; omitted, the instance
uses 1 for a write and 5 for a read. For the example above, keep its
parameters and replace the SQL and write settings with:

```yaml
    kind: write
    sql_text: UPDATE orders SET status = 'cancelled' WHERE number = :order_no AND email = :email
    max_affected_rows: 1
    requires_confirmation: true
    max_calls: 1
```

One `INSERT`, `UPDATE` or `DELETE`; `UPDATE`/`DELETE` need a parameterized
`WHERE`. Upserts and `RETURNING`/`OUTPUT` are allowed, a leading `WITH` and
multiple statements are not (`write_statement_refused`). On SQL Server one
`EXEC` of a writing procedure is allowed, subject to the instance's
`write_procedure_definition_refused` checks, including no transaction
control or `SET NOCOUNT ON`. Local validation cannot prove a procedure's
behavior; read the server's preview and test results.

Use a dedicated least-privilege write login. A tenant Owner or Admin enables
writes in the Admin with `database_connectors.allow_writes` from a tenant
membership; a global role alone does not grant it. `allows_writes`,
passwords and privilege acknowledgment remain person-only Admin actions,
never query or connection package fields. `db connections` displays the
published flag; validation warns on explicit false (`writes_not_allowed`)
and treats omission or an unreadable/offline list as unknown. Tokens get
`person_only_operation` and tenant API keys get `key_needs_a_person` on
the password and write-enable routes; follow `needs_a_person`.

The import/API approval of a query definition is separate from its
`requires_confirmation` chat execution prompt. Test writes against a test
database: `db test-run` is a dry run that rolls back and prints only the
returned evidence. Never retry `write_outcome_unknown`; ask a person to
check the database before any repetition. `cavelon explain <code>` reads
the instance's published catalog.

### Calling a query from a workflow

Where the instance's package schema supports it, a `tool_call` node names a
saved query with `tool_slug` and `tool_type: database_query`. Its incoming
payload is the query's arguments: only the model-sourced parameter names.
Map workflow data with a Transform before the node; there is no per-node
JSONPath argument mapping. Never include an identity parameter (such as
`email`) or an unknown name: the call answers `invalid_arguments` and runs
nothing. `config_overrides` do not apply to a query node.

For `order_status` above, add this fragment to
`package/registry_entities.yaml`, connect the workflow's entry to
`query_arguments`, and provide the `query_failed` and `show_order` agents.
Keep these nodes and edges in the same solution.

```yaml
orchestration_nodes:
  - slug: query_arguments
    node_type: transform
    config:
      mode: json_mapping
      mapping: { order_no: $.previous_output.order_number }
  - slug: lookup_order
    node_type: tool_call
    config:
      tool_slug: order_status
      tool_type: database_query
      input_schema:
        type: object
        properties: { order_no: { type: string, maxLength: 20 } }
        required: [order_no]
        additionalProperties: false
      output_format: auto
  - slug: query_result
    node_type: router
    config: { strategy: condition }
graph_edges:
  - from_node_ref: { kind: orchestration, slug: query_arguments }
    to_node_ref: { kind: orchestration, slug: lookup_order }
    edge_type: pipeline
  - from_node_ref: { kind: orchestration, slug: lookup_order }
    to_node_ref: { kind: orchestration, slug: query_result }
    edge_type: pipeline
  - from_node_ref: { kind: orchestration, slug: query_result }
    to_node_ref: { kind: agent, slug: query_failed }
    edge_type: condition
    config:
      branch_key: failed
      priority: 0
      condition: { source: previous_output, path: error, operator: exists }
  - from_node_ref: { kind: orchestration, slug: query_result }
    to_node_ref: { kind: agent, slug: show_order }
    edge_type: condition
    config: { branch_key: answered, default: true }
```

- **Output.** Success is `columns`, `rows` (each row an array in column
  order), `returned_rows`, `truncated`, an optional `note`, and the query's
  `source`. Read cells by position, e.g. `$.previous_output.rows[0][1]` for
  the second column. Failure is `{error, message}` with a fixed message,
  never database driver text; the node records the code as its failure and
  keeps this output, so the Router branches on `error`. Read the published
  output under `x-cavelon-output.database_query` on the Tool Call config.
- **Identity.** A conversation-bound run fills identity parameters from its
  signed-in Chat User. A trigger, schedule or inbound-email run has none:
  an identity-bound query, or one without `allows_anonymous: true`, answers
  `identity_required`. `validate` warns on trigger paths that reach these
  queries. A trigger execution identity is not a Chat User; use only a
  public-data query with no identity parameters and `allows_anonymous: true`
  in such a run.
- **Write confirmation and budget.** Every direct Tool Call node refuses a
  write with `requires_confirmation: true` (`confirmation_unavailable`),
  because it cannot wait for the person's click; `validate` warns. Turn it
  off only for an intended unattended write. The current direct-node cap
  counts the query's saved `max_calls` across a workflow run's Tool Call
  nodes, `for_each` iterations and concurrent branches, and persists on
  resume. The next call is refused with `tool_call_limit_reached`, the node
  fails with that code and evidence records `refused`. Read queries have no
  run cap. Agent-stage workflow calls still count per turn; a shared
  Agent/direct counter remains the server acceptance gate. Ordinary chat
  per-turn limits stay as they are. Do not infer runtime acceptance from kit
  fixtures, or raise a node's cap with assignment `config_overrides`.
- **Validation.** `validate` checks argument names in `input_schema` and a
  directly preceding Transform's flat JSON mapping, using the query's
  parameters (or the remembered query when its definition is left out).
  Dynamic arguments still need a test. If neither the package nor the
  tenant's last tools list names the query, it warns with
  `tool_call_database_query_missing`; `--strict` fails. The server's import
  preview checks the reference again. `cavelon explain
  tool_call_database_query_missing` explains the published code. On an
  older instance the kit keeps the schema's rules and skips checks for query
  nodes it does not publish.

## After each edit

1. `cavelon validate` until it reports no errors (`--strict` before an apply
   you expect to pass: it fails on the warnings the preview would block on).
   After writing files by hand, `cavelon fmt` brings them into the form the
   instance's export gives them (field order, the schema's defaults filled in,
   test cases and steps numbered in their written order), so the first `pull`
   after `apply` shows only what changed on the instance; `cavelon fmt
   --check` changes nothing and exits 3 when a file would change. fmt keeps
   no comments (pull keeps none either) and names each file whose comments
   it drops, as the example files' explanations: keep what the person needs
   elsewhere before running it.
2. `cavelon apply --env test` to see what the instance makes of it; the
   preview re-checks everything on the server, including rules that only the
   instance can check (graph rules, references between sections).
3. Follow the cavelon-loop skill for confirming and testing.
