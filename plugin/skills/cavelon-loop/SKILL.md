---
name: cavelon-loop
description: The development loop for a Cavelon solution kept in a repository - init or pull, edit, validate, apply (preview, then confirm), seed, wait, test, trace, fix. Use when the user wants to build, change, deploy or promote a Cavelon solution (harness, agents, tools, knowledge bases), when the folder has a cavelon.yaml, or when they mention the cavelon CLI.
license: Apache-2.0
---

# The Cavelon development loop

A Cavelon solution lives in two places: the **instance** runs it, and the
**repository** holds its blueprint (`cavelon.yaml`, `package/`, `tests/`,
`env/`). The `cavelon` CLI moves it between them. Every command takes `--json`;
use it when you parse the result.

## Before anything

- `cavelon status` says which instance, tenant and solution this folder is
  bound to, the solution's state (draft, active, or inactive after a
  deactivate; whether it is ready to
  activate, its latest test run), the last pull and the open previews.
  `cavelon whoami` says who the token acts as, when it expires, whether it may
  enter Platform mode, which tenants it reaches, and what it may do there: its
  permissions (an API key's scopes too), whether it may activate and set
  variables, and the operations a person runs instead.
- **Offer only what the credential may do.** Over MCP, a tool whose
  description starts with "Not for this credential" is one the instance says
  this token or key may not use in this tenant; `api_list` marks such
  operations (`may_send: false`). Do not call them to find out: tell the
  person who does it (the description says who), as for a secret. Where the
  instance does not say (an older one), try, and a refusal names what the
  credential lacks.
- **Never handle a token.** If a command exits 7 (not authorised) or says no
  token, ask the person to run `cavelon login --instance <url>` themselves (in a
  terminal, or with a `!` prefix where your client offers one). Never ask them
  to paste a token to you, and never put one in a file or an argument.
- **Secrets are set by a person.** When a preview or `cavelon secrets list`
  names a secret that is not set, tell the person the exact command to run in
  their terminal, `cavelon secrets set <name>` (as `apply` prints it, with its
  `--env` and `--tenant`). Where the instance lets no token set a secret,
  `apply`, `activate`, `status` and `secrets list` name the Admin page
  (Settings › Secrets) instead: tell the person that, not the command. Never ask for the value, never pipe or pass one yourself; there is
  no MCP tool for it. Plain-text variables you may set with `cavelon variables
  set <name> <value>` when the value is not a credential and your role may
  manage the tenant's settings, as for a secret: a Builder's may not, and
  `cavelon whoami` then says "may set variables: no". Then tell the person
  that a tenant Owner sets it, in the Admin under Settings › Variables or with
  their own token.
- **Pass on an update warning.** The first MCP result of a session may warn
  that `cavelon`, the Cavelon plugin or this folder's skills are behind the
  latest release (`… is out; this is …`, `The Cavelon plugin is …`), with the
  commands that update them. Tell the person, with those commands, before you
  go on; they run them (an update takes effect in a new session), you do not.
- **Read the limits before you plan a solution:** `cavelon limits` (the
  `limits` tool over MCP). It lists what this instance allows the tenant
  (upload size and file types, agent turns, tool calls, timeouts, rate limits,
  the licence's solution cap, how many branches of a fan-out run at once and
  whether they run concurrently) and the tenant's quotas with their use, the
  monthly Processing Step cap among them. Plan within them: split a document
  that is too large, keep a webhook under its timeout. Each limit names who can
  change it (a tenant admin, a Tenant Owner, or the operator) and the setting;
  when the plan needs more, propose `cavelon limits set` (without `--confirm`)
  or tell the person who to ask instead of working around it. `cavelon status`
  says when a quota is close to full.
- No `cavelon.yaml` here or above: for a new solution run
  `cavelon init --instance <url> --tenant <tenant> --harness <solution>`, where
  the tenant and the solution are each a name, slug or id; for an existing one
  add `cavelon pull` after it. From your shell, `init --harness "<name>"`
  creates a solution that does not exist yet as a draft; the MCP tool `init`
  never creates one and names the `cavelon harness new <slug> --name "<name>"`
  that does. A name close to an existing solution's is refused as a likely
  typo (`solution_not_found`, naming the closest ones, creating nothing): ask
  the person whether they meant that one, and only for a new solution run
  `cavelon init ... --harness "<name>" --new`. Until a `cavelon.yaml` exists,
  pass `--tenant` (and `--instance`) to every command, `harness new` and
  `pull` included: without it a command acts in the tenant `cavelon use`
  chose, which may be another one. The commands `cavelon` prints carry the
  `--tenant` (and `--env`) you gave, confirm lines included; run them as printed.
  Every preview names where it acts (`acts on:`, `target` in `--json`): the
  instance, the tenant and the mode; show it to the person with the change.
  Over MCP, `use_tenant` chooses the tenant for this session only and never
  changes the person's stored tenant. A tenant API key in `CAVELON_TOKEN` acts
  only in its own tenant: a command that names another is refused with
  `tenant_mismatch`; never work around it, tell the person which key fits. `apply` never creates a solution: when the one an env file names
  is missing it stops with `solution_not_found` and names that command. To start from a package file (a blueprint, an
  export from another instance), run
  `cavelon init --instance <url> --tenant <tenant> --from <file>` instead of
  splitting it by hand or importing it in the Admin; from your shell it creates
  the package's only solution as a draft when the tenant lacks it (the MCP tool
  names the `cavelon harness new` command instead). Never guess a tenant or a
  solution, and never ask the person for an id they would have to look up:
  `cavelon tenant list --json` and `cavelon harness list --json` list the
  names, slugs and ids to choose from, and the person names one by its name.
  In their own terminal, a plain `cavelon init` asks them. Ask for the instance
  URL if you do not know it.

- **Database connections are set up by a person.** A database query tool
  needs a connection of the name and dialect its package names, tested
  successfully, in every tenant it is applied to. A superadmin creates it in
  the Admin (Settings › Security & access › Databases), and the tenant Owner tests it
  (`cavelon db test <connection>`); you never handle its host, user or
  password. Use the same connection name in every tenant and environment
  (`env/test.yaml`, `env/prod.yaml`), each pointing at that environment's
  database, so one package serves them all. `cavelon db instance` says which
  dialects this instance runs and the addresses it connects from, which the
  customer allows through their database's firewall; tell the person both
  before they set up a connection. The dialects are `postgresql`, `mysql` and
  `mssql` (SQL Server). A SQL Server login that can write keeps the
  connection's queries from running (`write_privileges_unacknowledged`) until
  it may only read or a superadmin acknowledges it in the Admin, so ask for a
  read-only login. A stored-procedure query (`EXEC`, SQL Server only) needs
  one without any write privileges, acknowledged or not
  (`write_privileges_block_procedure`), and a procedure that only reads.
  `cavelon db connections` shows which exist, whether their
  last test passed, when their CA certificates expire and why a connection's
  queries, or its stored-procedure queries, cannot be enabled. A pull writes each query's SQL into
  `package/tools.yaml`, so the repository holds it: review it like code.

## The loop

1. **Pull** what is live: `cavelon pull`. It refuses when `package/` has
   uncommitted changes (outside git: files changed since the last pull);
   commit or apply them first. A file as the last pull or confirmed apply left
   it counts as unchanged, so a pull right after an apply goes ahead without a
   commit. `git diff` then shows what someone changed in the Admin. A test
   suite goes back to the file it came from, whatever its name. A solution's
   pull leaves the tenant-wide sections (the tenant's settings, its model
   list) out of the folder, and `apply` leaves them out of the solution's
   import. `pull --include-tenant-wide` writes them; `apply
   --include-tenant-wide` (the MCP tool's `include_tenant_wide`) imports them,
   for every solution of the tenant, so only with the person's say-so; its
   preview names the sections the confirm would import (`would_import`) and
   the active solutions the change reaches, and warns of a change only where
   one of those sections differs from the instance's.
   `validate` warns about a tenant-wide file in the folder
   (`tenant_wide_section`); on an instance that does not publish
   `include_tenant_wide`, `apply` imports such a file anyway and says so:
   remove it unless the person wants it.
2. **Edit** the files in `package/` (one file per schema section) and `tests/`
   (one file per test suite). See the cavelon-authoring skill.
3. **Validate** offline: `cavelon validate`. Fix every error; `cavelon explain
   <code>` says what a code means and how to fix it. Besides the schema it
   finds duplicate slugs, handoffs and test assertions naming an agent the
   package lacks, fields the schema does not have (with "did you mean"), and
   skills, tools, knowledge bases, solutions and models the tenant does not
   hold (warnings: `cavelon pull` or `cavelon models list` refreshes that
   list; validate reads a list no command has read yet). The preview blocks
   those names, so validate does not say "Valid" while one is left;
   `cavelon validate --strict` fails on every warning. A line `Not checked:`
   names a check it could not make (offline, no list). After writing files by
   hand, run `cavelon fmt`: it fills in the defaults the export writes and
   numbers test cases in their written order, so the first `pull` after the
   apply rewrites only what changed on the instance. It drops comments, as
   pull does, and names each file whose comments it drops (`cavelon fmt
   --check` says so first): keep notes the person needs elsewhere.
4. **Preview**: `cavelon apply --env test` (or `--harness <name or slug>`). Nothing is
   imported yet. Read the preview: what is created, updated or deleted, which
   active solutions it reaches, what the target still needs (variables and
   secrets with the command that sets each, OAuth grants, runtime bindings,
   trigger identities), loop budgets, and what the instance ignores. A recent
   instance also lists each field it changes (`field changes`, `object.field:
   old → new`) and the fields it does not apply ("not applied", with the
   command that sets each). A blocked preview names each blocker with its
   code, package file and path, and hint; `cavelon explain <code>` says more.
   A preview that changes nothing says "Nothing to import" and stores no
   preview: there is nothing to confirm.
   **Database query changes need manage permission and the person's yes.**
   A PAT holding `database_connectors.manage` (the tenant Owner or a
   superadmin in Tenant mode) may apply them. A nonempty
   `database_queries.would_write` in the instance's preview needs person
   approval even on a draft: over MCP the client asks; from an agent's shell
   the person runs the printed confirm. A credential without that permission
   gets `database_query_needs_superadmin`, which stops the whole import;
   the blocker's hint names who this instance permits. To apply the other
   changes now, leave the query as the instance holds it
   (restore the tool's entry as the last pull wrote it, or remove its
   `database_query` block) and preview again. Matching definitions need no
   query confirmation, and a no-op preview stores nothing.
5. **Confirm** exactly that preview: `cavelon apply --confirm <preview-id>`
   (the line `apply` printed, with the same `--env` and `--tenant`). Exit 4
   means the preview is stale and nothing was imported: the target changed on
   the instance (`import_preview_stale`; a recent instance names what changed), the package files changed since
   (`preview_files_changed`, naming them), the preview is more than a day
   old (`preview_expired`), another preview was imported after it
   (`preview_superseded`), it was imported already (`preview_applied`), or it
   was discarded (`preview_discarded`). Preview again, show the new preview when the rules
   below say so, and confirm the new id. Use `--allow-stale` only when the
   person wants exactly the old preview imported. When the error lists
   `blockers`, the import's own check found them as it applied: fix what each
   names (the hint says how for a code the kit knows), then preview again.
   Discard a preview you will not confirm (`cavelon apply --discard <id>`, or
   `--discard all`), so no later agent confirms it; `cavelon status` lists the
   open ones with when each expires.
6. **Seed** knowledge when needed: `cavelon kb upload <dir> --kb <kb>`. It
   refuses before sending when a file is larger than the instance allows or of
   a type it does not accept, and a `.zip` unless the tenant has archive
   uploads on (`kb_upload_archive_enabled`) and it stays within their file
   count, unpacked size and compression ratio (exit 3, naming the limit and who
   changes it).
   **Updating a document**: upload the new version under the same file name.
   `kb upload` names each file that matches an active document of the
   knowledge base, and what happens to it depends on the instance (try it with
   `--dry-run` first):
   - An instance that replaces same-named documents does so on every upload:
     "faq.md exists (0f3c…) and is replaced by the upload (--keep-both keeps
     it)". `--keep-both` keeps both.
   - On an older instance the old version stays active next to the new one,
     and both answer: "faq.md exists (0f3c…) and stays active". Upload with
     `--replace`: where the instance's upload can replace by id, the old
     document is replaced once the new file is verified; where it cannot,
     `--replace` shows the documents it would deactivate after the upload and
     needs `--confirm`: show the person that first.
   - A file whose content is already an active document is not uploaded
     again: "identical to the active document …; nothing new was created
     (deduplicated)", with nothing to wait for and nothing replaced. Where the
     instance publishes its documents' file hashes, `--dry-run` says it first
     ("nothing new would be created"; `--json`: `identical`, and
     `content_compared` false where it cannot tell).
   A test Sandbox gets its files with `cavelon sandbox seed <sandbox> <folder>`
   (isolated container) or `cavelon sandbox refresh <sandbox>` after the files
   were put on the VM (customer VM).
7. **Test**: `cavelon test run --suite <suite>`, then `cavelon wait <operation>`.
   See the cavelon-testing skill. A solution with a Masterloop node is run with
   `cavelon loop start <trigger>` (it previews; run the confirm command it
   prints) and followed with `cavelon loop watch <run>`;
   see the cavelon-long-running skill.
8. **Fix** what the results and traces show, and go back to step 2. Commit
   when a step works.

## The default route

A tenant answers its chat and widget, where a conversation names no solution,
with one solution: its **default route**. A fresh tenant's default is an empty
`default` solution, so a new solution built beside it answers nobody there.
`cavelon harness list` marks the default (DEFAULT), and `cavelon activate`
says when the solution it activated is not the default.

Activation can also take this route without `--make-default`. Read its
published preview: `takes_default_route: true` needs the person's yes,
including when `takes_default_route_from` and `_from_name` are both null
(assigning an unassigned route). False with null/null means no takeover.
An omitted flag is unknown, even if the schema declares a false default,
and still needs the person. Never infer the effect from instructions, a
default slug or other configuration. The preview reserves no state; the
successful activation's `took_default_route` and corresponding from/name
fields report the actual effect, which may differ. `status` shows the
preview too.

- **Ask the person** whether the new solution should become the default. It
  changes live traffic; never decide it yourself.
- With their yes: `cavelon activate --make-default` (or `cavelon harness
  default <solution>`) shows the change, naming the current default; show it.
  You cannot confirm it yourself: over MCP the client asks the person when you
  call the tool with the preview's token; from your shell the person runs the
  confirm command it printed in their own terminal. `harness default` refuses a draft
  (`solution_not_active`, exit 4): only an active solution can be the
  default, so use `cavelon activate --make-default`.
- `is_default` in `harnesses.yaml` is not applied by `apply`; the preview
  lists it under "not applied".
- To try an active solution that is not the default, talk to it by name:
  `cavelon chat "<message>" --harness <solution>` (the `chat` tool over MCP)
  prints its answer, the session to continue with `--session`, and the
  conversation to trace. A draft answers only a person's token, as a
  Playground run.
- `cavelon deactivate --harness <solution>` takes an active solution out of
  live traffic: it previews, and only the confirm command it prints
  deactivates. Its status becomes `inactive`, not `draft`: it keeps its
  configuration, answers no live traffic, and `cavelon activate` puts it back
  through its readiness gate. It is the person's decision, like the default
  route; the default route itself is refused until another solution is the
  default.

## Show the person before confirming

Show every preview to the person. Confirm on your own only a preview that
needs no person: `apply` to a draft solution in a test environment (the
preview says nothing about showing it to a person), `loop start` of a trigger
of a draft solution, `loop cancel` and `sandbox seed` of a test run or Sandbox
you started, and `kb upload --replace`. Stop, show the preview, and wait for
the person when:

- the preview lists an active solution under "reaches active", or the target
  solution is active;
- the environment is `prod` (`--env prod`), or the preview deletes anything
  (`--mode replace`);
- the preview changes tenant-wide sections (`tenant-wide: … change for every
  solution of the tenant, reaching the active solutions …`, after
  `--include-tenant-wide` or on an instance that imports them anyway): every
  solution of the tenant sees the change;
- the instance's preview lists query writes under
  `database_queries.would_write`: its SQL changes what agents may read from
  the tenant's database, even on a draft;
- the preview lists target needs (secrets, grants, identities): only a person
  can provide them, with `cavelon secrets set <name>` or in the Admin, as the
  preview names it.

**The person's yes is theirs to give.** For these, and for `tenant create` (a
new tenant on the platform), `variables set` that replaces a value (every
solution of the tenant reads it) and `variables delete`, `loop start` of a
trigger whose solution is not a draft (a run acts as the person and spends
budget), `limits set`, `models set-limit`, `trigger identity` (standing
authority for a trigger), `harness default`, `activate --make-default`,
`activate` of a solution its preview says a channel or trigger reaches,
whose activation takes the default route, or whose reach or route effect is unknown,
`deactivate` (they move live traffic), and `api` for any operation that is
not read-only, `cavelon` does not take your confirm as theirs. Their preview
says how in `needs_person`:

- `"client"` (over MCP, where your client can ask the person): show the
  preview, then call the tool again with the same arguments and `confirm` set
  to its token (for `apply`, the preview id). The client then asks the person
  to approve exactly that change, and nothing changes without their yes. A no,
  or no answer within 10 minutes, returns `confirm_declined` (exit code 5):
  ask the person what they want instead of trying again.
- `"terminal"` (your shell, or a client that cannot ask): the preview's
  `confirm` is the command the person runs in their own terminal, not with `!`
  in your session. Give them that command and wait; never run it yourself. A
  token is refused (`confirm_needs_person`, exit code 5).

A new variable needs no confirm. A solution needs none only when no channel
or active trigger reaches it and readiness explicitly publishes
`takes_default_route: false`. If the single read leaves `channel_count`
null, the kit reads the matching list row; an unreadable list, missing row
or missing count keeps reach unknown and needs the person.

An instance that publishes `confirmations.enforced` checks the person's yes
too: after it, `cavelon` asks the instance for a confirmation id for exactly
that request and sends it along; you never handle it. `confirmation_required`
or `confirmation_invalid` (exit code 5) means the instance changed nothing:
show the person the preview again and let them confirm it (in the client's
dialog or their own terminal), never retry on your own.

**Over MCP, confirm with the preview's token.** `api`, `tenant_create`,
`variables_set` where it replaces a value, `loop_start`, `limits_set`,
`models_set_limit`, `loop_cancel`, `sandbox_seed`, `trigger_identity`,
`harness_default`, `deactivate`, `activate` of a solution a channel or
trigger reaches, whose activation takes the default route or whose reach or
route effect is unknown, or with `make_default`, and
`kb_upload` where it would deactivate documents return a `confirm_token` with
their preview. Show
the preview, then call the tool again with the same arguments and `confirm`
set to that token; it makes exactly the change shown, after the person's yes
where the preview says `needs_person`. `confirm: true` is
refused (`confirm_token_required`), and a token of another change returns the
new preview with `token_mismatch` (exit code 4): show that one instead. Tool
arguments are spelled in snake_case (`make_default`, `keep_both`, `dry_run`);
an argument a tool does not list is refused (`unknown_argument`) with the
closest one named. Over MCP the next steps a tool returns (hints, `next`,
`resume`, `confirm`) are tool calls, `harness_default {"solution":"support"}`:
make the call as written, filling a value in angle brackets (a
`confirm_token` comes from that tool's preview).

**From your shell, `--confirm` takes the same token, where you may confirm.**
Run by a coding agent, `loop start` of a draft's trigger, `loop cancel`,
`sandbox seed` and `kb upload --replace` print their preview with a confirm
token and the command that confirms it (`… --confirm <token>`). Show the
preview, then run exactly that command. The changes that need the person's yes
print no token and name the command the person runs in their own terminal. A
bare `--confirm`, as the docs show it for a person's terminal, changes nothing
from your shell and exits 5; a token of another change exits 4 with the new
preview. A line printed before its preview exists ends in
`--confirm <confirm_token of its preview>`: run the command without
`--confirm` first for the preview and its token.

**`cavelon api` from your shell has the guards of the MCP `api` tool**, since
`cavelon` sees that a coding agent runs it:

- For an operation that is not read-only, it prints the request and the
  command the person runs in their own terminal to send it, and sends nothing.
  Show both to the person; you cannot send it yourself, with or without a
  token (`confirm_needs_person`). Over MCP the `api` tool sends it after the
  person's yes in the client.
- It refuses an operation the instance keeps for a person
  (`operation_for_a_person`) and a body that sets a field the instance marks as
  a secret value (`secret_field_for_a_person`), with or without `--confirm`,
  with exit code 5 (needs a person). `cavelon api describe <operation>` shows
  both marks up front.
  Tell the person what the error's hint says; for a secret field, send the rest
  without it and let the person enter the value (`cavelon secrets set <name>`
  or the Admin). Never work around a refusal in any way.
- Its `@file` body, `--file` and `--output` stay inside the solution folder.

`cavelon secrets set` and `cavelon secrets delete` are refused from your shell
(`operation_for_a_person`, exit 5), with or without `--confirm`, before a value
is read or anything is sent: give the person the command from the error's hint
to run in their own terminal.

`activate` goes through the readiness gate only, and only with a token that
may activate. It never forces: activating without the evidence stays a person's
decision in the Admin, so do not ask for it as a shortcut.

## A Masterloop parent and its iteration solution

A parent whose Masterloop node runs another solution (its iteration solution)
and that iteration solution are two solutions, applied and activated one at a
time. The iteration has no test of its own: the parent's loop suite is its
evidence. Keep this order; it needs no override:

1. **Apply the iteration solution** (`cavelon apply`, then `--confirm`). It
   stays a draft.
2. **Apply the parent**, with the iteration solution's id under
   `runtime_bindings` in its `env/<name>.yaml`. A draft parent binds a draft
   iteration; an active or paused parent refuses one
   (`runtime_draft_iteration_needs_draft_parent`), so apply the pair into a
   draft parent.
3. **Run the parent's loop suite** (`cavelon test run --suite <loop-suite>
   --wait`), with a trigger case whose loop runs through the iteration solution.
4. **Activate the iteration solution**: `cavelon activate --harness <iteration>`.
5. **Activate the parent**: `cavelon activate --harness <parent>`.

When `apply` or `activate` meets a step out of order, its `hint` says which
step and repeats the order (`cavelon explain <code>` too). Do not work around it.

## Long-running work

`kb upload`, `test run`, `loop start`, `sandbox seed` and `artifacts export`
return operation ids at once. `cavelon wait <ids> --timeout 90s` returns the
state when the time is up (exit 6 means still running; the same `wait` again
resumes). Keep each wait under your shell's command time limit, and run longer
waits in the background if your client can. Over MCP, the `operation_status`
tool returns the state at once, or, given a `timeout`, waits up to it (at most
50 seconds) and reports `waited_ms`; `timed_out` is true only when it waited
the whole timeout. Exit 5 means a person must act (an approval, a paused
loop): tell them, with the link `wait` prints.

**Never approve anything.** An approval is decided by a person, or by an API
key an owner granted the explicit scope `approvals.decide`; never by you, and
not through `cavelon api` either, even when the token could reach the route.

Loops, Sandboxes and execution identities have their own skill:
cavelon-long-running.

## Exit codes

0 ok · 1 other error · 2 usage · 3 validation failed · 4 conflict or stale
preview · 5 needs a person · 6 timed out (still running) · 7 not authorised ·
8 server or network error.

## Where to read more

- `cavelon docs search <query>` and `cavelon docs get <page>`: the instance's
  own docs, for its version. They are in English; a German question works for
  the core concepts, English words for the rest. `cavelon docs get index`
  lists every page. A page marked "Platform page" (`mark` in `--json`)
  describes an operator's actions this token cannot take: tell the person who
  can, never ask for a Platform-mode token.
- `.cavelon/inventory.md`: the tenant's solutions, knowledge bases, tools,
  skills, models, test suites and sandboxes from the last pull; `cavelon sandbox list` for their
  current state and mode.
- `cavelon api list --search <word>` and `cavelon api <operation>`: any API
  operation the workflow commands do not cover.
