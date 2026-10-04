# Example: expense approval

A Cavelon solution with a pipeline, to copy and try: employees ask about a
travel and expense policy and submit expense requests; the solution checks each
request rule by rule against the policy, writes a decision memo, and hands it to
a person for approval. The policy is a short fictional one, in
`seeds/policy/`.

```text
chat → Expense assistant → Request complete?
                             ├─ no  → Answer the person
                             └─ yes → Policy check → Decision memo → Approval → Decision
                                                                                ├─ approved → Notice – approved
                                                                                └─ rejected → Notice – rejected
```

```text
expense-approval/
  cavelon.yaml          instance, tenant and solution; never a token
  package/              the solution, one file per section of the package schema
    manifest.yaml         package format v3
    harnesses.yaml        the solution "expense-approval", a draft
    knowledge_bases.yaml  the knowledge base "Expense Policy"
    skills.yaml           "Look up the policy": the search tool and the knowledge base it searches
    agents.yaml           the expense assistant (the entry point) and the policy check, both with structured output
    registry_entities.yaml the pipeline: chat start, two routers, a transform, the approval and three outputs
  tests/acceptance.yaml eight cases: policy questions, an incomplete request, a compliant one,
                        two that violate a rule, and the approval step
  env/test.yaml         where `cavelon apply --env test` goes
  env/prod.yaml         where `cavelon apply --env prod` goes (empty until you promote)
  seeds/policy/         the policy to upload; documents live in Cavelon, not here
  AGENTS.md             the short Cavelon block for coding agents
```

## How it works

- **Searching the policy.** Both agents hold the skill "Look up the policy". It
  carries the built-in search tool `search_documents` and names the knowledge
  base it searches. A knowledge base alone gives an agent nothing to search
  with; `cavelon validate` warns about an agent that has one without a search
  tool.
- **The expense assistant** answers policy questions and collects a request
  until it has every detail. Its structured output (`mode`, `answer`,
  `request`) feeds the router **Request complete?**: a complete request goes on
  to the check, everything else is answered directly.
- **The policy check** quotes every rule that applies, word for word, and says
  whether the request meets it, what can be reimbursed, who approves it and what
  it recommends. It decides nothing.
- **The decision memo** turns the check into the approval's title and
  instructions, and a person approves or rejects in the Admin. The router
  **Decision** reads the decision and sends the matching notice.
- **Who may decide** is set on the approval, not left to the memo. Its
  `approvers` follow R8.1 by the gross amount: up to 500 EUR the access group
  `team-leads`, up to 2,000 EUR `department-heads`, above that `management`.
  `forbid_self_approval: true` follows R8.2: the person whose chat submitted
  the request cannot decide it. The instance refuses anyone else
  (`approval_approver_rule_not_met`, `approval_requester_cannot_decide`). An
  instance whose package schema does not publish these two keys under the
  approval node cannot enforce them; there, give the permission to decide
  approvals only to the people who approve.

## Try it

You need the `cavelon` CLI ([installation](../../docs/installation.md)) and a
login ([getting started](../../docs/getting-started.md#2-log-in)).

```bash
cp -r examples/expense-approval ~/expense-approval && cd ~/expense-approval
git init
```

Edit two lines of `cavelon.yaml`: `instance` is your Cavelon URL, `tenant` your
tenant's slug, name or id (`cavelon tenant list` shows all three). The approval names three access
groups: create them in your tenant and add the approvers' chat users, with
their verified email (`cavelon docs get administration/chat-users-and-groups`),
or name your own groups or tenant roles in `package/registry_entities.yaml`. Both agents use the model `gpt-4.1`
from `openai`; `cavelon models list` shows the models your tenant has, so change
`llm_model` and `llm_provider` in `package/agents.yaml` if it has another.

```bash
cavelon validate                                  # the files against your instance's package schema
cavelon apply --env test                          # a preview, and its id
cavelon apply --env test --confirm <preview-id>   # creates the draft solution and its knowledge base
cavelon kb upload seeds/policy --kb "Expense Policy" --wait
cavelon test run --suite Acceptance --wait --timeout 10m
cavelon trace <run>                               # why a case did or did not pass
```

## What the tests cover, and what they do not

A test run never waits for a person. A case whose request reaches the approval
ends there: the run records that the approval was reached, with its title and
its instructions (the memo), and the judge grades those against the case's
criteria. So the tests show that a compliant request reaches the right approver
with a sound memo, and that a request which breaks a rule cites that rule.

What happens after the decision, the two notices behind **Decision**, is not
reached by a test run, and neither is who may decide. Check those branches
yourself on the draft solution: send a request in the Admin's chat, let another
person in the group of its tier approve it (or reject it), and read the notice.
You cannot decide your own request. Neither `cavelon` nor your coding agent
decides an approval.
