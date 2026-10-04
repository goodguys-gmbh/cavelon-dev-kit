---
name: cavelon-testing
description: Testing and optimizing a Cavelon solution - writing test suites in tests/, running them with cavelon test run, waiting for results, reading traces with cavelon trace, and improving prompts, tools and retrieval from what the traces show. Use when the user wants to test, evaluate, debug or improve the answers of a Cavelon solution, when a test run fails, or before activating a solution.
license: Apache-2.0
---

# Testing and optimizing a Cavelon solution

A solution is ready when its test suites pass on the instance, not when the
package validates. Test against a draft solution or a test tenant
(`--env test`), never by trying things on an active solution.

## Test suites

Suites live in `tests/`, one YAML file per suite, and `apply` imports them with
the package. Each suite has cases, and each case one or more steps (a user
message and what a good answer must contain or do). Copy the shape of an
existing suite from `cavelon pull`, or read `cavelon docs search regression
testing`.

Write cases for:

- the questions the solution exists for, with the facts a good answer needs;
- edge cases: out of scope, ambiguous, a follow-up in the same conversation;
- the tools it must call, and the ones it must not;
- what it must refuse or hand over;
- in a pipeline with an approval: the cases that must reach it, and the ones
  that must not.

## Testing an approval

A test run never waits for a person and never approves anything. A run that
reaches an Approval node ends there: its trace records that the approval was
reached (`test_approval_reached`), with the approval's title and instructions,
and the judge grades the step against those. So write the criteria about what
the person would see: that the approval was reached, who approves, the facts
and the recommendation in the instructions. The branches after the decision
(approved, rejected, expired) are never reached by a test; a person checks them
on a draft solution by deciding a real approval, and you never decide one.
Who may decide (`approvers`, `forbid_self_approval`) is enforced when a person
decides, not in a test: with tiers by amount, write one case per tier that
reaches the approval, and leave the refusals to the instance.
`examples/expense-approval` in the dev-kit repository has such a suite.

## Running

```bash
cavelon apply --env test            # preview, then --confirm <preview-id>
cavelon test run --suite <suite>    # returns operation ids at once
cavelon wait <operation-id> --timeout 90s
```

`wait` exits 6 when the run is still going; run the same `wait` again (keep
each call under your shell's time limit). `test run --wait --timeout 5m` does
both in one call where your client allows long commands; when its wait ends
first, its last line is the command that resumes, with the same timeout. Exit 1 after a run
means a case failed, even though the run itself finished; the output names the
cases that did not pass and why, and `cavelon trace <run>` shows each one. Exit
1 also means the run measured nothing comparable (steps not run, technical
errors, no pass rate): it is no evidence the solution works, so do not go on to
`activate`; find the cause and run again. Exit 5 means answers wait for a
person's verdict or a value a case needs: tell the person.

Besides `pass`, `fail` and `error`, a case's step can end in a status that is
no verdict; `cavelon explain <status>` says what it means and what to do next:

| Status | Means | Next |
|---|---|---|
| `calibration_required` | Not run: a knowledge base it needs had no ready documents, or a `{{var:…}}` value was not set, when the run started (exit 5) | Wait for the documents or set the value, then start a new run |
| `pending_review` | Ran; the answer waits for a person's verdict, because Auto-Evaluate is off (exit 5) | Tell the person |
| `not_run` | The step produced no result: the run stopped or was cancelled first (exit 1) | `cavelon trace <run>`, fix the cause, run again |
| `skip` | A person parked the case with a Skip verdict, or the run was cancelled before it (exit 1) | Run again, or leave it to the person |
| `not_evaluated` | A preparation step (`evaluate: false`): it ran and is not scored | Nothing |

The case's own reason (which knowledge base, which value) is in the output of
`test run --wait`, `wait` and `cavelon trace <run>`.

## Reading what happened

```bash
cavelon trace <test-run-id or operation-id>                                   # cases, scores, judge's reasoning
cavelon trace <conversation-id> --kind conversation                           # one case's traces
cavelon trace <conversation-id> --kind conversation --trace <trace-id>        # one trace's spans
cavelon trace <conversation-id> --kind conversation --trace <trace-id> --span <span-id>
```

Go down only as far as you need: the summary first, then the failing case's
trace, then the one span that went wrong (the model call, the tool call or the
retrieval). Output is bounded; run the command each level prints as printed: it
carries the id its route needs. A case's traces are under its
`conversation_id` (a trigger case's under its `run_id`, `--kind trigger`), not
under the test run's id; a wrong id answers with a hint naming the right one.
A low-scoring pass shows the judge's reasoning too.

## Optimizing

Change one thing at a time, then run the same suite again and compare:

- **Wrong or missing facts:** check retrieval first (which chunks came back in
  the retrieval span). Fix the documents or the knowledge base's settings
  before the prompt.
- **Wrong tool, or a tool called with bad arguments:** sharpen the tool's
  description and parameters, then the agent's instructions about when to use it.
- **Right facts, poor answer:** adjust the agent's instructions; keep them short
  and specific.
- **Too slow or too costly:** read the token counts and durations in the trace;
  a smaller model or fewer tool rounds often suffice for a step.

Record why a change helped in the commit message. When every suite passes,
`cavelon activate --harness <name or slug>` goes through the readiness gate; if the
token may not activate, a person activates in the Admin.
