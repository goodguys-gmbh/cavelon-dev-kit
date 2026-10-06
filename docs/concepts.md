# Concepts

The ideas behind the kit, in the order you meet them. The
[tutorial](getting-started.md) shows them in use; the
[command reference](commands.md) has every option.

## Instance

An **instance** is one Cavelon deployment, reached at a URL such as
`https://cavelon.example.com`. Each instance publishes what it offers:

- its **OpenAPI** (every operation, with its parameters and schemas);
- **`/api/v1/meta/capabilities`**: its version, the features it has turned on,
  the package versions it accepts, and its limits;
- **`/api/v1/meta/error-catalog`**: every validation rule and API error code,
  with its meaning and how to fix it;
- the **package schema**: the JSON Schema of a solution package;
- its **docs** (`/llms.txt` and one Markdown file per page).

`cavelon` reads these and caches them per instance and version, so it knows no
entity type, field or error code of its own. The capabilities carry one
tenant's limits, so they are cached once per tenant, and offline `validate`
checks a package against its own tenant's limits. The docs index lists only the
pages the caller may read, so it is cached once per token and tenant. Both are
named by a hash, never by the tenant or the token. Only you can read the cache:
its files are `0600` in `0700` folders. A newer Cavelon on the server
works with the `cavelon` you have; `login` warns when an instance's contracts are newer
than your `cavelon` understands. `cavelon whoami` and `cavelon status` show the
instance's version.

`cavelon docs search <words>` and `cavelon docs get <page>` read the instance's
own documentation, which describes the version you are connected to. The
search ranks pages by the words of the question in their titles and summaries,
ignores stop words, looks German words for the core concepts up in English, and
lists only pages that match well; `cavelon docs get index` lists them all.

A person with a platform role reads the platform operators' pages with any of
their tokens, but only a personal access token in Platform mode may take the
actions those pages describe. Where the instance says a page is written for
the platform, and the token cannot act in Platform mode, `docs search` and
`docs get` mark the page: "Platform page: the actions it describes need a
personal access token with Platform mode; this token can read the page but
not act on it." An instance that does not say a page's audience gets no mark.

## Tenant

A **tenant** is one organisation's workspace in an instance: its solutions,
knowledge bases, tools, users, settings and limits. Everything `cavelon` does
happens in one tenant.

Which tenant, and which instance, a command uses is decided in this order,
highest first:

1. the options `--instance <url>` and `--tenant <name, slug or id>`;
2. the environment variables `CAVELON_URL` and `CAVELON_TENANT`;
3. the environment file of `--env <name>` (`env/<name>.yaml`, tenant only);
4. the nearest `cavelon.yaml`, from the working directory upwards;
5. over MCP, the tenant `use_tenant` chose for that MCP session;
6. your login, and the tenant you chose with `cavelon use`.

`cavelon login` finds the tenants your token reaches: it uses the only one, or
lets you choose from a numbered list by number or part of a name. `cavelon use`
offers the same list later. Without a terminal, both print one ready
`cavelon use <tenant>` line per tenant instead of asking, and as an MCP tool
`use_tenant` returns the tenants as choices. Over MCP, `use_tenant` chooses
the tenant for that session only and never changes the one you stored, so an
agent never moves where your own commands go. `cavelon whoami` says which
tenant a command would use and why.

`cavelon` resolves a tenant's name or slug to its id once and remembers it for
a day, for the token that resolved it: another token, or a day later, resolves
it again. When the instance refuses a request in the remembered tenant (403 or
404), `cavelon` resolves the slug again; a read then goes to the tenant the
slug names now, and a change is not sent again but refused with
`tenant_moved`, so you run it again and its preview names the new tenant.

A tenant and a solution can be named by name, slug or id wherever `cavelon`
asks for one. `cavelon tenant list` and `cavelon harness list` show all three.
A name that matches nothing is answered with the closest tenants or solutions
and the line to run for each.

An operator's token that may enter every tenant without a membership (a
personal access token without Platform mode and without a tenant allowlist)
works in any tenant you name: `login` and `use` ask for part of its name and
search, and `cavelon tenant list --search <text>` finds its slug.

An older instance does not tell a token which tenants it reaches, and it
refuses a token without Platform mode that it cannot place in a tenant on every
route without a tenant. There, name the tenant by its id:
`cavelon login --tenant <tenant-id>`, `cavelon use <tenant-id>` or
`CAVELON_TENANT`. A member's token there finds a slug only for a tenant whose
settings it may view (`settings.view`), and otherwise needs the name or the id.

A command that prints the next command to run (a `--confirm` line, the
`secrets set` lines of `apply`) prints it with the `--instance`, `--env` and
`--tenant` you gave, so it acts where the first one did.

## Solution (harness)

A **solution** is what answers your users: its agents and their prompts and
models, the skills and tools they use, the knowledge bases they search, its
triggers and its test suites. Cavelon's API calls it a **harness**, which is
why some commands and files say `harness`.

A solution is a **draft** while you build it and **active** once it is live
(see [Readiness and activation](#readiness-and-activation)); one taken out of
service with `cavelon deactivate` is **inactive**, not a draft again: it keeps
its configuration and answers no live traffic until `cavelon activate` puts it
back through its readiness gate. `cavelon harness list` shows the tenant's
solutions with their status; `harness new` and `harness clone` create drafts.

### Persona

Each solution has a **persona**: who the assistant is, for every agent of the
solution. Its name (`bot_name`), its voice and boundaries (`persona_prompt`),
the greeting a conversation opens with, the fallback it gives when it has no
answer, its language and the widget's copy. An agent's `system_prompt` says
what that one agent does. The persona is `package/persona.yaml`: `pull` and
`init` write every field the instance's schema lists, an unset one as a
comment with its default. `cavelon validate` warns when a greeting or fallback
is on but its text is empty (`persona_message_empty`). The instance's page
`concepts/personas` (`cavelon docs get concepts/personas`) explains the rest.

### Default route

A tenant answers where a conversation names no solution (its chat, its widget)
with one solution, its **default route**. A new tenant's default is an empty
`default` solution, so a solution built beside it answers nobody there until it
becomes the default. `cavelon harness list` marks it (DEFAULT); `cavelon
activate` says when the solution it activated is not the default, and
`cavelon harness default <solution>` (or `activate --make-default`) makes it the
default, showing the current one first and changing it only with `--confirm`.
That changes live traffic, so a person decides it. `is_default` in
`harnesses.yaml` is not applied by an import.

An active solution that is not the default still answers a conversation that
names it: `cavelon chat "<message>" --harness <solution>` sends one message to
it and prints the answer, with the session to continue and the conversation
to trace. `cavelon deactivate` takes an active solution out of live traffic
(its status becomes `inactive`); it previews first, changes nothing without
`--confirm`, and refuses the default route until another solution is the
default.

## Package

A **package** is a solution, or a whole tenant's configuration, as one
document in the instance's package format (currently `v3`). Exporting and
importing packages is how `cavelon` reads and writes solutions: `pull` exports,
`apply` imports.

Some sections hold what the whole tenant shares rather than one solution's:
the tenant's settings (`tenant_settings`), its model list (`model_registry`)
and the others the package schema marks `x-cavelon-scope: tenant`. A
solution's `pull` leaves them out of the folder and a solution's `apply` out of
the import, so changing one solution never changes the others by the way.
`pull --include-tenant-wide` writes them, and `apply --include-tenant-wide`
imports them, for every solution of the tenant: the preview then names the
active solutions the change reaches and says to show it to a person.
An instance that does not publish `include_tenant_wide` imports them with
every solution's package; `apply` says so when the folder holds one, and
`validate` warns about such a file in a solution's folder
(`tenant_wide_section`). The tenant's full configuration always carries them.

A package never contains a secret's value. It names the **variables**
(`{{var:name}}`) and **secrets** (`{{secret:name}}`) the solution needs, in
`required_variables` and `required_secrets`, and `apply` lists which of them
the target tenant has not set yet. Setting a secret takes a role allowed to
manage secrets, such as the tenant's Owner: a Builder's token cannot, and
`cavelon whoami` says whether yours may ("may set secrets"). When it may not,
`secrets set`, `activate` and `status` name who sets it instead: a tenant Owner,
in the Admin under Settings › Secrets or with their own token.

## Database query tools

A **database query tool** lets an agent answer from a customer's live
database: the status of an order, the stock of an article. The agent never
writes SQL. A saved, read-only query becomes one tool (`tool_type:
database_query`); the model calls it and fills only the parameters it is
given. A parameter whose `source` is `end_user.id`,
`end_user.external_subject` or `end_user.email` is filled by the instance from
the signed-in visitor, never by the model, so a visitor only reads their own
rows. A query without such a parameter answers visitors who are not signed in
only when it sets `allows_anonymous: true`.

The query travels in the package, on its tool in `package/tools.yaml`; its
connection travels by name and dialect only, never its host, user or password:

```yaml
- slug: order_status
  name: Order status
  description: Status and shipping date of one of the signed-in visitor's orders, by order number.
  tool_type: database_query
  scope: tenant_local
  database_query:
    connection: { name: shop-db, dialect: postgresql }
    sql_text: SELECT number, status, shipped_at FROM orders WHERE number = :order_no AND email = :email LIMIT 5
    parameters:
      - { name: order_no, type: string, description: Order number as printed on the confirmation, e.g. A-10023, max_length: 20 }
      - { name: email, source: end_user.email, type: string }
    max_rows: 5
```

**Who changes what.** A superadmin of the instance creates and tests the
connection and writes or changes a query, in the Admin. A personal access
token never does: an `apply` whose package would create or change a query
(its SQL, parameters, limits, or the tool's own `name` and `description`) is
blocked with `database_query_needs_superadmin`, and that one blocker stops
the whole import. An agent's or skill's override of the tool's name,
description or `max_calls` (`config_overrides` on the assignment) is no query
change. An apply whose queries match the instance's passes. So:

- `cavelon pull` writes the queries into the package; `validate` checks each
  one where the schema allows (every `:name` placeholder against the declared
  parameters, each parameter's type and constraints) and warns
  (`database_query_changed`) for each query tool that differs from the last
  pull or apply, and when a query tool's `params_json_schema` or
  `default_config` changed, which the instance derives from the query and
  ignores (`database_query_fields_ignored`).
- `apply` reads the instance's capabilities first and says, before it sends
  anything, when this credential may not write queries
  (`database_connector.may_write_queries`), when the connector is switched off,
  or when the instance does not run the query's dialect. A blocked preview
  names each query blocker with its file, line and next step.
- To apply the other changes first, leave the query as the instance holds it:
  restore the tool's entry as the last pull wrote it, or remove its
  `database_query` block (a query tool without one keeps the instance's
  query, name and description). Then a superadmin imports the package in the
  Admin (the solution's Agents page, Import JSON), and `apply` passes again.

`cavelon db connections`, `db queries` and `db runs` read the connections, the
saved queries and each query's runs (outcome, error code and row count; never
a value or a row). The tenant Owner may also run `cavelon db test <connection>`
and `cavelon db test-run <query> --value name=value`, which fills the identity
parameters by hand to check what one customer would get. `trace` shows the
code a failed query call answered the model with, such as `identity_required`;
`cavelon explain <code>` says what it means. The instance's page
`cavelon docs get administration/database-connectors` describes the screens.

## The solution folder

A solution lives in a folder with a `cavelon.yaml`, usually a git repository
of its own (a monorepo can hold several). `cavelon init` creates it:

```text
solution/
  cavelon.yaml      instance, tenant, solution, package format, layout; never a token
  package/          one file per top-level section of the package schema
  tests/            one file per test suite
  seeds/            your documents and seed data
  env/test.yaml     where `apply --env test` goes
  env/prod.yaml     where `apply --env prod` goes
  .cavelon/         local state (inventory, previews); ignored by git
  AGENTS.md         a short Cavelon block for coding agents, between markers
```

The package is split along the sections the instance's package schema
defines, so the folder layout follows the schema of the instance you work
with. `pull` writes a file only when its content changed, so `git diff` shows
exactly what changed on the instance. `validate` checks every file against the
schema, offline once the schema is cached.

`pull` never loses your work silently. In a git repository it refuses to
overwrite package files with uncommitted changes; outside one, it refuses to
overwrite or remove a package file that changed since the last pull (an edit,
or a test suite you have not applied yet). A file exactly as the last `pull`
wrote it or the last confirmed `apply` imported it counts as unchanged in both
cases, committed or not: `.cavelon/pulled-files.json` keeps a digest of each,
so a `pull` right after an `apply` goes ahead in a repository without a commit.
`--force` discards the others.

A package file may be a symlink to a file elsewhere in the solution folder:
`validate` and `apply` read the file it leads to, and `pull` writes through the
link. A link that leads out of the solution folder is an error, so a cloned
repository cannot have `apply` send a file from elsewhere on your machine.
Files saved with a UTF-8 byte-order mark, as Windows PowerShell 5.1 writes
them, read like any other.

`cavelon init --from <file>` turns a package file you already have, such as an
export or a blueprint, into this layout. When the package holds one solution
that the tenant does not have yet, `init --from` run from a terminal or shell
creates it as a draft, named as in the package; as an MCP tool it names the
`cavelon harness new` command instead.

## Environments

An **environment file**, `env/<name>.yaml`, says where `--env <name>` sends the
package:

```yaml
tenant: acme-prod          # default: the tenant in cavelon.yaml
harness: support-faq       # must exist: init or `cavelon harness new` creates it
mode: overwrite            # or replace
runtime_bindings:          # the package's runtime requirement -> this tenant's resource id
  crm_connection: 6f1c…
```

`init` creates `env/test.yaml` and `env/prod.yaml`. A `--env <name>` without
its `env/<name>.yaml` is refused (exit 2) before anything is sent, by every
command that takes `--env`. `apply` never creates a solution: when the
solution an env file names is not on the instance, it stops before the preview
(`solution_not_found`) and names the `cavelon harness new` command that
creates the draft. `cavelon init --harness <name>` creates it when you set up
the folder; a name close to an existing solution's is refused as a likely
typo, and `--new` creates it anyway. A typical flow applies to
`test`, runs the tests, then applies the same files to `prod`. Environment
files never hold a token or a secret value; a secret is set in each tenant with
`cavelon secrets set`.

## Preview and confirm

Changing a solution always takes two steps:

1. **`cavelon apply`** validates the files and asks the instance for an import
   **preview**: what would be created, changed and deleted, which active
   solutions it reaches, and what the target still needs (secrets, variables,
   OAuth grants, runtime bindings, trigger identities). Nothing changes. The
   preview gets an id (such as `pv1_…`), and the exact request is stored in
   `.cavelon/previews/`.
2. **`cavelon apply --confirm <id>`** imports exactly that preview.

Every preview, this one and those of the other changing commands, names where
it acts in an `acts on:` line (`target` with `--json`): the instance, the
tenant by name, slug and id, where the tenant was named, and the mode (in the
tenant, or Platform mode outside any tenant). Check it before you confirm.

A recent instance's preview also lists each field it would change
(`object.field: old → new`), the fields an import does not apply (such as a
solution's `status` or `is_default`, each with the command that sets it), and,
when it is blocked, each blocker with its code, package file and path, and a
hint. An older instance's preview shows what it publishes.

A confirm imports nothing and exits 4 when the preview is **stale**:

- the target changed on the instance after the preview: the instance refuses
  the import (`import_preview_stale`);
- the package files changed after the preview, in what they hold rather than
  in formatting or comments (`preview_files_changed`, naming the files). Preview
  again; or, to import what the old preview showed anyway, add
  `--allow-stale` to the confirm;
- the preview is more than a day old (`preview_expired`);
- another preview was imported after it (`preview_superseded`), it was
  imported already (`preview_applied`), or it was discarded
  (`preview_discarded`). The kit remembers why each preview went, so the
  confirm says which.

A preview that changes nothing says "Nothing to import" and is not stored, so
there is nothing to confirm.

If the import's own check finds something the preview did not, it refuses with
its blockers (`package_requirements_changed`, exit 4).

`cavelon status` lists the open previews with when each expires;
`cavelon apply --discard <id>` (or `--discard all`) forgets stored previews, so
none is left for a later agent to confirm. After an import, `pull` takes the
package files as the instance now holds them as its base: a file that changed
after the preview stays a local change unless the instance's export holds the
same content.

`--mode overwrite` (the default) creates and updates; `--mode replace` also
deletes what the package does not hold. A preview that reaches an active
solution, deletes something, or goes to `env/prod` says to show it to a person
before confirming, and the Cavelon skills make the agent do so.

Other commands that delete or overwrite follow the same pattern: `limits set`,
`models set-limit`, `variables delete`, `secrets delete`, `loop cancel`,
`sandbox seed`, `trigger identity`, `harness default`, `activate
--make-default` and `deactivate` show what they would do, and act only with
`--confirm`. In your terminal the flag alone confirms. Run by a coding agent,
the preview prints the confirm command with a token (`--confirm <token>`), and
a bare `--confirm` only shows the preview again (exit 5). Over MCP, their tools
return a `confirm_token` with the preview and act only when `confirm` is that
token, which confirms exactly the change shown.

## Operations and waiting

Work that takes time on the instance, such as ingesting a document or running a
test suite, is an **operation** with an id like `op_test_run_…`. Commands that
start such work (`kb upload`, `test run`, `loop start`, `artifacts export`)
return the operation ids at once.

- `--wait` on those commands, or **`cavelon wait <id>…`**, follows them until
  every one has finished or needs a person, or until the timeout (90 seconds by
  default; `--timeout 5m`).
- When the timeout comes first, the command exits 6 and prints the `cavelon
  wait` command that resumes. The work goes on regardless.
- An operation that **needs a person** (an approval, a review) exits 5 with
  the reason and a link to the Admin.
- **`cavelon watch <id>`** streams each change as it happens.

Waiting needs the instance's operations API; without it, the commands still
start the work and print what they started.

A run that meets a full run cap waits in the queue until a slot is free. The
kit says **waiting for run capacity** instead of calling the run stuck, names
the caps and who raises them, and keeps waiting within the timeout. See
[Limits](limits.md#run-capacity).

## Tests

A **test suite** is a file in `tests/`: a name, the solution it tests, and its
cases. A case has one or more steps, each a user message with either a
`reference_answer` or a list of `evaluation_criteria`:

```yaml
name: Smoke
harness_slug: support-faq
test_cases:
  - name: Return window
    steps:
      - user_message: How long do I have to send something back?
        reference_answer: 30 days from delivery, unused and in its original packaging.
  - name: Not in the FAQ
    steps:
      - user_message: Can you write me a poem about shoes?
        evaluation_criteria:
          - Says that it can only help with questions about the shop.
```

Besides the judge's criteria, a step can carry **assertions**: objects with a
`type` in `evaluation_criteria`, checked in code before the judge runs. A
failed assertion fails the step whatever the judge would say. `tool_called` and
`tool_not_called` check the tools a step called; on a recent instance,
`answered_by` checks which agent answered and `handoff_to` that the step was
handed to an agent, both by agent slug:

```yaml
      - user_message: What does a family ticket cost?
        evaluation_criteria:
          - States the price of the family ticket.
          - {type: handoff_to, value: ticket-agent}
          - {type: answered_by, value: ticket-agent}
          - {type: tool_called, value: search_documents}
```

Where the instance's package schema describes a step's criteria, `validate`
checks each assertion like any other field; where it does not, `validate`
warns that it cannot (`test_assertion_unchecked`), and an instance that does
not know a type grades it as a judge criterion.

`apply` sends the suites with the rest of the package. `cavelon test run`
starts them on the instance, where a judge scores each answer. With `--wait`,
a run whose cases failed exits 1 and names them. So does a run that measured
nothing comparable (steps not run, technical errors, no pass rate): it says
nothing about the solution. A run whose answers wait for a manual verdict
exits 5. `cavelon trace <run>` shows
each case with its score, the agent that answered it, each assertion with pass
or fail, the answer it judged, its error and the judge's reasoning (for a pass
too, when the instance sends it), and leads to the conversation behind it,
span by span, with each command carrying the id its route needs. A knowledge
search's span shows its query, its hits and what the agent recorded it found
(`knowledge_outcome`: `usable_evidence`, `content_gap`, `unusable_hits`,
`retrieval_fault` or `deliberately_unanswerable`), where the instance records
it; `cavelon explain <value>` says what each one means. The agent records
`no_usable_evidence`, which the trace shows as `content_gap`, `unusable_hits`
or `retrieval_fault`, by what the search returned. The package schema also allows cases
that start a trigger and check how its run ends.

A test run never waits for a person. A pipeline that reaches an approval ends
there: the run records that the approval was reached, with its title and
instructions, and the judge grades those; the branches after a person's
decision are not reached by a test. The
[`expense-approval` example](../examples/expense-approval/) has such a suite.

## Readiness and activation

Every solution has a **readiness gate**: the checks the instance runs before a
solution may go live (its agents are complete, what it needs is set, and so
on). `cavelon harness list --readiness` shows each solution's state.

**`cavelon activate`** reads the gate and activates only when it passes; it
never forces. It prints each check with its result and every warning. A
solution that is not ready exits 3 with its blockers. A
personal access token must have been created with **May activate**; otherwise
`activate` is refused before anything is sent (exit 7), and a person activates
in the Admin.

## Credentials

`cavelon` acts with one of two credentials:

- a **personal access token** (`cvpat_…`), created by a person on
  `/account/access-tokens`. It acts as that person, within the roles they have
  and the ceiling chosen for the token. Building and importing solutions needs
  one.
- a **tenant API key** (`cbp_…`), created by a tenant admin for one tenant. It
  suits automation inside that tenant; it cannot import packages, set or delete
  secrets, or create tenants. It always acts in its own tenant, so where
  `--tenant`, `CAVELON_TENANT`, an env file or `cavelon.yaml` names another,
  `cavelon` refuses with `tenant_mismatch` and names both, before anything is
  sent there. Where the instance does not tell the key its tenant's slug or
  name, a tenant named by slug cannot be checked and `cavelon` warns; name it
  by id to have it checked.

A person stores either with `cavelon login`. In CI, set `CAVELON_URL` and
`CAVELON_TOKEN` instead. See [Security](security.md).

## Platform mode

Some changes belong to the instance's operators, not to a tenant: creating
tenants, and limits that apply to every tenant, such as the run caps. They are
made in **Platform mode**: with a personal access token that was created with
**Platform mode** allowed, owned by someone with a global role (such as a
platform admin), and sent without a tenant.

`cavelon` uses Platform mode only where it is needed:

- `cavelon tenant create <slug>` creates a tenant (the role needs
  `tenants.manage`). It asks the instance first whether the token may enter
  Platform mode and, there, holds `tenants.manage`, and stops with exit 7
  before sending anything when it does not. `--use` switches to the new tenant
  only once the instance confirms the token acts in it;
- `cavelon limits set <key> <value> --tenant <tenant>` sends an operator's
  limit change in Platform mode, after checking that the token's role is one
  the change names. See [Limits](limits.md#operators-changes).

A Platform-mode token reaches no tenant by default; choose one with
`cavelon use <name or slug>` before tenant commands. `cavelon whoami` shows
`tenant: none (Platform mode)` until you do. Its `platform mode` line says
whether the token may enter Platform mode at all, with its ceiling
(`not allowed (ceiling tenant_builder)`), and `reaches` says which tenants it
reaches (`every tenant (as operator)` for an operator's token without a tenant
allowlist). A 403 from a platform route never sends you to check the tenant:
it says that the route needs a token that allows Platform mode.

## Built for agents

Every command runs without a prompt (only `login` and `secrets set` read a value,
from a terminal or stdin), prints one JSON document with `--json`, bounds how
long it waits and how much it prints, uses documented
[exit codes](troubleshooting.md#exit-codes), and is marked read-only or
changing. `cavelon mcp` serves the same commands as MCP tools. See
[MCP server](mcp.md).
