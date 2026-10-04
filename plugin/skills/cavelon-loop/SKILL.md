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
  bound to, the solution's state (draft or active, whether it is ready to
  activate, its latest test run), the last pull and the open previews.
  `cavelon whoami` says who the token acts as, when it expires, whether it may
  enter Platform mode and which tenants it reaches.
- **Never handle a token.** If a command exits 7 (not authorised) or says no
  token, ask the person to run `cavelon login --instance <url>` themselves (in a
  terminal, or with a `!` prefix where your client offers one). Never ask them
  to paste a token to you, and never put one in a file or an argument.
- **Secrets are set by a person.** When a preview or `cavelon secrets list`
  names a secret that is not set, tell the person the exact command to run in
  their terminal, `cavelon secrets set <name>` (as `apply` prints it, with its
  `--env` and `--tenant`). Never ask for the value, never pipe or pass one yourself; there is
  no MCP tool for it. Plain-text variables you may set with `cavelon variables
  set <name> <value>` when the value is not a credential.
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
  add `cavelon pull` after it. To start from a package file (a blueprint, an
  export from another instance), run
  `cavelon init --instance <url> --tenant <tenant> --from <file>` instead of
  splitting it by hand or importing it in the Admin. Never guess a tenant or a
  solution, and never ask the person for an id they would have to look up:
  `cavelon tenant list --json` and `cavelon harness list --json` list the
  names, slugs and ids to choose from, and the person names one by its name.
  In their own terminal, a plain `cavelon init` asks them. Ask for the instance
  URL if you do not know it.

## The loop

1. **Pull** what is live: `cavelon pull`. It refuses when `package/` has
   uncommitted changes (outside git: files changed since the last pull);
   commit or apply them first. A file as the last pull or confirmed apply left
   it counts as unchanged, so a pull right after an apply goes ahead without a
   commit. `git diff` then shows what someone changed in the Admin.
2. **Edit** the files in `package/` (one file per schema section) and `tests/`
   (one file per test suite). See the cavelon-authoring skill.
3. **Validate** offline: `cavelon validate`. Fix every error; `cavelon explain
   <code>` says what a code means and how to fix it. After writing files by
   hand, run `cavelon fmt`: it fills in the defaults the export writes, so the
   first `pull` after the apply rewrites only what changed on the instance.
4. **Preview**: `cavelon apply --env test` (or `--harness <name or slug>`). Nothing is
   imported yet. Read the preview: what is created, updated or deleted, which
   active solutions it reaches, what the target still needs (variables and
   secrets with the command that sets each, OAuth grants, runtime bindings,
   trigger identities), loop budgets, and what the instance ignores. A recent
   instance also lists each field it changes (`field changes`, `object.field:
   old → new`) and the fields it does not apply ("not applied", with the
   command that sets each). A blocked preview names each blocker with its
   code, package file and path, and hint; `cavelon explain <code>` says more.
5. **Confirm** exactly that preview: `cavelon apply --confirm <preview-id>`
   (the line `apply` printed, with the same `--env` and `--tenant`). Exit 4 means the target changed since the preview:
   preview again and confirm the new id. When the error lists `blockers`, the
   import's own check found them as it applied: fix what each names (the hint
   says how for a code the kit knows), then preview again.
6. **Seed** knowledge when needed: `cavelon kb upload <dir> --kb <kb>`. It
   refuses before sending when a file is larger than the instance allows or of
   a type it does not accept, and a `.zip` unless the tenant has archive
   uploads on (`kb_upload_archive_enabled`) and it stays within their file
   count, unpacked size and compression ratio (exit 3, naming the limit and who
   changes it). A test
   Sandbox gets its files with `cavelon sandbox seed <sandbox> <folder>`
   (isolated container) or `cavelon sandbox refresh <sandbox>` after the files
   were put on the VM (customer VM).
7. **Test**: `cavelon test run --suite <suite>`, then `cavelon wait <operation>`.
   See the cavelon-testing skill. A solution with a Masterloop node is run with
   `cavelon loop start <trigger>` and followed with `cavelon loop watch <run>`;
   see the cavelon-long-running skill.
8. **Fix** what the results and traces show, and go back to step 2. Commit
   when a step works.

## The default route

A tenant answers its chat and widget, where a conversation names no solution,
with one solution: its **default route**. A fresh tenant's default is an empty
`default` solution, so a new solution built beside it answers nobody there.
`cavelon harness list` marks the default (DEFAULT), and `cavelon activate`
says when the solution it activated is not the default.

- **Ask the person** whether the new solution should become the default. It
  changes live traffic; never decide it yourself.
- With their yes: `cavelon activate --make-default` (or `cavelon harness
  default <solution>`) shows the change, naming the current default; show it,
  then run the same command with `--confirm`.
- `is_default` in `harnesses.yaml` is not applied by `apply`; the preview
  lists it under "not applied".

## Show the person before confirming

Confirm on your own only for a draft solution in a test environment. Stop and
show the preview to the person, and confirm only after they agree, when:

- the preview lists an active solution under "reaches active", or the target
  solution is active;
- the environment is `prod` (`--env prod`), or the preview deletes anything
  (`--mode replace`);
- the preview lists target needs (secrets, grants, identities): only a person
  can provide them, with `cavelon secrets set <name>` or in the Admin.

The same holds for the other commands that take `--confirm`: without it they
only show what would happen. Show it to the person before `cavelon trigger
identity <trigger> <key> --confirm` (it gives a trigger standing authority),
before `cavelon harness default … --confirm` or `cavelon activate
--make-default --confirm` (it moves live traffic), and
before `cavelon sandbox seed … --confirm` or `cavelon loop cancel … --confirm` on
anything but a test Sandbox or a run you started yourself.

**`cavelon api` from your shell has the guards of the MCP `api` tool**, since
`cavelon` sees that a coding agent runs it (`CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_SANDBOX`,
`CURSOR_AGENT`, `GEMINI_CLI`, `COPILOT_CLI`, `COPILOT_AGENT`, `AI_AGENT` or
`CAVELON_AGENT=1`):

- For an operation that is not read-only, it prints the request and a confirm
  token and sends nothing. Show the request to the person when the rules above
  say so, then run the same command again with `--confirm <token>`; it sends
  exactly that request. A changed body or parameter needs a new preview (exit 4).
- It refuses an operation the instance keeps for a person
  (`operation_for_a_person`) and a body that sets a field the instance marks as
  a secret value (`secret_field_for_a_person`), with or without `--confirm`.
  Tell the person what the error's hint says; for a secret field, send the rest
  without it and let the person enter the value (`cavelon secrets set <name>`
  or the Admin). Never work around a refusal, by unsetting the variable or by
  any other way.
- Its `@file` body, `--file` and `--output` stay inside the solution folder.

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
  own docs, for its version.
- `.cavelon/inventory.md`: the tenant's solutions, knowledge bases, tools, test
  suites and sandboxes from the last pull; `cavelon sandbox list` for their
  current state and mode.
- `cavelon api list --search <word>` and `cavelon api <operation>`: any API
  operation the workflow commands do not cover.
