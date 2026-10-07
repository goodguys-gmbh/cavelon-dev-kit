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
- the tools it must call, and the ones it must not (`tool_called`,
  `tool_not_called`, below);
- what it must refuse or hand over, and to which agent (`handoff_to`,
  `answered_by`);
- in a pipeline with an approval: the cases that must reach it, and the ones
  that must not.

## Assertions: tools and routing

A step's `evaluation_criteria` can hold, besides the judge's criteria (plain
sentences), **assertions**: objects with a `type` and a `value`, checked in
code before the judge runs. A failed assertion fails the step whatever the
judge says, so use them for facts with one right answer:

| Type | Value | Passes when |
|---|---|---|
| `tool_called` | tool slug | the step called the tool |
| `tool_not_called` | tool slug | the step did not call it |
| `answered_by` | agent slug | that agent produced the answer (it made the step's last model call) |
| `handoff_to` | agent slug | the step handed the turn to that agent |

The answer text cannot show which agent wrote it, so make routing part of the
regression wherever a solution has a handoff. For an entry agent that should
hand price questions to a ticket agent:

```yaml
test_cases:
  - name: Family ticket price goes to the ticket agent
    steps:
      - user_message: What does a family ticket cost?
        evaluation_criteria:
          - States the price of the family ticket.
          - {type: handoff_to, value: ticket-agent}
          - {type: answered_by, value: ticket-agent}
          - {type: tool_called, value: search_documents}
  - name: Opening hours stay with the front desk
    steps:
      - user_message: When are you open?
        evaluation_criteria:
          - States the opening hours.
          - {type: answered_by, value: front-desk}
```

`answered_by` with the entry agent's slug checks the opposite: that a question
stays where it is. A consulted agent is a tool call of the agent that consulted
it, which still answers, so check a consultation with `tool_called` and the
consult tool's name, not with `handoff_to`. Use the slugs from
`package/agents.yaml`.

`cavelon validate` checks the assertions against the instance's package
schema where the schema describes a step's criteria (`cavelon schema
test_suites.test_cases.steps.evaluation_criteria` lists each shape): a
misspelt `type` is one error with the closest type, an `answered_by` or
`handoff_to` naming an agent the package lacks is an error, and a
`tool_called` or `tool_not_called` naming a tool that is nowhere is a warning,
each with "did you mean". Cases and steps run in their written order once
`cavelon fmt` has numbered them (`sort_order`, `step_order`); left out, the
instance orders cases by name. Where the schema does not describe a step's criteria, it
warns `test_assertion_unchecked`: an instance that does not know a type grades
it as a judge criterion instead of checking it, so read `cavelon docs get
concepts/regression-testing` for the types the instance knows before relying on
`answered_by` or `handoff_to`.

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

## Database query tools

Test a solution with database query tools against a test database, never the
customer's live one: the test tenant (`--env test`) has a connection of the
same name pointing at a test database with known rows, set up by a person in
the Admin. Then:

- A step can assert the agent calls the query (`tool_called` with the tool's
  slug), and the judge checks the answer against the known rows.
- For identity-scoped queries (`end_user.*`), choose a test Chat User of the
  acting tenant: `cavelon whoami` shows the tenant;
  `cavelon api list_chat_users -p tenant_id=<tenant_id> --json` lists its
  identities (`chat_users.view` is needed). Use
  `cavelon test run --suite <suite> --as-chat-user <id> --wait --timeout 5m`
  or `cavelon chat "<message>" --harness <solution> --as-chat-user <id>`.
  A personal access token needs `knowledge_bases.view` and `end_users.read`,
  besides permission to run the suite. Knowledge reads use that person's
  groups, and queries bind their identity. The override is on each run
  request: never edit a saved suite just to choose a test reader.
- For an `end_user.email` parameter, check the published `email_verified`
  flag. A manually created, unverified Chat User cannot prove the address:
  its query answers `identity_required` and asks for sign-in. Verification
  comes from the widget's email code or SSO. An older instance may omit the
  flag; do not infer verification from an email being present.
- Check one identity's known rows, another identity's different rows, and
  an audience run that asks for sign-in. Omit the option to use the suite's
  saved reader (audience by default); an audience run has no identity, so a
  query with an identity parameter or without `allows_anonymous` runs
  nothing. Assert the query tool was called and the answer contains only
  the chosen identity's rows. A deleted or cross-tenant reader must be
  refused, not fall back to audience. An older instance may not support a
  reader override, or may refuse a PAT on it even with reader fields:
  follow the command's actionable refusal and ask its operator for support.
- To check what an identity-scoped query returns for one customer, the tenant
  Owner runs it once with `cavelon db test-run <query> --value <name>=<value>`,
  identity parameters included; it shows what the model would see. Never put
  a real customer's data into a test file.
- A stored-procedure query (SQL Server) is test-run the same way; the
  instance refuses the run while the connection's login can write or the
  procedure's definition writes or cannot be read, with a code
  `cavelon explain` explains. A run whose procedure committed or rolled back
  fails with `query_failed` and a `notice`: the query is switched off, and a
  person fixes the procedure. `cavelon db test <connection>` lists the
  procedure queries whose procedure no longer passes (`procedure_findings`).
- `cavelon db runs <query>` lists each run's outcome and error code (never a
  value or a row), and `cavelon trace` shows the code a failed call answered
  the model with on the tool's span (`error_code`); `cavelon explain <code>`
  says how to fix it.

## Reading what happened

```bash
cavelon trace <test-run-id or operation-id>                                   # cases, assertions, answers, judge's reasoning
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
The spans list suggests the span to open first: the one that failed, else the
last model call, else the knowledge search.

Each step lists its assertions with pass or FAIL (`Assertions (1 of 2
passed)`, then one line each with the expected and observed value of a failed
one and the reasoning), the judge's criteria with their scores, and the
answer it judged, shortened (`assertions[]` and `answer` in `--json`; the
whole answer with `--full`). Read the assertions, not only the judge's
sentence: "meets the only criterion" can stand above a failed `answered_by`.
`test run --wait` names a failed case's failed assertions and its answer too.
Each step names the agent that answered it (AGENT, `agent` in `--json`), and a
case that did not pass says `Answered by: <agent>`: the first thing to check
when a routing assertion failed.

A knowledge search's retrieval span (`--span <span-id>`) shows the query, its
`knowledge_outcome` and the hits as a table (rank, title, score, whether it
may be cited, document id); `retrieval` in `--json`. Its tool span shows the
outcome too; a search without one is one the agent did not classify, and an
instance that records none shows no such column. The agent records one of four
values, and the trace refines `no_usable_evidence` by what the search returned,
so the trace never shows that value itself (`cavelon explain <value>` says
more, from the instance's catalog where it lists them):

| The agent records | The retrieval span shows | When |
|---|---|---|
| `usable_evidence` | `usable_evidence` | The hits support the answer |
| `no_usable_evidence` | `content_gap` | The search returned no hits at all |
| `no_usable_evidence` | `unusable_hits` | It returned hits, and none answers the question |
| `no_usable_evidence` | `retrieval_fault` | The search failed, returned a partial result, or had no knowledge base it may read |
| `retrieval_fault` | `retrieval_fault` | The agent saw the search report a fault |
| `deliberately_unanswerable` | `deliberately_unanswerable` | Policy or the request, not missing content, made the agent decline |

A question the knowledge base does not cover usually shows as `unusable_hits`,
not `content_gap`: a search almost always returns its closest passages. Read
both as a gap to fill.

## Optimizing

Change one thing at a time, then run the whole suite again and compare, not
only the case that failed: a prompt change that fixes one case can break
another. In one solution, a line "just answer directly" made the agent answer
an off-topic question its persona forbade.

- **Wrong or missing facts:** check retrieval first. Under a case that did not
  pass, `cavelon trace <run>` shows a `Knowledge:` line with the outcomes of
  its knowledge searches (`knowledge_outcomes` per case in `--json`; `null`
  where the instance or the run recorded none), so a `content_gap` shows
  before you open the case's spans. Then read which chunks came back in
  the retrieval span, and its `knowledge_outcome`: `content_gap` means the
  knowledge base lacks the answer, `unusable_hits` that what came back did not
  answer it, `retrieval_fault` that the search failed). Fix the documents or
  the knowledge base's settings before the prompt.
- **Wrong agent answered:** the handoff instructions of the entry agent, and
  the target agent's description, decide where a question goes; fix those, and
  keep the `answered_by` and `handoff_to` assertions that caught it.
- **Wrong tool, or a tool called with bad arguments:** sharpen the tool's
  description and parameters, then the agent's instructions about when to use it.
- **Right facts, poor answer:** adjust the agent's instructions; keep them short
  and specific.
- **A limit that does not hold** (the agent writes the poem it should decline):
  a limit stated only in the persona's `persona_prompt` is weaker than a direct
  instruction in the agent's `system_prompt`, most of all on small models. Put
  the hard limit in the agent's `system_prompt` too, and keep a test case that
  checks it.
- **Too slow or too costly:** read the token counts and durations in the trace;
  a smaller model or fewer tool rounds often suffice for a step.

Record why a change helped in the commit message.

To try a question outside the suite, `cavelon chat "<message>" --harness
<solution>` (the `chat` tool over MCP) sends it to that solution and prints
the answer, the session to continue with `--session`, and the conversation to
trace. It reaches an active solution that is not the tenant's default route,
which the tenant's chat and widget never answer with; a draft answers only a
person's token, as a Playground run. `cavelon api chat` with `harness_id` in
the body does the same, but needs the id and a confirm. `cavelon deactivate
--harness <solution>` takes an active solution out of live traffic again; it
previews first and is the person's decision: show the preview; over MCP the
client asks them when you confirm with its token, and from your shell they run
the confirm command in their own terminal. When every suite passes,
`cavelon activate --harness <name or slug>` goes through the readiness gate; if the
token may not activate, a person activates in the Admin. A solution that a
channel or an active trigger reaches goes live for them at once, so its
activation previews first and needs the person's yes: show it; over MCP the
client asks them when you confirm with its token, and from your shell they run
the confirm command in their own terminal.
