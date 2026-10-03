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
  bound to, the last pull and the open previews. `cavelon whoami` says who the
  token acts as and when it expires.
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
  `cavelon init --instance <url> --tenant <tenant> --harness <slug>`; for an
  existing one add `cavelon pull --harness <slug>` after it. To start from a
  package file (a blueprint, an export from another instance), run
  `cavelon init --instance <url> --tenant <tenant> --from <file>` instead of
  splitting it by hand or importing it in the Admin. Ask the person for the
  instance and tenant if you do not know them; do not guess.

## The loop

1. **Pull** what is live: `cavelon pull`. It refuses when `package/` has
   uncommitted changes; commit first. `git diff` then shows what someone changed
   in the Admin.
2. **Edit** the files in `package/` (one file per schema section) and `tests/`
   (one file per test suite). See the cavelon-authoring skill.
3. **Validate** offline: `cavelon validate`. Fix every error; `cavelon explain
   <code>` says what a code means and how to fix it.
4. **Preview**: `cavelon apply --env test` (or `--harness <slug>`). Nothing is
   imported yet. Read the preview: what is created, updated or deleted, which
   active solutions it reaches, what the target still needs (variables and
   secrets with the command that sets each, OAuth grants, runtime bindings,
   trigger identities), loop budgets, and what the instance ignores.
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
identity <trigger> <key> --confirm` (it gives a trigger standing authority), and
before `cavelon sandbox seed … --confirm` or `cavelon loop cancel … --confirm` on
anything but a test Sandbox or a run you started yourself.

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
tool reads an operation without blocking. Exit 5 means a person must act (an
approval, a paused loop): tell them, with the link `wait` prints.

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
