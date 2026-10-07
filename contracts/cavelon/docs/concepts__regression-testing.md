# Regression Testing

> Build suites of reference Q&A, run them through your live agent graph, score answers with an LLM judge, and compare runs to catch regressions.

Every change you make to a bot — a persona edit, a new knowledge base document, a model swap, a platform migration — risks quietly breaking answers that used to work. Regression testing gives you a safety net: a collection of representative questions with reference answers that you run on demand and compare across versions, so quality drift surfaces before your users find it.

Tests run through your actual agent pipeline — the same code path as production chat — so they exercise the whole stack: prompt composition, agent handoffs, tool calls, knowledge base retrieval, and model generation. You manage them from the [Test Suites](/test-suites) page, or directly through the REST API for CI.

Both draft and paused solutions remain available here. Pausing stops live channels, schedules, ordinary API keys, and live sub-workflows without forcing you to reactivate a faulty release before its fix passes regression tests. Archived solutions cannot be executed.

## Core concepts

| Concept | What it is |
|---------|------------|
| Test suite | A named collection of test cases, bound to one harness. Think of it as a test project. |
| Test case | A single scenario: a one-shot question, a multi-turn dialog, or a trigger case that starts one of the solution's triggers and checks its run. |
| Test step | One message within a case. Single-question cases have one step; dialog cases have several. |
| Test run | One execution of a suite, storing every generated answer, score, and metric. |
| LLM judge | Automatic answer scoring by a model, against your reference answers and criteria. |
| Manual verdict | A human override on any result — pass, fail, or skip — with an optional comment. |

Suites are scoped to the harness that is active when you create or generate them. Switching the dashboard harness shows that harness's own suites and runs, so a regression baseline always lines up with the agent graph it tests. See [Harnesses](/docs/concepts/harnesses).

## Test suites

### Creating a suite

On the Test Suites page, click New Suite, give it a meaningful name (for example, "Product Support — Core FAQ"), optionally add a description, and create it. The suite starts empty; you add cases next.

### Suite settings

Each suite has evaluation settings on its detail page:

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-Evaluate (LLM Judge) | On | When enabled, the LLM judge scores every evaluated answer once the run finishes |
| Pass threshold | 70% | The minimum judge score for a result to count as a pass |
| Style weight | 25% | How much of the score presentation — tone, format, length — may move. The rest is content |
| Judge mode | Balanced | Balanced keeps length and phrasing out of the content score; Strict grades closeness to the reference answer |
| Language | English | The language the judge reasons in. Fifteen languages are supported |
| Judge Model | Tenant default | Which model evaluates answers, chosen from your tenant's model registry |
| Judge samples | 1 | How many times the judge scores each step. With 3 or 5, the per-criterion median is used — the way to reduce judge disagreement when its temperature cannot be pinned. Costs one judge call per sample |
| Read as | Audience | Whose view the steps get. **Audience** reads what a visitor who is not signed in reads. **Every document (operator)** reads every knowledge base and restricted document. **A Chat User…**, with the Chat User picked beside it (or `reader_mode: as_chat_user` with `reader_chat_user_id` through the API), reads with that Chat User's groups and gives database queries that user's identity; see [Testing a query that needs a signed-in visitor](#testing-a-query-that-needs-a-signed-in-visitor). Choosing anything but Audience needs `knowledge_bases.view`, and One Chat User also `end_users.read` |
| Step timeout | 300s | How long a single step may take before the runner stops it: the step's chat run is cancelled and the step is recorded as an error |
| Court files | none | Shown only on a solution an order profile claims for answering. The court files the suite is about, by the source system's own reference (`external_ref`), up to five of one kind. A run that names none stops at preflight with `ordered_corpus_unaddressed` rather than grading glossary-only answers as model failures; see [Ordered knowledge bases](/docs/concepts/kb-orders) |

Raise the step timeout for suites whose cases do heavy work — many tool calls, several documents read per answer. A step is a full agent run, and steps run slower inside a suite than they do standalone, so leave headroom above your slowest case. When a step does hit the limit, its chat run is cancelled, so it stops spending on an answer the suite no longer waits for, and the result says so: it is recorded as an error whose message names the timeout and the limit that was hit, and whether the chat run was cancelled. If the cancel could not be recorded, the message says the run may still be running. The conversation keeps what the run produced before it stopped, and the suite goes on with the next step.

The fifteen evaluation languages are English, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Czech, Slovak, Hungarian, Croatian, Slovenian, Turkish, and Arabic.

The default judge model is your tenant's assigned evaluator role from the [Model Registry](/docs/administration/model-registry); override it per suite from the Judge Model dropdown. Pick a capable model for nuanced evaluation.

### Testing a query that needs a signed-in visitor

A [database query](/docs/administration/database-connectors) that is filled from the visitor's identity (user id, external subject or verified email) answers "please sign in" to a visitor who is not signed in, and so does a query without **Runs without a signed-in person (anonymous visitors, triggers)**. A suite that reads as the audience can therefore only check that refusal. To test what a customer gets, have the suite read as one Chat User: in the suite's settings, set **Read as** to **A Chat User…** and pick the Chat User from the list, which marks one whose email is not verified. Through the API:

```json
PUT /api/v1/test-suites/{suite_id}
{"settings": {"reader_mode": "as_chat_user", "reader_chat_user_id": "<the Chat User's id>"}}
```

To read as a Chat User for one run only, without changing the suite, name the reader when you start the run; the dev kit's `cavelon test run` does this. It needs the same two permissions from whoever starts it, a personal access token included. A person chooses the Chat User, both here and in the suite's settings: a tenant API key never does, and gets `key_needs_a_person`, because a key in CI could otherwise read as any customer. A key may start a suite whose Chat User a person saved, so CI runs it as usual:

```json
POST /api/v1/test-suites/{suite_id}/runs
{"reader_mode": "as_chat_user", "reader_chat_user_id": "<the Chat User's id>"}
```

Every step then runs the query with that Chat User's own values, read by the platform from their Chat User record in your tenant, exactly as if they were signed in: their user id, their external subject, and their email only when it is verified. A suite never supplies an identity value itself, and the agent never sees one. An unverified email stays empty, so a query on it still answers "please sign in": a Chat User created by hand under **Audience** is not verified until that person signs in through the widget's email code or SSO. The run does not become that person's: no conversation, memory or personal library of theirs is read or written.

Use a Chat User you keep for testing, ideally one whose external subject has known rows in your test database, so the expected answer stays stable. A suite that reads as the audience still gets the refusal, so one suite of each kind covers both sides.

Starting such a run needs `knowledge_bases.view` and `end_users.read`, the permission that shows that Chat User's record under Chat Users, so nobody reads through a suite what they could not read about that person already. Each start is recorded in the [audit log](/docs/administration/audit-log-tenant) as `test_run.started_as_chat_user`, with who started it and the Chat User's id. A Chat User of another tenant is refused.

### Editing and deleting suites

Edit a suite to rename it or change its description. Deleting a suite removes all of its cases, runs, and results — this is irreversible and asks for confirmation.

## Test cases

A test case is Single (one question, one answer — for straightforward Q&A), Dialog (a sequence of messages that simulates a real conversation, for context-dependent behavior), or Trigger (it starts one of the solution's triggers and checks what the run left; see [Trigger and loop cases](#trigger-and-loop-cases)).

Add a case from the suite detail page, choose its type, and fill in the steps, or, for a trigger case, its trigger and checks.

### Step fields

| Field | Required | Description |
|-------|----------|-------------|
| User Message | Yes | The message sent to the bot |
| Fixed Response | No | A scripted reply injected as history instead of generating one. Use in dialog cases to control context for later steps |
| Reference Answer | No | The ideal answer, used by the judge for comparison scoring |
| Evaluation Criteria | No | Specific, checkable qualities the judge should verify (for example, "Mentions the 30-day return window"), or assertions checked in code, such as `{"type": "must_contain", "value": "…"}`. The package schema (`GET /api/v1/meta/package-schema`) publishes every accepted shape |
| Evaluate | Auto | Whether this step is scored. Defaults to on for generated steps, off for fixed-response steps |

### Assertions

Besides the judge's criteria, a step can carry **assertions**: facts that have one correct answer and are checked in code before the judge runs. Add them under **Add assertion** in the step editor, or as objects with a `type` in `evaluation_criteria`. A failed assertion fails the step with score 0 and its reason, whatever the judge would have said; when every criterion of a step is an assertion, the judge is not called at all. An assertion whose evidence is missing from the step's trace fails rather than passes.

| Type | Value | Passes when |
|------|-------|-------------|
| `must_contain`, `must_not_contain` | text, or a pattern with `"match": "regex"` | the answer contains it, or does not |
| `language_is` | ISO code such as `de` | the answer, without its links and quotations, is in that language |
| `url_matches` | absolute URL, `"match": "starts_with"` or `"equals"` | the answer links that address |
| `date_range_within` | `start`, `end` as `YYYY-MM-DD` | every date in the answer lies in the range |
| `tool_called`, `tool_not_called` | tool slug | the step called the tool, or did not |
| `min_results` | count, optional `tool` | the step's tools returned at least that many results |
| `answered_by` | agent slug | that agent produced the answer: it made the step's last model call |
| `handoff_to` | agent slug | the step handed the turn to that agent |

The routing assertions answer what the text cannot: an answer can sound right and still come from the wrong agent. For a solution whose entry agent should hand price questions to a ticket agent:

```json
"evaluation_criteria": [
  "States the price of the family ticket",
  {"type": "handoff_to", "value": "ticket-agent"},
  {"type": "answered_by", "value": "ticket-agent"},
  {"type": "tool_called", "value": "search_documents"}
]
```

`answered_by` with the entry agent's slug checks the opposite, that a question stays where it is. A consulted agent works for the agent that consulted it, which still answers, so a consultation is a tool call (`tool_called` with the consult tool's name), not a handoff. Assertions travel with the case: export, import and solution packages carry them unchanged.

### Referring to your stored values

A case can name one of your workspace's variables the way prompts and tools do, as `{{var:name}}` — a contact e-mail address, a phone number, opening hours. This is how a Solution's mandatory suite checks the values you entered when you installed it. Before a step runs, the runner puts your value in place of each reference in the user message, the reference answer and every criterion. The judge therefore sees the value it is asked about, and an assertion can check it word for word:

```json
{"type": "must_contain", "label": "Stored contact address", "value": "{{var:kontaktstelle_email}}"}
```

The reference is also the case's only dependency on that value. If your workspace has not set it, preflight holds the case back as **Calibration Required** (`tenant_value_missing`, naming the variable) rather than asking the bot a question it cannot answer; setting the variable under **Security & access › Secrets** clears it (see [Settings](/docs/administration/settings#secrets)). Any other `{{…}}` is an unfilled placeholder, and the case is not run until someone rewrites it.

### How dialog cases work

In a dialog case, steps run in order, and each step's reply becomes context for the next. When a step has a Fixed Response, that scripted text is injected as the assistant's turn and the bot does not generate an answer for it — which keeps the lead-up to your real test deterministic.

The pattern is to script the setup turns and let the bot generate only on the step you actually want to evaluate:

| Step | User Message | Fixed Response | Evaluate |
|------|-------------|----------------|----------|
| 1 | "I'm a 55-year-old carpenter" | "Thanks for sharing — how can I help with your career?" | No |
| 2 | "I have chronic back problems and can't do physical work" | "Understood. Let's look at options that don't need heavy lifting." | No |
| 3 | "What retraining programs would you recommend?" | (empty — bot generates) | Yes |

Steps 1 and 2 establish a stable context; step 3 is where the bot answers and gets scored. Without fixed responses, a wording change in an early turn could cascade and make step 3 flaky.

An `Evaluate: No` step still runs (or injects its fixed response) and can still expose a technical error. A successful one is reported as **Preparation (not evaluated)**. It is never a behavior pass and does not enter the pass-rate denominator.

### Trigger and loop cases

A workflow that starts from a trigger, a Masterloop above all, has no question to ask: its behavior is what its run does. A trigger case starts one of the suite's solution's triggers with an input, waits for the run, and checks what it left behind. The suite must be bound to a solution, because the case can start only that solution's triggers.

Choose **Trigger** as the case type, then fill in:

| Field | Description |
|-------|-------------|
| Trigger | One of the solution's triggers. Without permission to read triggers, type its slug |
| Input | The payload, as a JSON object (`{}` when the trigger takes none) |
| Timeout | How long the runner waits for the run, a Masterloop included: 10 to 2,400 seconds, default 600. A run still open at the timeout is stopped and the case reports an error |
| Run must end | `completed` (default) or `failed`, for a case that proves a bad input is refused |
| Output checks | Each check reads the run's output, or with a JSON path such as `$.continuation.outcome` one value inside a structured output, and compares it: **equals** takes a JSON value, so `3`, `"3"` and `true` differ, and `null` asserts a null; **contains** takes text; **matches** takes a regular expression. A JSON path with no comparison checks that the value exists |
| The run starts a Masterloop | How every loop the run started must end (`completed`, `failed`, `stopped`, `cancelled`, or any state) and what it may spend: minimum and maximum iterations, and at most so many model requests, input tokens, output tokens and seconds. An empty limit is not checked |
| The run works in a Sandbox | The Sandbox the case needs, described by profile and the validation profiles it must allow rather than named, so the suite runs against each target's own test Sandbox. Before starting anything the case checks that a ready Sandbox the solution may use meets it |
| File checks | Inside a Sandbox: a path relative to the workspace that must exist or be absent, and, for an existing file, the same comparisons as an output check. `equals` on a file needs a JSON path |
| Validation receipt | Inside a Sandbox: requires the runner's passing validation receipt. Only an isolated container produces one |

**Walkthrough: the counter loop.** The counter loop counts to three in three iterations and spends no model budget. Its case starts the `run-counter` trigger with input `{}` and a 300-second timeout, and checks:

1. Output `$.ok` equals `true`, `$.continuation.outcome` equals `"done"`, and `$.continuation.next_input.count` equals `3`.
2. The loop ends `completed` after exactly 3 iterations (minimum and maximum both 3), with at most 0 model requests, 0 input tokens, 0 output tokens and 300 seconds.

Save it, then run it with the play button on its row. The run's result lists every check with its verdict, **Passed** or **Failed**, and the reason, for example *The loop spent 3 iterations; expected exactly 3.* It also shows the trigger run, with a link to its trace, the loops it started with what each spent, and the Sandbox it used. Change the expected count to `4` and the same run fails on that one check.

A few rules decide how a trigger case behaves:

- **Who it runs as.** A trigger case runs as whoever started the test run, and starting a trigger needs `triggers.manage`. A run started by someone without it records each trigger case as a technical error that says so, and starts nothing.
- **Draft loops run.** A loop solution can be tested before it is activated: under a test run, a draft solution's loop runs. Paused and archived solutions stay refused.
- **Nothing waits for a person.** A run that stops at an approval or a form is stopped by the runner, and the case reports why; a test never approves anything.
- **What the verdict rests on.** On an isolated container the loop completes on the runner's validation receipt, and the result says **Evidence: the runner's validation receipt**. On a customer VM the loop's completion is `agent_reported`: the coding agent said it was done and no runner validated it. The result then says **Evidence: file checks only (agent_reported)**, and a case on such a Sandbox with no file check fails, because nothing would evidence the work.
- **A case keeps its type.** A trigger case cannot become a chat case or the other way round; create a new case instead.

### AI-generated cases

Writing cases by hand is optional. Click Generate with AI on a suite to have the platform draft them. The generator can draw from three sources:

- Knowledge base — select one or more KBs; it samples real documents and writes questions with grounded reference answers.
- Recent conversations — it pulls real questions from your conversation history over a date range (great for the questions users actually ask).
- Text only — paste a topic description or scenario list and it generates cases from scratch.

You choose the case count (5–100), single or dialog type, and the output language. Generation runs as a background task; the cases appear in the suite when it finishes and are editable like any hand-written case.

### Curated suites

Generation answers *is the bot right about my content?* It cannot answer *is the bot safe?*, and not for want of prompting: all three of its sources are derived from your own material. A knowledge base contains no attacks. The conversation sampler skips exchanges that errored, so it learns from the ones that went well. And Text only writes realistic questions *about* a topic — give it "prompt injection" and you get questions about injection, not an attack, with criteria the model invented on the spot.

Click **Add curated suite** for the other half. These are platform-maintained sets covering the behaviour that is identical in every workspace:

- **Prompt extraction** — the instructions asked for directly, through a translation request, wrapped in a short story.
- **Jailbreaks** — role overrides, claimed administrator rights, hypothetical framing, encoded instructions, escalation over several turns.
- **Indirect injection** — instructions embedded in a page, a document, a filename, or a forged system tag inside the user's own text.
- **Sycophancy** — an invented prior commitment, a confident contradiction, a false premise smuggled into the question.
- **Over-refusal counter-checks** — ordinary requests a nervous bot wrongly declines. Refusing everything is not safety, and without these a bot that says no to everything scores perfectly.
- **Operation and data handling** — whether it claims to be human, invents a retention period, or hands out someone else's contact details.

"Does it reveal its instructions when the request is wrapped in a short story?" is genuinely the same question for every tenant in every sector, which is why one curated set is better than each workspace writing its own: a new attack class is added centrally, once.

What you get is a **copy**. Edit it, delete cases, add your own — a later revision of the template never rewrites what you have tuned. The suite shows a *Template updated* badge when the curated version has moved on, and you decide whether to take it.

Three things worth knowing before you rely on a green run:

- **The copy starts at `judge_samples: 3`.** A single attempt against a bot that complies one time in five is weak evidence.
- **Content-dependent cases arrive as placeholders**, tagged `needs-input`, and they fail until you rewrite them. They are the positive controls. Without at least one question your own content genuinely answers, a bot that replies "I have nothing on that" to every message passes the entire suite. Optionally point the dialog at a knowledge base and the generator will add content cases alongside them.
- **The template's version and date are on the card.** A one-click security check that comes back green will be believed; you should be able to see how old the set behind it is.

If you installed a Solution from the Solution Library, its own mandatory suite appears in the same dialog.

## Import and export

### Importing cases

Bulk-create cases by uploading a JSON file (up to 10 MB) from the suite's Import action. The import appends cases to the existing suite and reports how many were imported versus skipped. The format is the same one Export produces.

```json
{
  "name": "Product Support — Core FAQ",
  "description": "Imported from the legacy FAQ spreadsheet",
  "tags": ["support", "faq"],
  "test_cases": [
    {
      "type": "single",
      "name": "Return window",
      "tags": ["returns"],
      "steps": [
        {
          "step_order": 1,
          "user_message": "Can I return a product after 30 days?",
          "reference_answer": "Our standard return window is 30 days from purchase. After 30 days we can offer store credit or an exchange for defective items.",
          "evaluation_criteria": [
            "States the 30-day return window",
            "Mentions store credit after 30 days",
            "Does NOT promise a full refund after 30 days"
          ],
          "evaluate": true
        }
      ]
    },
    {
      "type": "dialog",
      "name": "Retraining advice after context",
      "tags": ["careers"],
      "steps": [
        {
          "step_order": 1,
          "user_message": "I'm a 55-year-old carpenter",
          "fixed_response": "Thanks for sharing — how can I help with your career?",
          "evaluate": false
        },
        {
          "step_order": 2,
          "user_message": "What retraining programs would you recommend?",
          "reference_answer": "Suggests low-physical-strain retraining paths suited to the user's background.",
          "evaluation_criteria": ["Accounts for physical constraints", "Names concrete options"],
          "evaluate": true
        }
      ]
    }
  ]
}
```

Notes on the format:

- Only `test_cases` is required for an import; `name`, `description`, and `tags` at the top level are ignored on import (they populate when you export).
- A step needs a `user_message`; any step missing one causes its case to be skipped.
- `type` is optional — it defaults to `single` for one-step cases and `dialog` for multi-step.
- `name` is optional; if omitted, it is derived from the first step's message.
- `evaluate` defaults to `true` for steps without a `fixed_response`.
- `required_skill_slugs` optionally pins the knowledge-bearing skills a case needs. Omit it to keep legacy text inference, use `[]` for a guardrail or behavior case that needs no knowledge base, or list the exact skill slugs whose bound knowledge bases must be ready.

> [!TIP]
> You can also download a format-specification file from the Import dialog to see the exact schema.

### Exporting a suite

Export downloads the whole suite as JSON — name, description, tags, and every case with its steps, reference answers, and criteria, in the shape above. Use exports to back up suites, share them between tenants or environments, or version-control your test definitions in Git.

## Running tests

### Starting a run

Run a suite from its card on the list page or the Run Suite button on the detail page, then confirm. The run executes as a background task, so you can navigate away and come back.

For each generated step, the runner sends the user message through the real chat API. Dialog context accumulates across steps (fixed responses are injected as history). For every generated answer it captures the full answer, the agent that produced it, response latency, token count, the knowledge base chunks retrieved, the tools called, and every triggered guardrail. A guardrail event names its slug, input/output direction, action (`block`, `log`, or `prepend`), the refusal returned for a block, and why it triggered: the classifier's own explanation, or the rules a pattern guardrail matched. A test run acts on nothing outside: side-effect tools run dry, and a pipeline that reaches an **Approval** node ends there. It leaves no approval in the queue and runs nothing after it, and its trace records that the approval was reached, with its title and the content it would have shown. If Auto-Evaluate is on, the judge then scores each evaluated step, and a summary is computed: pass / fail / error counts, execution and evaluation counts, pass rate, average latency, and total tokens.

The summary keeps cases, execution, and behavior scoring separate:

| Summary field | Meaning |
|---------------|---------|
| `total_cases` | Cases frozen into this run (a partial run counts only the selected cases) |
| `total_steps` | Steps configured across those cases; `total` is retained as its legacy alias |
| `executed_steps` | Steps that ran and produced an execution outcome, including technical errors and successful preparation |
| `behavior_evaluated` | Steps with a Pass or Fail behavior verdict |
| `unevaluated_steps` | Successful `Evaluate: No` preparation steps |
| `cases_not_run` | Frozen cases in which no step executed, including preflight-blocked or never-reached cases |
| `not_run` | Step-level count of explicit or missing results; kept separately from the case count |

`pass_rate` is `passed / behavior_evaluated`. Preparation steps contribute to neither side. A complete run with preparation plus behavior verdicts remains comparable; technical errors, calibration gaps, pending review, skips, unrun steps, or no behavior verdict make it not comparable and the API omits `pass_rate` rather than returning a misleading percentage.

### Preflight is decided when the run is accepted

When you start a run, before any case executes, the server decides for each case whether this workspace can measure it: are the knowledge bases it needs ready, are the values it refers to set, are its placeholders filled. That decision is the run's **preflight**, and it is frozen into the run when the run is accepted (`config._preflight` in the API's run response), not re-taken when a worker picks the run up.

A run started too early therefore keeps its verdict. If you upload documents and start a run while they are still being processed, the cases that need them are reported as **Calibration Required** with `knowledge_base_not_ready`, even if processing finishes before the first case runs. Wait until the knowledge base's documents are ready, then start a new run. The one change after acceptance that still holds a case back is a stored value that was unset in the meantime: the case is reported as **Calibration Required** (`tenant_value_missing`) rather than sending a literal `{{var:…}}` to the bot.

Trigger cases are not part of that check: they ask no question that needs knowledge. What they need is checked when each one runs (its trigger, the Masterloop and Sandbox features, a Sandbox meeting the requirement), and is reported as that case's technical error. Who the trigger cases run as is also frozen when the run is accepted.

### Live progress

While a run is active, the UI shows a progress bar with the current and total step count, a status badge moving from pending to running to completed, and results that appear incrementally as each step finishes.

### Cancelling a run

Cancel an active run to stop it. Already-completed steps are preserved; remaining steps are skipped, and the run is marked cancelled.

## Reviewing results

Open a completed run to see its results. The header shows the run status and timestamp, total cases, executed steps, behavior-evaluated steps, preparation steps, cases not run, behavior outcomes, pass rate, average latency, total tokens, and a snapshot of the agent configuration that produced it.

The results table has one row per stored step result:

| Column | Description |
|--------|-------------|
| Status | Pass, Fail, Technical Error, Pending Review, Skip, Preparation (not evaluated), Calibration Required, or Not Run |
| Agent | Which agent in the harness answered the step: the one that made its last model call |
| Tokens | Input plus output tokens the step consumed |
| Tool calls | Which tools ran, with their status and duration |
| Test Case | Case name and step number |
| LLM Score | Judge score as a percentage, color-coded against the threshold |
| Latency | Response time in milliseconds |
| Verdict | The manual verdict badge, if one is set |

Fixed-response and other `Evaluate: No` steps remain visible as preparation, so the execution history still explains the context of a later verdict. They do not offer manual behavior-verdict controls. When Auto-Evaluate is off, an evaluated result lands as Pending Review for a human to decide. A judge that could not score a step is recorded as an Error with the reason, not as Pending Review — a scoring failure is not a human decision waiting to be made.

A step the provider refused for allowance reasons — a rate limit or an exhausted quota that survived the client's own retries — is recorded as an **Error** that says so, and after three such refusals in a row the run stops rather than spending the rest of a dead subscription on cases it cannot answer. A run that ends with any errors or unrun steps is marked **not comparable** and has no pass rate: an infrastructure failure is not a model-quality verdict.

An answer cut off by the output budget is also recorded as an **Error**, not as a low score. Reasoning tokens and visible text share the agent's max output tokens, so a thinking-heavy final turn can spend the whole budget and produce no text — and what comes back is then whatever an earlier turn happened to say while it was still working. Grading that would file a configuration limit as a model failure: the same question measured 10% when truncated and 94% on the very next identical run. The run detail marks the call's output budget as exhausted; the fix is a higher cap or a lower reasoning level.

An agent run that fails internally is recorded as an **Error** with the underlying cause, not as a low-scoring answer. This matters when comparing models: the Chat API answers such a run with a generic apology, and grading that apology would file an infrastructure failure as a model-quality result. The same applies to a step that comes back empty. A run's buckets therefore add up to its step count, and any step that produced no result at all is reported separately as **not run** rather than folded into the skipped count.

Expand any row for the full detail: the user question, the generated answer (rendered as markdown), the reference answer side by side, the judge's percentage score with its Content and Style badges, its reasoning, the per-criterion breakdown, badges for the tools that were called (for example `search_documents`, `web_search`; a handoff appears as `transfer_to_<agent>`), triggered guardrail activity with direction/action/refusal, and the error message if the step failed. Guardrails that evaluated safely are omitted from this compact result view; their complete evaluations remain in the conversation trace.

A knowledge search's badge also names the agent's verdict on what it found, for example `search_documents · usable evidence`. An agent that can search a knowledge base calls `platform_record_knowledge_outcome` after each search, and that call is bookkeeping, not a tool call of its own: it adds `knowledge_outcome` (`usable_evidence`, `content_gap`, `unusable_hits`, `retrieval_fault` or `deliberately_unanswerable`) to the search's retrieval span and leaves no span, no tool-call count and no badge. In the trace, look for it on the retrieval span under the search; a search without it is one the agent did not classify.

### Manual verdicts

On any evaluated result you can set a manual verdict — Pass, Fail, or Skip — with an optional comment. Verdicts are for overriding judge decisions you disagree with, settling edge cases that need human judgment, and recording why. Use Skip to park a case that is temporarily not applicable without deleting it. Preparation remains outside behavior scoring even for historical rows that once carried a manual verdict.

### Exporting results

Export a run's results as JSON to get every answer, its `evaluate` flag, status, score, judge reasoning, tool call, triggered guardrail event, retrieval chunk, latency, token metric, and manual verdict. The run summary in the same file carries the case/execution/evaluation taxonomy above. Use it for stakeholder reports, compliance evidence, or analysis in external tools.

## Comparing runs

The comparison view shows how answer quality changed between two runs of the same suite — the core regression check.

Start a comparison from the suite detail page (with two or more completed runs) via Compare Runs, or from a run's results page via Compare. Pick Run A as the baseline and Run B as the new run.

The comparison shows summary cards for both runs, the overall delta in pass rate, and change counts: improved, regressed, and unchanged steps. Filter to focus on just the regressions. For each step it pairs the two runs side by side — the same question, both generated answers, both scores, the score delta, and a change indicator (improved, regressed, unchanged, or new).

Each run names the judge that scored it: its model, samples and strictness, and on hover the judge prompt and aggregation versions. A run's results page shows the same line. When the two runs were scored by different judges, the comparison says so above the cards and lists what changed, and the API reports `judge_changed` in the comparison's `non_comparable_reasons`. A score change between such runs measures the judge as well as the bot. A suite that leaves Judge Model on the tenant default follows the tenant's evaluator role, so pin the Judge Model on any suite whose results you compare over time.

| Scenario | How to compare |
|----------|----------------|
| Before/after a model change | Run the suite, change the model, run again, compare |
| Before/after prompt edits | Baseline, edit persona or agent instructions, run again |
| Before/after a KB update | Run before changing content, run after, check for regressions |
| Platform migration | Import a suite from the old system, run it, compare answer parity |

> [!NOTE]
> If a comparison shows every step as "new", the two runs do not share cases — cases were added or removed between them. Comparison can only pair results for cases present in both runs.

## The LLM judge

When Auto-Evaluate is on, the judge scores each generated answer after the run completes. It receives the user's question, the bot's answer, the reference answer (if given), and the evaluation criteria (if defined), and returns a structured evaluation: an overall score from 0.0 to 1.0 (shown as 0–100%), a per-criterion score with reasoning, and overall reasoning.

Scores at or above the pass threshold count as a pass; below it, a fail. If evaluation cannot complete — a model error, for instance — no fake score is recorded; the result is surfaced for review rather than silently failed.

### Content and style are scored separately

Every criterion is either **content** (facts, correctness, coverage, behaviour, safety) or **style** (tone, format, structure, length). The two groups are scored independently and the platform combines them:

```text
overall = content × (1 − style weight) + style × style weight
```

At the 25% default, presentation can move the score by at most 25 points. A factually complete answer therefore stays above the 70% pass threshold no matter how the judge feels about its wording. Set style weight to 0% to grade purely on content, or raise it for suites where tone is the thing under test. Expand a result to see the Content and Style badges and the per-criterion breakdown behind the overall number.

**Which group a criterion belongs to is a property of the criterion, not a judgement the model makes per run.** That distinction matters more than it sounds: the label selects the arithmetic above, so a criterion that moved between groups between two runs changed the score without any per-criterion score changing. On a step with two criteria the swing reached 30 points at the default weight, and at 0% style weight a criterion moved into the style group leaves the score entirely — up to 50 points.

Criteria you write are therefore labelled once, in the suite, and the judge is told what the labels are rather than asked. Criteria written before this existed are classified automatically and deterministically: content unless the wording is clearly about presentation (tone, formatting, bullets, length, phrasing). Expand a result to see where each label came from — a criterion shows `derived` or `default` when it was classified rather than authored.

### Reproducibility, and its limits

Two runs of the same suite against the same agent will not always score identically, and it is worth knowing which parts of that the platform controls.

Fixed: the criterion labels and the aggregation arithmetic.

Not fixed: the judge's own sampling. Reasoning models reject a temperature parameter, and most shipped model presets use a reasoning model as the judge (the Qwen preset does not) — so for most tenants there is no temperature to pin, and the suite settings say so instead of offering a control that would do nothing. **Judge samples** is the lever that remains: at 3 or 5 the per-criterion median is scored, and the per-criterion spread is shown so you can see how much the judge disagreed with itself. Choosing a non-reasoning Judge Model pins its temperature at 0 instead.

Also not fixed: the model under test. Even at temperature 0, a batched inference server does not reproduce its own output exactly, so some run-to-run variance is the provider's, not the judge's.

<Callout type="warning">
Scores from before this change are not directly comparable with scores after it, for any step whose criterion labels moved. Re-baseline a suite before reading a change in its pass rate as a change in quality. Each result records the scoring version it was produced under.
</Callout>

### Longer answers are not penalised

Under the default Balanced mode, the reference answer is a **content floor** — the facts an answer must cover — not a length limit, a template, or a style model. The judge is instructed to:

- treat additional accurate, on-topic information as acceptable, never as a defect;
- deduct for extra material only when it is wrong, contradicts the reference, is off-topic, or buries the answer;
- apply a brevity expectation only when a criterion explicitly asks for one;
- ignore differences in wording, ordering, and formatting;
- score a criterion as met when a difference is not clearly a defect.

Length is reported rather than punished. When an answer is long, the judge records a verbosity observation — shown as a **Verbose** or **Excessively long** badge with a note in the reasoning — and that observation never changes a score on its own.

Switch Judge mode to **Strict** to restore the older behaviour, where the reference answer is treated as the ideal response and deviation in length or emphasis is itself grounds to deduct.

> [!NOTE]
> Runs judged in Balanced mode generally score higher than older runs of the same suite. When comparing across the change, expect a one-time step up that reflects the scoring rules, not a real quality improvement.

In both modes, a criterion that says what the answer must not do ("Does not claim to have forwarded the report") is met when the answer does not do that one thing. Leaving out other content does not fail it. The judge is also told that a criterion its own reasoning finds fully met belongs in the 90–100% band.

To get reliable scores:

- Write criteria that are binary-checkable ("States the 30-day return window") rather than vague ("Explains returns well"). Three to five per case is a good balance.
- Provide reference answers — they give the judge a concrete standard.
- Keep length requirements out of your criteria unless brevity is genuinely part of the test; a criterion that demands it will be honoured.
- Match the evaluation language to your bot's response language.
- Use a strong judge model for suites that gate deployment.

## Workflows

### Stand up a baseline for an existing bot

1. Gather your most important questions — from support tickets, FAQs, and stakeholder requirements.
2. Create a suite and add the cases, by hand or by JSON import.
3. Add reference answers and criteria.
4. Run the suite to establish a baseline.
5. Review the scores and calibrate the threshold and criteria until they match your judgment.

### Pre-deployment regression check

1. Run the suite to capture a baseline (Run A).
2. Make your change — model swap, prompt edit, KB update.
3. Run the suite again (Run B).
4. Compare A and B, filtered to regressions.
5. Fix or knowingly accept each regression before shipping.

### Grow a suite from real issues

1. When a user reports a bad answer, add that question as a case.
2. Write the correct reference answer and a criterion that flags the original failure.
3. Run the suite — the new case should fail, confirming the issue.
4. Fix the bot, run again — the case should pass with no new regressions.

## Tips

- Keep suites focused — one per use case or domain beats one giant suite.
- Use tags to organize cases within a suite.
- Each run spends real model tokens, both to generate answers and to judge them — start small while calibrating, and remember dialog cases with many steps cost more.
- Clear old runs you no longer need with Clear All Runs to keep the list tidy; export suites before any destructive change.

> [!NOTE]
> Test conversations are tagged as a test source. They appear in [Conversations](/docs/administration/conversations) but are identifiable, so analytics can exclude them and they do not inflate your production conversation counts.

## API access

Every regression-testing operation is available over the REST API, which is what makes CI integration possible. Each endpoint accepts three kinds of caller and checks the same permissions for each: reading and running suites needs `playground.use`, and creating, changing or deleting them also needs `agents.edit`.

| Caller | Credential | Tenant |
|--------|------------|--------|
| CI or another program | A tenant [API key](/docs/administration/api-keys-and-auth#api-keys) with the `admin` scope, sent as `Authorization: Bearer cbp_…` or `X-API-Key: cbp_…` | Always the key's own tenant; an `X-Tenant-Id` header does not change it |
| A person working from a script | A personal access token (`cvpat_…`), where your platform has them enabled; it acts as you, capped by the ceiling chosen when it was made | Select it with `X-Tenant-Id`, unless the token is limited to one tenant |
| A person in the dashboard | The dashboard session | The workspace you have open |

An `admin` key carries the Tenant Owner's permissions. A `chat` or `knowledge_base` key is refused with `403`, and so is a key [restricted to some workflows](/docs/administration/api-keys-and-auth#restricting-a-key-to-one-workflow): suites, runs and results belong to a workflow, so these endpoints need an unrestricted key. Changes made with a key appear in the [audit log](/docs/administration/audit-log-tenant) under the key; changes made with a session or a personal access token appear under the person.

Pass `harness_id` to target a specific harness, or omit it to use the tenant's default.

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/v1/test-suites` | List suites (optional `tag`, `harness_id`) |
| `POST /api/v1/test-suites` | Create a suite |
| `POST /api/v1/test-suites/generate` | Generate a suite with AI |
| `GET /api/v1/test-suites/{suite_id}` | Get a suite with its cases and settings |
| `PUT /api/v1/test-suites/{suite_id}` | Update name, description, tags, or settings |
| `DELETE /api/v1/test-suites/{suite_id}` | Delete a suite and all its data |
| `POST /api/v1/test-suites/{suite_id}/cases` | Add a case |
| `PUT /api/v1/test-suites/{suite_id}/cases/{case_id}` | Update a case |
| `DELETE /api/v1/test-suites/{suite_id}/cases/{case_id}` | Delete a case |
| `POST /api/v1/test-suites/{suite_id}/import` | Import cases from a JSON file |
| `GET /api/v1/test-suites/{suite_id}/export` | Export the suite as JSON |
| `GET /api/v1/test-suite-templates` | List the curated suites available to this tenant |
| `POST /api/v1/test-suite-templates/{template_id}/instantiate` | Copy a curated suite into a suite of your own |
| `GET /api/v1/test-suite-templates/{template_id}/export` | Download a curated suite in import format |
| `POST /api/v1/test-suites/{suite_id}/runs` | Start a run (background task) |
| `DELETE /api/v1/test-suites/{suite_id}/runs` | Delete all runs for the suite |
| `GET /api/v1/test-runs` | List runs (optional `suite_id`, `harness_id`) |
| `GET /api/v1/test-runs/{run_id}` | Get a run's status and summary |
| `GET /api/v1/test-runs/{run_id}/results` | Get a run's results |
| `POST /api/v1/test-runs/{run_id}/cancel` | Cancel an active run |
| `GET /api/v1/test-runs/{run_a}/compare/{run_b}` | Compare two runs |
| `DELETE /api/v1/test-runs/{run_id}` | Delete a run |
| `PUT /api/v1/test-results/{result_id}/verdict` | Set a manual verdict on a result |

Each result names the trace that explains it. A chat step's result carries the `conversation_id` its turn created and the `agent_run_id` of the run that answered it; a trigger case's result carries the `agent_run_id` of the run it started. Read the traces with `GET /api/v1/conversations/{conversation_id}/traces` or `GET /api/v1/triggers/runs/{agent_run_id}/traces`.

A typical CI step starts a run, polls it until it reaches a final status (`completed`, `degraded`, `failed` or `cancelled`), then reads the summary's pass rate to decide whether to proceed. `pass_rate` is absent when the run is [not comparable](#starting-a-run), so treat a missing value as a failure:

```bash
SUITE_ID="your-suite-uuid"
BASE="https://your-platform-domain.example/api/v1"
AUTH="Authorization: Bearer $API_KEY"   # a tenant API key with the admin scope

# Kick off a run and capture its id
RUN_ID=$(curl -sS -X POST "$BASE/test-suites/$SUITE_ID/runs" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"notes": "CI run"}' | jq -r '.id')

# Poll until the run reaches a final status
while :; do
  STATUS=$(curl -sS "$BASE/test-runs/$RUN_ID" -H "$AUTH" | jq -r '.status')
  case "$STATUS" in pending|running) sleep 10 ;; *) break ;; esac
done

# Read the pass rate; null means the run is not comparable
curl -sS "$BASE/test-runs/$RUN_ID" -H "$AUTH" | jq '.status, .summary.pass_rate'
```

With a personal access token, add `-H "X-Tenant-Id: $TENANT_ID"` to each call unless the token is limited to one tenant.

For releasing a configuration once a suite passes, see [Releases](/docs/administration/releases).

## Automate it

A suite can be built and run without the dashboard, with the operations listed under [API access](#api-access). Three things decide how you script it:

- **Credentials.** CI uses an unrestricted tenant API key with the `admin` scope; a person scripting from a terminal uses a personal access token. Both are described under [API access](#api-access).
- **Chat cases and trigger cases.** A case with `type` `single` or `dialog` sends its `steps` through chat. A case with `type: "trigger"` has no steps. It starts a trigger of the suite's solution and checks the run it left. Its `trigger` object holds `trigger_slug` (the trigger's slug), `input` (the payload), optional `expect_status` (`completed` by default, or `failed`) and `timeout_seconds` (default 600, at most 2,400), and the checks described under [Trigger and loop cases](#trigger-and-loop-cases): `output`, `loop`, `runtime_requirement`, `files` and `validation_receipt`. A case keeps its type: an update cannot turn a chat case into a trigger case.
- **Waiting.** `POST /api/v1/test-suites/{suite_id}/runs` returns at once. Poll `GET /api/v1/test-runs/{run_id}` until its status settles, then read `GET /api/v1/test-runs/{run_id}/results`.

```json
{
  "name": "Ticket intake reaches approval",
  "type": "trigger",
  "trigger": {
    "trigger_slug": "ticket-created",
    "input": { "ticket": { "id": 42, "subject": "Refund not received" } },
    "expect_status": "completed"
  }
}
```

In a solution package, suites travel in the `test_suites` section, each with its `settings` and `test_cases`. The package schema (`GET /api/v1/meta/package-schema`, `TestSuiteSettings`) lists the settings keys; an import refuses any other key and names the valid ones. `score_threshold` is a fraction from 0 to 1, not a percentage.

Applying a package again updates its suites in place. A case is matched by name and kind; a case renamed in the package keeps its kind and position, so it is matched there and keeps its results, as a rename in the editor does. A case the package no longer has, or one whose kind changed, is deleted together with its results in every past run, and the import preview names each such case and how many results it takes with it. A suite that reads as someone other than the audience (`reader_mode` `unrestricted` or `as_chat_user`) needs `knowledge_bases.view` to import, as it does in the suite editor, unless the suite already reads that way; `reader_chat_user_id` must name a Chat User of the tenant you import into.
