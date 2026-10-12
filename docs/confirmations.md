# Confirmations and YOLO mode

The kit separates checking an exact change from asking a person to approve it.
Routine development inside the work you requested should continue without a
question at each step. Critical changes still need your own answer.

## Default behavior

An ordinary draft import has two technical steps: `apply` previews it, then
`apply --confirm <preview-id>` imports that exact preview. An agent may perform
both steps within your requested work when `show_to_person` is false and there
is no `needs_person` requirement. It reads the preview and reports the outcome;
it does not need an extra chat approval. Known routine `api` operations use the
same approach with their preview's `confirm_token`.

When a change needs you, the preview says `needs_person`:

- `client`: the agent confirms the exact preview and the client presents one
  native approval dialog with the change and its target. No separate chat yes
  is needed before that dialog.
- `terminal`: the client cannot ask you, so run the printed command in your
  own terminal. The agent cannot run that command on your behalf.

A refusal or unanswered dialog changes nothing. The agent must not retry to
obtain a different answer or treat an earlier approval as consent to another
critical change. An operation reserved for the Admin remains there.

## Opt in to YOLO for routine work

A person can additionally enable `--yolo` for one CLI invocation or when
starting an MCP process:

```bash
cavelon --yolo apply --env test
cavelon mcp --yolo
# Bind MCP automation to the environment your tools will use:
cavelon mcp --yolo --env test
```

YOLO performs the technical preview and confirmation internally for eligible
routine changes. An ordinary draft import therefore needs one call instead
of two. Validation, target checks, the instance's preview and stale-request
checks still run. If that preview reveals a critical effect, the command
returns the normal approval step instead of importing automatically.

The allowance belongs to that process's original target: instance, resolved
tenant, credential, local solution folder, selected solution, environment and
its bindings. Each eligible action checks that scope. A different MCP target
uses normal confirmation policy; returning to the original scope may use its
original allowance again. To enable YOLO for another scope, start a process
with that target explicitly selected. YOLO is not an MCP tool argument or a
`cavelon.yaml` option, and a repository cannot silently enable it. Start
without `--yolo` to use the default behavior.

| Operation | Default | With YOLO in the same scope |
|---|---|---|
| Read, validate, inspect traces, ordinary tests | Runs without a kit approval dialog | Same |
| Ordinary draft import with no shared or live effects | Preview, then the agent confirms its id | Internal preview, then import |
| Known routine generic API change | Preview, then the agent confirms its token | Internal preview, then send |
| Start a trigger of the selected draft solution | Preview, then the agent confirms its token | Internal preview, then start within existing tenant budgets |
| Critical change | One personal approval step | Same |
| Unknown API mutation or unclear effects | Personal approval required | Same |
| Person-only operation, secret or credential handling | Existing refusal or Admin route | Same |

Not every token-only command is eligible for automatic execution. In
particular, replacing knowledge-base documents, replacing a Sandbox workspace,
cancelling runs and deleting connections retain their preview and confirmation
steps. A draft label alone does not make every operation routine.

## What still needs your decision

The existing critical gates remain: live routing and activation effects,
changes to active solutions, tenant-wide settings, deletion or replacement
imports, production imports, limits and budgets, trigger identities, and
unknown API changes. Creation, modification and deletion of saved database
queries remain critical even when the selected solution is a draft: their
SQL definitions can affect other agents in the tenant.

Permissions, person-only operations, secret handling, credential changes and
the instance's TLS restrictions remain in force. YOLO does not change a
saved write query's `requires_confirmation` setting or the end user's
approval of an actual database write. Tests and runs still consume their
normal budgets; YOLO grants no extra quota.

The instance's one-use confirmation id still binds the credential, tenant and
exact request. It is a technical request check, separate from the kit's
choice of when to ask you. A native approval is never fabricated to execute a
routine operation.

Your coding client's shell or tool permissions are separate. Cavelon's
`--yolo` cannot disable those dialogs, and a host's automatic-approval mode
cannot answer a critical Cavelon dialog for you.

See [Security](security.md#every-changing-command-and-its-guard) for each
command's guard and [MCP](mcp.md#how-agents-use-it) for the tool protocol.
