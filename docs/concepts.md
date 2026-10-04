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
entity type, field or error code of its own. A newer Cavelon on the server works
with the `cavelon` you have; `login` warns when an instance's contracts are newer
than your `cavelon` understands. `cavelon whoami` and `cavelon status` show the
instance's version.

`cavelon docs search <words>` and `cavelon docs get <page>` read the instance's
own documentation, which describes the version you are connected to.

## Tenant

A **tenant** is one organisation's workspace in an instance: its solutions,
knowledge bases, tools, users, settings and limits. Everything `cavelon` does
happens in one tenant.

Which tenant, and which instance, a command uses is decided in this order,
highest first:

1. the options `--instance <url>` and `--tenant <slug or id>`;
2. the environment variables `CAVELON_URL` and `CAVELON_TENANT`;
3. the environment file of `--env <name>` (`env/<name>.yaml`, tenant only);
4. the nearest `cavelon.yaml`, from the working directory upwards;
5. your login, and the tenant you chose with `cavelon use <tenant>`.

A personal access token that reaches one tenant uses it by default, and one
whose owner has a default tenant acts there. With several, choose one with
`cavelon use`; `cavelon tenant list` shows those you can see. `cavelon whoami`
says which tenant a command would use and why.

A token without Platform mode that the instance cannot place in a tenant on
its own is refused on every route without a tenant, `/api/v1/auth/me` and
`/api/v1/meta/principal` included, so nothing tells it which tenants it
reaches. Name the tenant by its id then: `cavelon login --tenant <tenant-id>`,
`cavelon use <tenant-id>` or `CAVELON_TENANT`. A name or slug cannot be looked
up for such a token.

A tenant is named by its slug, its name or its id. A token in Platform mode
finds any slug; a member's token finds the slug of a tenant whose settings it
may view (`settings.view`), and otherwise needs the name or the id.

A command that prints the next command to run (a `--confirm` line, the
`secrets set` lines of `apply`) prints it with the `--instance`, `--env` and
`--tenant` you gave, so it acts where the first one did.

## Solution (harness)

A **solution** is what answers your users: its agents and their prompts and
models, the skills and tools they use, the knowledge bases they search, its
triggers and its test suites. Cavelon's API calls it a **harness**, which is
why some commands and files say `harness`.

A solution is a **draft** while you build it and **active** once it is live
(see [Readiness and activation](#readiness-and-activation)). `cavelon harness
list` shows the tenant's solutions; `harness new` and `harness clone` create
drafts.

## Package

A **package** is a solution, or a whole tenant's configuration, as one
document in the instance's package format (currently `v3`). Exporting and
importing packages is how `cavelon` reads and writes solutions: `pull` exports,
`apply` imports.

A package never contains a secret's value. It names the **variables**
(`{{var:name}}`) and **secrets** (`{{secret:name}}`) the solution needs, in
`required_variables` and `required_secrets`, and `apply` lists which of them
the target tenant has not set yet.

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
or a test suite you have not applied yet). `--force` discards them.

A package file may be a symlink to a file elsewhere in the solution folder:
`validate` and `apply` read the file it leads to, and `pull` writes through the
link. A link that leads out of the solution folder is an error, so a cloned
repository cannot have `apply` send a file from elsewhere on your machine.
Files saved with a UTF-8 byte-order mark, as Windows PowerShell 5.1 writes
them, read like any other.

`cavelon init --from <file>` turns a package file you already have, such as an
export or a blueprint, into this layout.

## Environments

An **environment file**, `env/<name>.yaml`, says where `--env <name>` sends the
package:

```yaml
tenant: acme-prod          # default: the tenant in cavelon.yaml
harness: support-faq       # created as a draft when it does not exist yet
mode: overwrite            # or replace
runtime_bindings:          # the package's runtime requirement -> this tenant's resource id
  crm_connection: 6f1c…
```

`init` creates `env/test.yaml` and `env/prod.yaml`. A `--env <name>` without
its `env/<name>.yaml` is refused (exit 2) before anything is sent, by every
command that takes `--env`. A typical flow applies to
`test`, runs the tests, then applies the same files to `prod`. Environment
files never hold a token or a secret value; a secret is set in each tenant with
`cavelon secrets set`.

## Preview and confirm

Changing a solution always takes two steps:

1. **`cavelon apply`** validates the files and asks the instance for an import
   **preview**: what would be created, changed and deleted, which active
   solutions it reaches, and what the target still needs (secrets, variables,
   OAuth grants, runtime bindings, trigger identities). Nothing changes. The
   preview gets an id (`pv_…`), and the exact request is stored in
   `.cavelon/previews/`.
2. **`cavelon apply --confirm <id>`** imports exactly that preview, even if the
   files changed since (it warns).

If the target changed after the preview, the instance refuses the import
(`import_preview_stale`, exit 4) and nothing is imported: preview again. If the
import's own check finds something the preview did not, it refuses with its
blockers (`package_requirements_changed`, exit 4).

`--mode overwrite` (the default) creates and updates; `--mode replace` also
deletes what the package does not hold. A preview that reaches an active
solution, deletes something, or goes to `env/prod` says to show it to a person
before confirming, and the Cavelon skills make the agent do so.

Other commands that delete or overwrite follow the same pattern: `limits set`,
`models set-limit`, `variables delete`, `secrets delete`, `loop cancel`,
`sandbox seed` and `trigger identity` show what they would do, and act only
with `--confirm`.

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

`apply` sends the suites with the rest of the package. `cavelon test run`
starts them on the instance, where a judge scores each answer. With `--wait`,
a run whose cases failed exits 1 and names them. So does a run that measured
nothing comparable (steps not run, technical errors, no pass rate): it says
nothing about the solution. A run whose answers wait for a manual verdict
exits 5. `cavelon trace <run>` shows
each case with its score, error and the judge's reasoning (for a pass too, when
the instance sends it), and leads to the conversation behind it, span by span,
with each command carrying the id its route needs. The package schema also allows cases
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
  secrets, or create tenants.

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
  `tenants.manage`);
- `cavelon limits set <key> <value> --tenant <tenant>` sends an operator's
  limit change in Platform mode, after checking that the token's role is one
  the change names. See [Limits](limits.md#operators-changes).

A Platform-mode token reaches no tenant by default; choose one with
`cavelon use <tenant>` before tenant commands. `cavelon whoami` shows
`tenant: none (Platform mode)` until you do.

## Built for agents

Every command runs without a prompt (only `login` and `secrets set` read a value,
from a terminal or stdin), prints one JSON document with `--json`, bounds how
long it waits and how much it prints, uses documented
[exit codes](troubleshooting.md#exit-codes), and is marked read-only or
changing. `cavelon mcp` serves the same commands as MCP tools. See
[MCP server](mcp.md).
