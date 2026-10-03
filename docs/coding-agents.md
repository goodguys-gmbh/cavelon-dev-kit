# Building a solution with a coding agent

The main way to use the kit is to work with a coding agent: you describe the
problem and supply the material, the agent writes and tests the solution, and
you review it and make the decisions. This page explains how that works in
practice: what the agent does and what it leaves to you, how to brief it, what
it shows you at each step, how to review its work, and how to get good tests
from it.

It assumes you have done the [five-minute start](../README.md#five-minute-start)
or followed [Installation](installation.md). The examples use Claude Code and
Codex with the Cavelon plugin; any agent set up with `cavelon init --agents`
works the same way (see [Claude Code, Codex and other agents](#claude-code-codex-and-other-agents)).

## What the agent does and what stays with you

**The agent does the work.** In a solution folder it:

- writes the package files in `package/` (agents, skills, tools, knowledge
  bases, triggers) and the test suites in `tests/`;
- runs `cavelon validate` and fixes what it reports;
- previews the import with `cavelon apply --env test`, and confirms it on its
  own when the target is a draft solution in a test environment;
- uploads the knowledge with `cavelon kb upload`;
- runs the suites with `cavelon test run`, reads the results and traces with
  `cavelon trace`, changes the files and runs them again;
- looks up the instance's own documentation with `cavelon docs search` and
  `cavelon docs get`, and error codes with `cavelon explain`.

**Some steps wait for you.** The agent stops and asks you:

- before confirming a preview that reaches an active solution, goes to
  production (`--env prod`), deletes anything (`--mode replace`), or needs
  secrets, grants or identities;
- before activating a solution;
- before changing any limit or quota: it shows you the old and the new value
  and its reason, and you decide;
- before binding a trigger's execution identity, or seeding or cancelling
  anything other than its own test runs and test Sandboxes.

**Some things the agent never does.** It never sees your token, never asks you
for a secret's value or sets one, and never approves or rejects anything that
waits at an approval step. When a secret is missing, it gives you the
`cavelon secrets set <name>` command to run in your own terminal.

### Where each rule comes from

The rules come from three places, so an agent that forgets one is still held
by the others:

| Source | What it enforces |
|---|---|
| **The skills** (`cavelon-loop`, `cavelon-authoring`, `cavelon-testing`, `cavelon-long-running`) and the server's instructions when the agent connects | When to stop and show you a preview; propose a limit change and let you decide; never handle a token or secret; never approve. |
| **The commands and their MCP tools** | `apply` imports only with the id of a preview; `limits set`, `models set-limit`, `loop cancel`, `sandbox seed` and `trigger identity` change nothing without `--confirm`. Each tool is annotated read-only or destructive (`readOnlyHint`, `destructiveHint`), so your agent client can ask you before it calls a destructive one. There is no tool for `login`, `secrets set` or deciding an approval, and no command takes a token or secret value as an argument. `activate` goes through the readiness gate and never forces. |
| **Your token's permissions on the server** | The token acts as you, within your roles, and within the ceiling you chose when you created it. Without **May activate**, activation is refused, whatever the agent tries. A limit only a Tenant Owner or the operator may change is refused for anyone else. |

The skills shape what a well-behaved agent does; the token decides what any
agent can do. Choose the token accordingly (next section). See also
[Security](security.md#what-your-coding-agent-sees) and
[MCP server](mcp.md#how-agents-use-it).

## Before you start

1. **Install and log in.** Install `cavelon` and the plugin
   ([Installation](installation.md)), create a personal access token and run
   `cavelon login` in your own terminal
   ([Getting started](getting-started.md#2-log-in)). The agent uses the stored
   token through `cavelon`; it never sees it.
2. **Choose the token's ceiling.** A token without **May activate** lets the
   agent build, import into test and run tests, while activation stays with a
   person in the Admin. Tick **May activate** only on a token you want to be
   able to put solutions live, and only for the tenant you mean. Use a test
   tenant, or at least a draft solution, for building.
3. **One solution per folder, in a git repository.** Create the folder, run
   `git init`, then `cavelon init --tenant <tenant> --harness <slug>`, or let
   the agent run it. `cavelon init` writes `cavelon.yaml`, `package/`, `tests/`,
   `env/` and an `AGENTS.md` block the agent reads first. To work on a solution
   that already exists, add `cavelon pull`.
4. **Put the material in the folder.** Everything the solution must know or
   follow: policies, FAQ pages, product sheets, sample documents, example
   requests and the answers you expect, an API description for a tool. Put
   documents for a knowledge base under `seeds/`, and the rest in a folder such
   as `docs/` or `examples/`. The agent reads them, and the tests can quote them.
   The more concrete they are, the better the solution and its tests.

## Briefing the agent

Describe the problem, not the configuration. The agent knows how to turn a
problem into agents, skills, tools and tests; it does not know your business.
A good brief answers:

- **Who uses it**, and through which channel (a chat widget, an API call, a
  trigger such as an incoming document).
- **What goes in and what comes out**: the questions or documents, and the
  answer, decision or record you expect.
- **Where the knowledge is**: the files in the folder, an API, a system it
  calls.
- **What must never happen**: answers it must not give, data it must not show,
  actions it must not take.
- **What a person decides**, and who that person is.
- **How you will know it works**: ask for tests, and name cases you already
  know matter.

### Example briefs

The companies below are fictional. Each brief assumes the files it names are in
the folder.

**A support FAQ (simple).**

> Build a Cavelon solution for Acme Outdoor's support chat. It answers
> customers' questions from the FAQ pages in `seeds/faq/`, in the customer's
> language. If the FAQ does not answer a question, it says so and gives the
> support email; it never guesses prices or delivery dates. Write a test suite
> with a case for each FAQ page, one for a question the FAQ does not answer, and
> one for an off-topic request. Use the test environment.

**An order-status lookup through an API tool.**

> Build a solution for Brightline Parts that tells a logged-in customer the
> status of an order. It calls our order API, described in
> `docs/order-api.yaml`, with the order number the customer gives. It shows
> only the status, the carrier and the tracking link, never the customer's
> address or the order's price. The API's base URL is a variable and its token
> is a secret: declare both, and tell me which command to run for the secret.
> Test a known order, an unknown order number, a customer asking for someone
> else's order, and a message without an order number.

**A document review with a person signing off.**

> Build a solution for Harbour Lettings that reviews a tenancy agreement
> uploaded through a trigger against the checklist in `policies/checklist.md`.
> For each checklist item, it says whether the agreement meets it and quotes
> the clause. Then a member of the lettings team signs off at an approval step;
> nothing is sent to the landlord before that. Use the sample agreements in
> `examples/`: `good.pdf` must pass every item, and `missing-deposit.pdf` must
> fail the deposit item. Test that the run reaches the approval with the review
> in it.

**An expense approval with a policy check (complex).**

> Build an expense-approval solution for Fernwood Engineering. An employee
> submits an expense with an amount, a category, a date and a receipt. The
> solution checks it against `policies/expense-policy.md` and writes a short
> memo: compliant or not, and for every finding the rule it relies on, quoted
> with its section number. Then the employee's manager approves or rejects it.
> Nobody approves their own request. Write tests for a compliant expense, one
> over each limit in the policy, one without a receipt, and one where the
> submitter is the approver. Read the instance's docs for the approval step
> before you configure it.

A brief can be short. The expense brief above, with the policy file, is enough
for an agent to build a working solution (see
[What we learned from real runs](#what-we-learned-from-real-runs)). Add detail
where the agent's first attempt shows it guessed.

## The loop, step by step

The `cavelon-loop` skill takes the agent through the same steps every time. In
Claude Code or Codex, you see each command or tool call and its output as it
runs.

1. **Plan.** The agent reads `cavelon status`, `cavelon limits` and the
   material you gave it, and often `cavelon docs search` for the parts of the
   solution it needs (an approval step, an API tool, a knowledge base). It may
   describe its plan first; this is a good moment to correct a misunderstanding.
2. **Write the files.** It writes `package/*.yaml` and `tests/*.yaml`. You see
   the files appear; they are ordinary YAML you can read.
3. **Validate.** `cavelon validate` checks the files against your instance's
   package schema. Errors name the file, line and code; the agent fixes them
   and validates again until it reports no errors.
4. **Preview.** `cavelon apply --env test` sends the files to the instance,
   which checks them and answers with a preview and its id. Nothing is imported
   yet. In the preview, check:
   - what it **creates, updates and deletes**, and that this matches what you
     asked for;
   - **reaches active**: any active solution it would change. If there is one,
     the agent stops and asks you;
   - **needs**: variables, secrets, grants, runtime bindings and trigger
     identities the target is missing. Run the `cavelon secrets set` commands
     it prints yourself;
   - **ignored**: sections the instance does not know, which a newer package
     format or a typo can cause.
5. **Apply.** For a draft solution in test, the agent confirms with
   `cavelon apply --env test --confirm <preview-id>`, which imports exactly
   what was previewed. If the solution changed in the meantime, the confirm is
   refused (exit 4) and the agent previews again.
6. **Upload.** `cavelon kb upload seeds/<folder> --kb "<name>"` sends the
   knowledge documents, after checking them against the tenant's upload
   limits, and the agent waits for ingestion to finish.
7. **Test.** `cavelon test run --suite <suite>` runs the suite on the
   instance, where a judge scores each answer. The agent waits for the result.
   In a test result, check the pass count, and for each case that did not pass
   its name and the judge's short reason. Exit 1 means a case failed; exit 5
   means answers wait for a person's verdict.
8. **Trace.** `cavelon trace <run>` shows each case with its score and the
   judge's reasoning. For a failing case, the agent goes down to the case's
   conversation and the span that went wrong: the retrieval that returned the
   wrong chunks, the tool called with bad arguments, the model's answer.
9. **Fix.** It changes one thing (the documents, a tool's description, the
   agent's instructions, the test case), then validates, applies and tests
   again. It commits when a step works.
10. **Activate.** When every suite passes, the agent tells you and waits.
    `cavelon activate` reads the solution's readiness checks and activates only
    when they pass; it prints each check and every warning. With a token that
    may activate, the agent runs it after you agree; otherwise you activate in
    the Admin.

To go to production, the agent prepares `env/prod.yaml` and previews with
`cavelon apply --env prod`, then shows you the preview and waits. You confirm,
or tell it to.

## Reviewing the agent's work

Review the agent's work as you would a colleague's pull request. Five places
show you what it did:

- **The diff.** `git diff -- package tests` (or the agent's commits) shows each
  change to the solution and its tests. Read the agents' instructions and the
  skills: they are the solution's behaviour in plain language. Check that tools
  reach only what they should, and that secrets and variables appear only as
  `{{secret:…}}` and `{{var:…}}` references.
- **The preview.** Before anything reaches an active solution or production,
  read the preview yourself (see step 4 above). `cavelon status` lists the open
  previews of the folder.
- **The suite and its cases.** Read `tests/*.yaml`. Each rule from your brief
  should have a case, reference answers should come from your documents rather
  than from the agent's own knowledge, and evaluation criteria should be
  specific enough to fail. Look out for a case that was changed to match a
  wrong answer, rather than the solution being fixed to give the right one.
- **The traces of a failed case.** `cavelon trace <run>`, then the command it
  prints for the case's conversation. The judge's reasoning and the spans show
  whether the agent's fix addresses the cause or only the symptom.
- **The readiness checks at activation.** `cavelon harness list --readiness`
  shows whether the solution is ready; `cavelon activate` prints each check and
  every warning. A warning does not block activation, but read it: an undefined
  outcome or description is easy to fill in now.

## Testing well with an agent

A solution is ready when its suites pass on the instance, not when its package
validates. Agents write tests readily; ask for the right ones.

**Ask for cases that cover:**

- the **happy path**: the questions or documents the solution exists for, with
  the facts a good answer needs;
- **each rule that must refuse**: every "never" in your brief gets a case that
  tries it;
- **missing information**: a request without the order number, an expense
  without a receipt, a question the documents do not answer;
- **the step a person decides**: that the run reaches it, with the right
  content.

**Testing an approval.** A test run never approves anything. When a run reaches
an approval step, the test ends there: it acts on nothing outside, leaves
nothing in the approval queue and runs nothing after the approval. The trace
records that the approval was reached, with its title and the content it would
have shown. Where your instance's package schema offers it, a trigger case can
expect exactly that:

```yaml
- name: Over-limit expense reaches the manager
  type: trigger
  trigger:
    trigger_slug: expense-submitted
    input: { amount: 1850, category: travel, submitter: emp-104 }
    expect_status: reaches_approval
    approval_node: manager-approval
    output:
      - contains: "Section 4.2"
```

So a test shows that the approval is reached, with its title and instructions
and the memo the approver sees. The branches after it (approved, rejected) need
a person to decide once: run the solution with a real request in the test
environment, let the right person approve one and reject one, and read both
runs with `cavelon trace`.

**Keep the thresholds in the suite.** The pass threshold, the judge mode and
the other judge settings belong in the suite's `settings`, with the names the
instance's docs give (`cavelon docs get concepts/regression-testing`). They
apply to every case the same way. Do not let the agent lower a threshold to
make a case pass; ask why the case scores low.

The [`cavelon-testing` skill](../plugin/skills/cavelon-testing/SKILL.md) gives
the agent the same guidance.

## What we learned from real runs

Two coding agents were each given an empty folder, a one-paragraph brief and a
policy file, and asked to build an expense-approval solution like the last
example brief above. One finished in about 6 minutes, the other in about 21.
Both solutions passed their suites and were activated through the readiness
gate, without an override. The differences between the two runs taught us
these lessons:

- **Give a skill that relies on a knowledge base a search tool, and test that
  answers quote the source.** A skill that is only told about the policy may
  answer from the model's general knowledge. With the search tool, a case whose
  criteria ask for the quoted rule and its section shows whether the answer
  came from your document.
- **Ask the agent to read the instance's docs before guessing.** Node and edge
  settings (an approval step, a condition on an edge, a tool's parameters) are
  described in the instance's own documentation for its version.
  `cavelon docs search <topic>` and `cavelon docs get <page>` find them faster
  than trial and error against `validate`.
- **Re-check a test that passes with a low score.** A pass just above the
  threshold can hide an answer that is right for the wrong reason, or half
  right. Read the judge's reasoning in `cavelon trace <run>`; it is shown for
  passing cases too, where the instance sends it.
- **Keep the policy or source documents in the repository.** When the agent
  writes the solution and the tests from the same file that you upload to the
  knowledge base, the solution, its tests and your review all use the same text.
  A copy pasted into a prompt drifts.
- **Enforce an approval rule through who may decide.** A rule such as "nobody
  approves their own request" written only in the memo is a request to the
  approver, not a control. An approval step does not check today who submitted
  the request: anyone who holds the permission to decide approvals can decide
  any of them. Give that permission only to the people who approve, keep the
  people who submit requests out of it, and let the memo name the rule so the
  approver can check it.

## Claude Code, Codex and other agents

**Plugin or `cavelon init --agents`.** For Claude Code and Codex, the Cavelon
plugin brings the skills and the MCP server
([Install the plugin](installation.md#install-the-plugin)), and the plugin
updates them. For Cursor, GitHub Copilot in VS Code, Gemini CLI, Kiro, Pi or any
agent that reads `AGENTS.md`, `cavelon init --agents <list>` writes the skills
and the MCP entry into the solution folder
([Agents without a plugin](installation.md#agents-without-a-plugin)); refresh
them with `cavelon init --update` after updating `cavelon`. Both give the agent
the same skills and tools.

**Project or user scope.** In Claude Code, install the plugin for yourself
(user scope), or with `--scope project` so everyone who opens the repository is
offered it. Codex installs plugins per user; to give everyone on a repository
the skills and the MCP server, commit what `cavelon init --agents codex` writes.

**CI and cloud agents.** An agent that runs without you (in CI, or a cloud
agent in its own environment) has no credential store and no terminal for
`cavelon login`. Give it a token from that system's secret store, either as
`CAVELON_URL` and `CAVELON_TOKEN` in the environment, or piped into
`cavelon login --instance <url> --token-stdin`. Use a token of its own, without
**May activate**, so you can revoke it alone, and have a person confirm
production previews and activate. `CAVELON_TOKEN` is sent only to the instance
`CAVELON_URL` names.

**Several agents or people on one instance.** Each person logs in with their
own token, once per instance URL, and each agent uses the token of the person
it works for; never share a token. Keep the solution in one repository and
work through branches and pull requests. `cavelon apply --confirm` refuses a
preview that is out of date (exit 4), so one agent cannot overwrite another's
import unseen; `cavelon pull` brings changes made by others or in the Admin into
`git diff`. To experiment without disturbing a shared solution, copy it into a
draft of your own with `cavelon harness clone <slug>`.

## Prompts you can copy

Open the solution folder in your agent and adapt these:

- *"Start a Cavelon solution from this folder. Read the files in `policies/`
  and `seeds/`, use the tenant `acme` and the solution slug `expense-approval`,
  and write a test suite for it. Work in the test environment."*
- *"Add a test for a customer who asks about an order that is not theirs, and
  make it pass."*
- *"Why did the case 'Missing receipt' fail in the last test run? Show me the
  judge's reasoning and the span that went wrong before you change anything."*
- *"Prepare production: fill in `env/prod.yaml` for the tenant `acme-prod` and
  show me the preview. Do not confirm it."*
- *"Bring the existing solution `support-faq` into this folder with
  `cavelon pull`, run its test suites, and tell me what fails."*
- *"Read `cavelon limits` and tell me whether the documents in `seeds/` fit.
  Propose a change if they do not; do not make it."*
