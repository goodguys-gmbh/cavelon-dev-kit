---
name: cavelon-long-running
description: Long-running work on Cavelon - Masterloop loops that a trigger starts, Sandboxes in their two modes (isolated container, customer VM), seeding a workspace, following and pausing a loop, taking results out, binding a trigger's execution identity, testing loops, and runs that wait for run capacity. Use when a solution has a Masterloop node, a trigger that runs on its own, or a Sandbox, when the user wants to run, watch, stop or test a loop, or when a run stays queued or fails with run_capacity_busy or model_endpoint_busy.
license: Apache-2.0
---

# Long-running work: loops and Sandboxes

A **Masterloop** node runs one solution again and again in bounded iterations
until its check passes, its budget or deadline runs out, or a person stops it.
Each iteration returns `continue`, `wait`, `done` or `blocked`. A loop starts
only through its **trigger**, and stopping the trigger run stops the loop.

A **Sandbox** is a workspace a loop (or an ordinary agent) reads and writes. One
writer at a time: while a run holds a Sandbox, nothing else changes it.

Read the instance's own docs for the details: `cavelon docs search masterloop`,
`cavelon docs search sandbox`. `cavelon sandbox list` shows the tenant's
Sandboxes, their mode and what each mode offers.

## The two modes

| | `isolated_container` | `customer_vm` |
|---|---|---|
| Where | the reference runner's containers | a directory on the customer's own VM |
| Put files in | `cavelon sandbox seed <sandbox> <folder>` | copy them onto the VM, then `cavelon sandbox refresh <sandbox>` |
| Take results out | `cavelon artifacts export <sandbox>` (a tar) | `cavelon sandbox cat <sandbox> <path>` |
| Evidence a loop finished | the runner's trusted receipt (`sandbox receipt`) | the files themselves; completion is only agent-reported |

`cavelon` refuses what a Sandbox's mode does not offer and names the mode (exit 3).
Do not work around it; use the other column.

## Prepare

1. **Author** the loop in `package/` like any other solution (cavelon-authoring
   skill). `cavelon validate`, then `cavelon apply --env test`: the preview shows
   the loop's budget, Sandboxes that an active solution writes to, and triggers
   whose execution identity is missing.
2. **Bind the test Sandbox** in `env/test.yaml` (`runtime_bindings`), never the
   live one: a loop test needs a Sandbox of its own, because only one writer at a
   time may use it.
3. **Check the Sandbox:** `cavelon sandbox validate <sandbox>` (exit 3 lists the
   failing checks). A person enrols VMs, grants Sandbox Access and sets its
   policy in the Admin; you cannot, so ask.
4. **A parent and its iteration solution** go in a fixed order: apply the
   iteration, apply the parent, run the parent's loop suite, activate the
   iteration, activate the parent (cavelon-loop skill, "A Masterloop parent and
   its iteration solution"). `activate` never forces.
5. **Seed it.** Isolated container: `cavelon sandbox seed <sandbox> <folder>`
   shows what it would send and the confirm command that sends it: run that
   one (from your shell it carries the preview's token, `--confirm <token>`;
   a bare `--confirm` exits 5 and sends nothing). The archive **replaces
   the workspace**, so confirm only for a test Sandbox or after the person
   agreed. Customer VM: the files go onto the VM, then `cavelon sandbox refresh
   <sandbox>`.

## Run and follow

```bash
cavelon loop start <trigger> --input @request.json   # previews: the trigger, its solution, the payload
cavelon loop start <trigger> --input @request.json --confirm <token>   # a draft's trigger: starts it, the run id and an operation id
cavelon loop watch <run> --timeout 5m                # each iteration's verdict, then the loop's outcome
cavelon loop iterations <run>                        # state, budget, iterations (a page at a time)
cavelon wait <operation-id> --timeout 90s            # exit 0 done, 1 failed, 5 needs a person, 6 still running
```

A loop started from `cavelon` runs **as the person whose token it is**, checked
again on every iteration, and spends the tenant's budget. So `loop start`
previews first and starts nothing without `--confirm`. For a trigger of a
draft solution, run the confirm command it prints (from your shell it carries
the preview's token; over MCP call `loop_start` again with `confirm` set to its
`confirm_token`). Any other run needs the person's yes (`needs_person` in the
preview): over MCP the client asks them when you confirm with the token; from
your shell the preview names the command they run in their own terminal. If `loop start` exits 8 (a timeout, a cut
connection), the run may have started: retry only with the
`--idempotency-key <key>` its error names, never without it, or a second run
starts and spends the budget again. `cavelon trace <operation-id>` reads the
run's traces. Keep each `watch` or `wait` under your shell's time
limit and run it again to resume (exit 6 means still running). Over MCP, use the
`loop_iterations` and `operation_status` tools; `loop_iterations` never
blocks, and `operation_status` waits only when given a `timeout` (at most 50
seconds); its `resume` is the `operation_status` call to make again.

- **Pause** at the next safe point: `cavelon loop pause <run>`. Resume with
  `cavelon loop resume <run>`. A paused loop makes `wait` and `loop watch` exit
  5 at once: tell the person why it paused and what the watch says to run, do
  not wait forever. A pause that is a verdict on the task (`task_blocked`,
  `invalid_continuation`, …) resumes only with `--reason <the pause reason>`,
  exactly as the loop names it, once the person reviewed the cause; `--reason`
  is never free text. A pause that cannot be resumed is cancelled
  (`cavelon loop cancel <run>`, then the confirm command it prints) and started
  again after the fix; the watch prints both commands.
- An iteration reads **accepted** (with its outcome: continue, wait, done,
  blocked), **rejected**, or **failed** when its child failed. A run that ended
  without a loop names the stage that recorded an error.
  `cavelon trace <child_run_id>` reads one iteration's run.
- **Stop** a run and its loops: `cavelon loop cancel <run>` shows what stops
  and the confirm command (`--confirm <token>` from your shell) that stops it.
  Stop runs you started, not someone else's.
- A run that waits at an **Approval** node, or a loop paused by a guardrail,
  needs a person: `wait` prints the reason and the Admin link. An approval is
  decided by a person, or by an API key an owner granted the explicit scope
  `approvals.decide`. `cavelon` has no command for it, and you never approve
  or reject anything, not through `cavelon api` either: tell the person.

## Waiting for capacity

The instance runs only so many agent runs at once, per tenant and in total. A
trigger or channel run that meets a full cap is not refused: it stays `queued`
(`pending`) and the instance retries it every few seconds until a slot frees.
The run says so itself (`waiting_for_capacity`), so `wait`, `watch`,
`loop watch`, `trace` and `status` say **waiting for run capacity** from the
first poll and name the cap and where it is set. On an instance that does not
say, they infer it once the run has been queued for longer than a normal start
(30 s), and `--json` marks the wait `inferred`. It is not stuck: keep waiting
within your timeout, and run the same command again on exit 6. Do not cancel
and restart it; a new run queues behind the same cap.

What waits for what, and where each limit is set, is the instance's own page:
`cavelon docs get concepts/capacity-and-concurrency` (model endpoint slots, run
caps, branches inside a run, ingestion and rate limits).

Two reasons end work for capacity; each has its code in `cavelon explain`:

- `run_capacity_busy`: every run slot of the tenant or the instance was in use,
  on a path that does not wait (a synchronous call, a test run). Retry later,
  or ask the instance operator to raise `max_concurrent_agent_runs_per_tenant`
  (for this tenant alone, or for all as a platform setting).
- `model_endpoint_busy`: a self-hosted model endpoint was at its
  `max_concurrent_requests` and no slot freed within
  `model_endpoint_slot_wait_seconds`. Retry later, or, if the endpoint can serve
  more, propose raising the Model Registry row's `max_concurrent_requests`
  (`cavelon models list` shows it). The person decides; only then run
  `cavelon models set-limit <model_id> <n>`: over MCP the client asks the person
  when you confirm with the token; from your shell the person runs the confirm
  command it prints in their own terminal.

`cavelon limits` shows the caps, their source and origin, the slot waits, and
branch concurrency (how many items of a Map loop run at once, and whether they
run concurrently at all). Raising them is someone else's decision: tell the
person what the output names. An operator changes a run cap with
`cavelon limits set … --confirm` and a Platform-mode personal access token of
their own; never ask for one.

## Look inside

```bash
cavelon sandbox files <sandbox> [folder]       # what is in the workspace
cavelon sandbox cat <sandbox> <path>           # a file, 32 KiB at a time (--offset reads on)
cavelon sandbox activity <sandbox>             # commands, transfers, validations
cavelon sandbox logs <sandbox> <activity-id>   # one activity's output
cavelon sandbox receipt <sandbox> <activity>   # isolated container only
cavelon trace <run>                            # the run's traces, as for any trigger run
```

Sandbox reads go through a solution the Sandbox allows: `--harness`, or the
folder's solution, or the Sandbox's only allowed one. Exit 7 means Sandbox
Access does not list it; a person changes that in the Admin.

Take results out of an isolated container with `cavelon artifacts export
<sandbox> --path output --wait --out results.tar` (it never overwrites a file),
or start it without `--wait` and download later with `--job <id>`.

## Unattended runs: the execution identity

A scheduled or webhook run has no caller, so it acts as an **API key** bound to
its trigger. `apply` never binds one; it lists unbound triggers in the preview.

```bash
cavelon trigger identity <trigger>                            # who it runs as, what the key must reach
cavelon trigger identity <trigger> <key-name>                 # shows the change
cavelon trigger identity <trigger> <key-name> --confirm       # the person, in their own terminal
```

Binding gives the trigger standing authority over its Sandboxes, so the person
confirms it: over MCP the client asks them when you call `trigger_identity`
with the preview's token; from your shell they run the confirm command in their
own terminal. Name the key by its name or id, never
its value. A personal access token is never an execution identity. Creating keys
and adding a key to a Sandbox's Access stay in the Admin; the output says when
that is still missing.

## Test a loop

Loop tests are ordinary test suites whose cases start a trigger and check what
the loop left behind: the outcome, what it spent, and files in the Sandbox (on an
isolated container also the receipt). Run them like any suite (cavelon-testing
skill):

```bash
cavelon test run --suite <loop-suite> --wait --timeout 10m
```

On a customer VM the test's own file checks are the evidence.

## Exit codes

0 ok · 1 failed or cancelled · 2 usage · 3 refused: invalid, or not offered by
the Sandbox's mode · 4 conflict (the loop or binding changed; read it again) ·
5 needs a person · 6 still running (run the same command again) · 7 not
authorised · 8 server or network error.
