# Getting started

This tutorial takes you from an empty folder to an active Cavelon solution: a
support assistant that answers customers' questions from three FAQ pages and
says when it does not know. It uses the files of
[`examples/support-faq/`](../examples/support-faq/), and every step is a
`cavelon` command you can run yourself or let your coding agent run.

It takes about fifteen minutes. You need:

- Node.js 20.3 or newer with npm, and git. `cavelon` itself needs no install:
  `npx -y @cavelon/cli` runs it, and in this tutorial `cavelon` stands for
  that, or for your alias or global install ([Installation](installation.md#install-the-cli)).
  The plugin is optional for this tutorial;
- a Cavelon instance with personal access tokens and the operations API turned
  on, and an account that is a tenant admin of a tenant you may test in.

The outputs below are what `cavelon` prints, shortened where marked with `…`.
Your ids, dates and counts will differ. The instance in the examples is
`https://cavelon.example.com` and the tenant is `acme`.

## 1. Create a personal access token

In Cavelon, open your user menu → **Personal access tokens** (the page
`/account/access-tokens`) and choose **Create token**:

- give it a name you will recognise, such as `laptop`;
- pick an expiry;
- tick **May activate** only if this token may put solutions live. For step 11
  of this tutorial it needs to; for day-to-day building and testing it does
  not.

The token starts with `cvpat_` and is shown once. Keep the page open until the
next step.

## 2. Log in

In a terminal of your own (not in the agent's chat), run:

```bash
npx -y @cavelon/cli login --instance https://cavelon.example.com
```

Use the address of your Cavelon instance, the URL you open Cavelon at in the
browser, in place of `https://cavelon.example.com`; the docs use that
placeholder throughout. `login` asks for the token without showing what you type, checks it against the
instance, and stores it in your system's credential store:

```text
Token (input hidden):
Logged in to https://cavelon.example.com as ada@example.com. Token stored in the credential store. Acting in tenant Acme (4f6174cf-3060-4ff1-bd3c-8a8e7999256b), the one the instance chooses for this token.
```

Without `--tenant`, the token acts in the one tenant it is limited to, or in
your default tenant. If the instance cannot place it (for example a platform
operator's token for several tenants), `login` stops with
`tenant_required`: log in again with `--tenant <tenant-id>`, the id an
operator copies in **Platform › Tenants**. A token limited to one tenant needs
none.

`cavelon` never takes a token as a command-line argument, so it never lands in
your shell history, and your coding agent never sees it. To paste it from a
password manager instead, pipe it: `op read op://dev/cavelon/token | npx -y @cavelon/cli
login --instance https://cavelon.example.com --token-stdin`.

Check who you are:

```bash
cavelon whoami
```

```text
instance:     https://cavelon.example.com (login)
acting as:    Ada Lovelace <ada@example.com>
tenant:       Acme (4f6174cf-3060-4ff1-bd3c-8a8e7999256b)
tenant from:  the token's default
role:         tenant_admin
credential:   personal access token "laptop" from login (credential store)
expires:      2026-12-02T15:40:26.342Z (in 60 days)
may activate: yes
version:      v1.42.0
```

If your account belongs to several tenants, choose the one to work in:
`cavelon use acme`. `cavelon tenant list` shows them.

## 3. Create the solution folder

```bash
mkdir support-faq
cd support-faq
git init
cavelon init --tenant acme --harness support-faq
```

```text
created   cavelon.yaml
created   package/
created   tests/
created   seeds/
created   env/test.yaml
created   env/prod.yaml
created   .cavelon/
created   .gitignore
created   AGENTS.md

Next:
  Bring the solution into package/: cavelon pull
  Catch an invalid package before each commit: cavelon init --hook
```

`cavelon.yaml` names the instance, the tenant and the solution (a *harness* in
Cavelon's API), never a token. `env/test.yaml` says where `apply --env test`
goes. `.cavelon/` holds local state and is ignored by git. See
[Concepts](concepts.md#the-solution-folder) for each file.

`cavelon pull` would bring an existing solution from the instance into
`package/`. This one is new, so take its files from the example instead.

## 4. Add the package files

Copy `package/`, `tests/` and `seeds/` from the example, either from a clone of
this repository or from the
[`examples/support-faq` folder on GitHub](https://github.com/goodguys-gmbh/cavelon-dev-kit/tree/main/examples/support-faq):

```bash
git clone --depth 1 https://github.com/goodguys-gmbh/cavelon-dev-kit.git /tmp/cavelon-dev-kit
cp -r /tmp/cavelon-dev-kit/examples/support-faq/{package,tests,seeds} .
```

In PowerShell:

```powershell
git clone --depth 1 https://github.com/goodguys-gmbh/cavelon-dev-kit.git $env:TEMP\cavelon-dev-kit
Copy-Item -Recurse $env:TEMP\cavelon-dev-kit\examples\support-faq\package, $env:TEMP\cavelon-dev-kit\examples\support-faq\tests, $env:TEMP\cavelon-dev-kit\examples\support-faq\seeds .
```

You now have:

```text
package/
  manifest.yaml          the package format (v3)
  harnesses.yaml         the solution "support-faq", a draft
  knowledge_bases.yaml   the knowledge base "Support FAQ"
  skills.yaml            "Answer from the FAQ": the search tool, the knowledge base it searches, and how to answer
  agents.yaml            one agent, its model and its prompt
tests/
  smoke.yaml             four test cases: three the FAQ answers, one it must decline
seeds/faq/               three FAQ pages to upload
```

Each file under `package/` is one section of the instance's package schema.
A knowledge base reaches the agent only through a search tool: the skill
carries the built-in `search_documents` in its `tool_assignments`, and names the
knowledge base it searches. `cavelon validate` warns about an agent that is
given a knowledge base without one.
Open `package/agents.yaml`: the agent uses the model `gpt-4.1` from `openai`.
Check which models your tenant has:

```bash
cavelon models list
```

If `gpt-4.1` is not among them, change `llm_model` and `llm_provider` in
`package/agents.yaml` to one that is.

## 5. Validate

```bash
cavelon validate
```

```text
Valid against package schema v3 (6 sections).
```

`validate` checks the files against the package schema your instance
publishes, and caches the schema, so later runs work offline
(`cavelon validate --offline`). An error names the file, the line and a code:

```text
error package_schema_invalid  package/agents.yaml:4 agents[0].temperature: must be number
1 errors, 0 warnings. `cavelon explain <code>` says more.
```

`cavelon explain <code>` looks any code up in the instance's error catalog.

## 6. Preview, then apply

`apply` never changes anything on its own. First it previews:

```bash
cavelon apply --env test
```

```text
Preview of package/ for solution support-faq (draft) [env test]:
ready:   yes
creates: 1 agents, 1 knowledge_bases, 1 skills, 1 test_suites

preview id: pv_55ed52186395560a11ad7e525a2b9553
Import exactly this: cavelon apply --confirm pv_55ed52186395560a11ad7e525a2b9553 --env test
```

```text
warning: Created the draft solution Support FAQ (support-faq) that env/test.yaml names.
```

Because `env/test.yaml` names a solution that did not exist yet, `apply`
created it as an empty draft. The preview lists what the import would create,
change and delete, which active solutions it reaches, and what the tenant still
needs (secrets, variables, grants). Read it, then confirm exactly that preview:

```bash
cavelon apply --env test --confirm pv_55ed52186395560a11ad7e525a2b9553
```

```text
applied: preview pv_55ed52186395560a11ad7e525a2b9553 to support-faq (env test)
created: 1 agents, 1 knowledge_bases, 1 skills, 1 test_suites
```

If the solution changed on the instance after the preview, the confirm is
refused (exit 4) and nothing is imported; preview again. See
[Preview and confirm](concepts.md#preview-and-confirm).

## 7. Upload the knowledge

```bash
cavelon kb upload seeds/faq --kb "Support FAQ" --wait
```

```text
Uploaded 3 files.
op_document_ingestion_3db2fad227b346a6a81a63d7e619edc3  document_ingestion  succeeded  phase succeeded  1/1
op_document_ingestion_587709377db846d7ac299add39f815fc  document_ingestion  succeeded  phase succeeded  1/1
op_document_ingestion_bc92267fb1f04e11adbbae5b83ae1cac  document_ingestion  succeeded  phase succeeded  1/1
```

Each document is ingested on the instance as an *operation*. `--wait` follows
them for up to 90 seconds by default (`--timeout 5m` for longer). If time runs
out, the work goes on, the command exits 6 and prints the `cavelon wait …`
command that picks up where it left off. Files are checked against the
tenant's upload limits before anything is sent (see [Limits](limits.md)).

## 8. Run the tests

```bash
cavelon test run --suite Smoke --wait --timeout 5m
```

```text
op_test_run_82f8a0a73ef74dc29e24b89e3e7d5303  test_run  succeeded  phase succeeded  1/1

Smoke: completed  passed 4  failed 0  pass_rate 1
```

When a case does not pass, the command exits 1 and names it:

```text
op_test_run_82f8a0a73ef74dc29e24b89e3e7d5303  test_run  succeeded  phase succeeded  1/1
  test run 82f8a0a7-3ef7-4dc2-9e24-b89e3e7d5303 (Smoke) finished, but cases did not pass: 1 failed
    Not in the FAQ (step 1)  fail: The answer contains a poem.
  Look closer: cavelon trace 82f8a0a7-3ef7-4dc2-9e24-b89e3e7d5303
```

The operation succeeded (the run finished); its result did not pass. That is
why the exit code is 1, so a script or CI job stops there. A run whose answers
wait for a person's verdict exits 5.

## 9. Read the trace

```bash
cavelon trace 82f8a0a7-3ef7-4dc2-9e24-b89e3e7d5303
```

```text
CASE            STEP  STATUS  SCORE  CONVERSATION_ID
Opening hours   1     pass    0.9    11111111-1111-4111-8111-111111111111
Return window   1     pass    0.95   22222222-2222-4222-8222-222222222222
Refund time     1     pass    0.9    33333333-3333-4333-8333-333333333333
Not in the FAQ  1     pass    1      44444444-4444-4444-8444-444444444444

Judge's reasoning:
  Opening hours (step 1)  pass  score 0.9
    Judge: Gives the hours for weekdays and Saturday, as the reference does.
  Return window (step 1)  pass  score 0.95
    Judge: States the 30-day return window.
  Refund time (step 1)  pass  score 0.9
    Judge: Says refunds take five working days; omits the payment method.
  Not in the FAQ (step 1)  pass  score 1
    Judge: Declines and points to the shop's questions only.

A case's traces, by the conversation_id in its row: cavelon trace 11111111-1111-4111-8111-111111111111 --kind conversation
```

For a test run, `trace` lists each case with its score and, where the instance
sent it, the judge's reasoning; a case that did not pass also shows its error.
Each command `trace` prints works as printed: it carries the id its route
needs. A case's traces are under its conversation id, so `cavelon trace
<conversation_id> --kind conversation` opens one case's conversation: its
traces, then with `--trace <trace_id>` their spans (model calls, retrievals,
tool calls), each level with the command that shows the next. A test run's id
where a conversation id belongs answers with a hint naming the id to use.

Change the prompt in `package/agents.yaml`, the skill in `package/skills.yaml`
or the cases in `tests/smoke.yaml`, then run the loop again: `validate`,
`apply`, `test run`, `trace`.

## 10. Commit

```bash
git add -A
git commit -m "Support FAQ solution"
```

The repository is now the source of the solution. `cavelon status` shows the
instance, tenant, solution and any open previews for this folder.

## 11. Activate

When the tests pass, activate the solution through its readiness gate:

```bash
cavelon activate
```

```text
Activated Support FAQ (support-faq); status active.
Readiness checks:
  complete  A passing test run: Smoke passed.
  warning   Description and outcome: The outcome is undefined.
Warnings:
  - Description and outcome: The outcome is undefined.
```

`activate` reads the solution's readiness first and activates only when it
passes; it never forces. It prints each check with its result and every
warning; a warning does not block activation (`--json`: `checks` and
`warnings`). A solution that is not ready exits 3 and lists its
blockers. A token without **May activate** is refused before anything is sent
(exit 7): a person then activates in the Admin, or creates a token that may.

## With your coding agent

Every step above is one your coding agent can run for you. With the plugin
installed, open the folder in Claude Code or Codex and describe what you want,
for example: *"Add a question about shipping costs to the smoke tests and make
it pass."*

[Building a solution with a coding agent](coding-agents.md) explains how to
brief the agent, what it shows you at each step, what it leaves to you, and how
to review and test its work.

## Next

- Promote to production: fill in `env/prod.yaml` (another tenant or solution)
  and run `cavelon apply --env prod`. Show that preview to a person before
  confirming it.
- Catch an invalid package before each commit: `cavelon init --hook`.
- Try a pipeline: [`examples/expense-approval/`](../examples/expense-approval/)
  routes expense requests through a policy check to an approval by a person,
  with a test suite that reaches the approval.
- Read the [concepts](concepts.md), the [command reference](commands.md) and
  [troubleshooting](troubleshooting.md).
