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
- what it must refuse or hand over.

## Running

```bash
cavelon apply --env test            # preview, then --confirm <preview-id>
cavelon test run --suite <suite>    # returns operation ids at once
cavelon wait <operation-id> --timeout 90s
```

`wait` exits 6 when the run is still going; run the same `wait` again (keep
each call under your shell's time limit). `test run --wait --timeout 5m` does
both in one call where your client allows long commands. Exit 1 after a run
means a case failed, even though the run itself finished; the output names the
cases that did not pass and why, and `cavelon trace <run>` shows each one.

## Reading what happened

```bash
cavelon trace <run-id or operation-id>             # cases and their traces
cavelon trace <run> --trace <trace-id>             # one trace's spans
cavelon trace <run> --trace <trace-id> --span <id> # one span in full
```

Go down only as far as you need: the summary first, then the failing case's
trace, then the one span that went wrong (the model call, the tool call or the
retrieval). Output is bounded; follow the command each level prints.

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
`cavelon activate --harness <slug>` goes through the readiness gate; if the
token may not activate, a person activates in the Admin.
