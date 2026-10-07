# Getting started

This tutorial takes you from an empty folder to an active Cavelon solution: a
support assistant that answers customers' questions from three FAQ pages and
says when it does not know. It uses the files of
[`examples/support-faq/`](../examples/support-faq/), and every step is a
`cavelon` command you can run yourself or let your coding agent run.

It takes about fifteen minutes. You need:

- `cavelon`, installed with the one-line install
  ([Installation](installation.md#install-the-cli)), and git. With Node.js
  20.3 or newer, `npx -y @cavelon/cli` runs it without an install, and in this
  tutorial `cavelon` then stands for that. Your coding agent, set up with
  `cavelon setup`, is optional for this tutorial;
- a Cavelon instance with personal access tokens and the operations API turned
  on, and an account that is a tenant admin of a tenant you may test in.

The outputs below are what `cavelon` prints, shortened where marked with `…`.
Your ids, dates and counts will differ. The instance in the examples is
`https://cavelon.example.com` and the tenant is Acme Support (slug `acme-support`).

## 1. Create a personal access token

In Cavelon, open your user menu → **Personal access tokens** (the page
`/account/access-tokens`) and choose **Create token**:

- give it a name you will recognise, such as `laptop`;
- pick an expiry;
- pick the lowest ceiling that does the job; the token never gets more than
  your own rights, and the dialog recommends one per task:

  | Task | Ceiling |
  |---|---|
  | read-only checks (`status`, `limits`, `trace`) | **Observer** |
  | building and testing a solution (this tutorial) | **Builder** |
  | changing the tenant's limits or settings | **Tenant Owner** |

  Leave **Platform mode** off unless you operate the platform;
- tick **May activate** only if this token may put solutions live. For step 11
  of this tutorial it needs to; for day-to-day building and testing it does
  not.

Your instance's page on personal access tokens explains the ceilings:
`/docs/administration/personal-access-tokens` on your instance, or
`cavelon docs get administration/personal-access-tokens` once you are logged in.

The token starts with `cvpat_` and is shown once. Keep the page open until the
next step.

## 2. Log in

If you ran `cavelon setup`, it logged you in this way already: run
`cavelon whoami` to see as whom, and go on with step 3.

In a terminal of your own (not in the agent's chat), run:

```bash
cavelon login --instance https://cavelon.example.com
```

Use the address of your Cavelon instance, the URL you open Cavelon at in the
browser, in place of `https://cavelon.example.com`; the docs use that
placeholder throughout. `login` asks for the token without showing what you type, checks it against the
instance, and stores it in your system's credential store:

```text
Token (input hidden):
This token reaches 2 tenants on https://cavelon.example.com:
   1  Acme Support  acme-support  (tenant_admin)
   2  Globex  globex  (tenant_viewer)
Which tenant? (type its number or part of its name) acme
Logged in to https://cavelon.example.com as ada@example.com. Token stored in the credential store. Using tenant Acme Support (acme-support, 4f6174cf-3060-4ff1-bd3c-8a8e7999256b); `cavelon use` chooses another.
```

A token that reaches one tenant uses it without asking. To skip the question,
name the tenant: `--tenant acme-support` (a name, slug or id works).

An operator's token that reaches every tenant works in every tenant, one at a
time, so the choice at login is only where to start:

```text
This token works in every tenant on https://cavelon.example.com, one at a time: `cavelon use` switches, and --tenant or `tenant:` in cavelon.yaml choose one per command or per solution folder.
Which tenant to start in? (type part of its name, or press Enter to choose later)
```

Part of a name searches the instance's tenants. Enter chooses later: the token
is stored without a tenant, as with `--token-stdin`, `cavelon status` shows the
tenant as not chosen, and `cavelon use <name or slug>` chooses one when you
need it.

Without a terminal (CI, `--token-stdin`), nobody can answer: a token for
several tenants is stored, and `login` prints one ready line per tenant, such
as `cavelon use acme-support`, and exits 2. An older instance does not tell a
token its tenants; there `login` stops with `tenant_required` when the instance
cannot place the token itself, and you log in again with `--tenant
<tenant-id>`, the id an operator copies in **Platform › Tenants**.

`cavelon` never takes a token as a command-line argument, so it never lands in
your shell history, and your coding agent never sees it. To paste it from a
password manager instead, pipe it: `op read op://dev/cavelon/token | cavelon login --instance
https://cavelon.example.com --token-stdin`.

Check who you are:

```bash
cavelon whoami
```

```text
instance:          https://cavelon.example.com (login)
acting as:         Ada Lovelace <ada@example.com>
tenant:            Acme Support (acme-support, 4f6174cf-3060-4ff1-bd3c-8a8e7999256b)
tenant from:       `cavelon use`, for every folder without a cavelon.yaml (--tenant chooses another for one command)
role:              tenant_admin
credential:        personal access token "laptop" from login (credential store)
expires:           2026-12-02T15:40:26.342Z (in 60 days)
may activate:      yes
may set secrets:   yes
may set variables: yes
permissions:       agents.edit, agents.view, harnesses.activate, harnesses.manage, harnesses.view, knowledge_bases.manage_documents, knowledge_bases.view, limits.view, playground.use, settings.manage, settings.secrets.manage, settings.view, … 9 more (--json)
version:           v1.42.0
```

`permissions` is what the instance accepts from this token in the tenant: its
role there, capped by the token's ceiling. A tenant API key shows its
`scopes` too, and the operations a person runs instead ("needs a person"). The
kit offers and suggests only what these allow. An older instance publishes the
permissions of a person's token only; for an API key there the kit says
nothing up front and behaves as before.

To work in another tenant later, run `cavelon use`: it shows the same list.
`cavelon tenant list` shows each tenant's name, slug and id.

## 3. Create the solution folder

```bash
mkdir support-faq
cd support-faq
git init
cavelon init
```

`init` asks which solution this folder holds:

```text
This tenant has 1 solution; choose it, or start a new one:
   1  Expense Approval  expense-approval  (draft)
   2  a new solution (or type new)
Which solution does this folder hold? (type its number or part of its name) new
Name of the new solution: Support FAQ
Created the draft solution Support FAQ (support-faq).
created   cavelon.yaml
created   package/
created   tests/
created   seeds/
created   env/test.yaml
created   env/prod.yaml
created   .cavelon/
created   .gitignore
created   AGENTS.md
created   package/persona.yaml
created   package/manifest.yaml

Next:
  Write the package files in package/, then: cavelon validate
  Catch an invalid package before each commit: cavelon init --hook
```

To answer up front, name them: `cavelon init --tenant acme-support --harness
"Support FAQ"`. When no solution matches the name, `init` creates the draft
right away, named as given and with a slug made from the name, and prints the
same `Created the draft solution Support FAQ (support-faq).` For a solution
that already exists, `init` writes its slug, and `cavelon pull` brings it into
`package/`. As your coding agent's MCP tool, `init` never creates a solution:
it names the `cavelon harness new` command that does, for you to run or
approve.

For a solution that exists already, `init` ends with the step that brings it
into the folder:

```text
Next:
  Bring the solution into package/: cavelon pull
  Catch an invalid package before each commit: cavelon init --hook
```

A name close to an existing solution's may be a typo, so `init` refuses it
(`solution_not_found`, exit 1), names the closest solutions and creates
nothing:

```text
error: No solution "Support FAQ v2" in this tenant. Closest: Support FAQ (support-faq).
hint: If you meant one of them:
  cavelon init --harness support-faq --tenant acme-support
`cavelon harness list --tenant acme-support` shows this tenant's solutions with name, slug and id; `cavelon harness new <slug> --name <name> --tenant acme-support` creates one as a draft. For a new solution of that name: cavelon init --harness 'Support FAQ v2' --new --tenant acme-support.
```

When you do mean a new solution, add `--new`: `init --harness "Support FAQ v2"
--new` creates the draft whatever names are close to it (and refuses a name or
slug the tenant already has, `solution_exists`). The commands `init` prints
carry the `--tenant` you gave, since until `cavelon.yaml` exists nothing else
names the tenant.

`cavelon.yaml` names the instance, the tenant and the solution (a *harness* in
Cavelon's API) by their slugs, with a comment that names the tenant, never a
token:

```yaml
instance: https://cavelon.example.com
tenant: acme-support  # Acme Support, 4f6174cf-3060-4ff1-bd3c-8a8e7999256b
harness: support-faq
```

`env/test.yaml` says where `apply --env test` goes. `.cavelon/` holds local
state and is ignored by git. `package/manifest.yaml` names the package format
and the tenant the package is for, so `validate` passes before the first pull
(the first `pull` replaces it with the instance's). `package/persona.yaml`
lists every field of the solution's persona as a comment, until you set one. See
[Concepts](concepts.md#the-solution-folder) for each file.

This solution is new and empty, so take its files from the example.

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
  agents.yaml            one agent, its model and its prompt: what it does
  persona.yaml           who the assistant is: its name, voice, greeting and fallback
tests/
  smoke.yaml             four test cases: three the FAQ answers, one it must decline
seeds/faq/               three FAQ pages to upload
```

Each file under `package/` is one section of the instance's package schema
(copying `package/` replaces the `persona.yaml` and `manifest.yaml` that `init`
wrote).
The persona says who the assistant is for every agent of the solution; an
agent's `system_prompt` says what that agent does. See
[Persona](concepts.md#persona).
A knowledge base reaches the agent only through a tool that reads it: the
skill carries the built-in `search_documents` in its `tool_assignments`, and
names the knowledge base it searches (`list_documents` lists a knowledge base's
documents by their metadata, and `read_document` reads one by id).
`cavelon validate` warns about an agent that is given a knowledge base no such
tool reaches.

### Under your own name

The example's files name the solution `support-faq` and the knowledge base
"Support FAQ". If `init` made a solution with another slug (the `harness:` in
`cavelon.yaml`), or someone in your tenant has copied the example already,
change these to your own:

| File | What to change |
|---|---|
| `package/harnesses.yaml` | `slug` (the one in `cavelon.yaml`) and `name` |
| `package/agents.yaml` | `harness_slug` |
| `tests/smoke.yaml` | `harness_slug` |
| `package/knowledge_bases.yaml` | `name` of the knowledge base |
| `package/skills.yaml` | `knowledge_base_name` under `knowledge_base_assignments` |

Use the new knowledge base name in step 7's `cavelon kb upload --kb` too.
Knowledge bases are matched by name across the whole tenant: two people who
copy the example unchanged share one "Support FAQ" knowledge base, and each
upload changes it for both.

### The model

Open `package/agents.yaml`: the agent uses the model `gpt-5.4-mini` from
`openai`. Which models a tenant has differs from instance to instance, so look
them up:

```bash
cavelon models list
```

Set `llm_model` and `llm_provider` in `package/agents.yaml` to one of them (the
MODEL_ID and PROVIDER columns). `cavelon validate` warns about a model the
tenant does not list, and the preview in step 6 blocks it.

The package schema requires a `temperature`, and the example gives the
instance's default, 0.4. On a reasoning model (the GPT-5 family, the o-series)
from OpenAI, Azure OpenAI or Anthropic, the instance does not send a
temperature at all, so changing it changes nothing (the preview says so for a
value other than the default). Set the reasoning level instead: in the Admin,
open the agent's **Model** tab in the Node Workbench and pick low, medium or
high; `cavelon pull` then brings what the instance stored into
`package/agents.yaml`. On a model that is not a reasoning model,
`temperature` works as usual. `cavelon docs get concepts/choosing-models`
explains which models take which.

## 5. Validate

```bash
cavelon validate
```

```text
Valid against package schema v3 (7 sections).
```

`validate` checks the files against the package schema your instance
publishes, and caches the schema, so later runs work offline
(`cavelon validate --offline`). An error names the file, the line and a code:

```text
error package_schema_invalid  package/agents.yaml:4 agents[0].temperature: must be number
1 error, 0 warnings. `cavelon explain <code>` says more.
```

`validate` also checks what the schema cannot: two entries with one slug, a
handoff or a test assertion (`answered_by`, `handoff_to`) naming an agent the
package lacks (errors), and, as warnings, a field the schema does not have
("did you mean temperature?"), a skill, tool, knowledge base or solution that
is neither in the package nor among what the tenant holds, a model outside the
tenant's model list, and a package that names another solution than
`cavelon.yaml`. The import preview blocks a name the instance does not have,
so for those `validate` does not say "Valid"; `cavelon validate --strict` fails
on any warning. `cavelon schema agents.handoffs` (or any section and field
path) shows the fields a nested entry takes.

`cavelon explain <code>` looks any code up in the instance's error catalog, and
knows `cavelon`'s own codes too; for a code it does not know, it names the
closest ones.

When you write package files by hand, `cavelon fmt` brings them into the form
the instance's export gives them (field order, the defaults it fills in, and
the written order of test cases), so the first `cavelon pull` after an apply
shows only what changed on the instance. Like `pull`, it keeps no comments: it
names each file whose comments it drops, so keep notes you need (such as the
explanations in the example files) elsewhere, or commit the files first.

## 6. Preview, then apply

`apply` never changes anything on the instance without `--confirm`. First it
previews:

```bash
cavelon apply --env test
```

```text
Preview of package/ for solution support-faq (draft) [env test]:
ready:   yes
creates: 1 agents, 1 knowledge_bases, 1 skills, 1 test_suites
warnings:
  - Knowledge bases are matched by name … "Support FAQ" …
  - … "Support FAQ" … imported as config only …

preview id: pv1_55ed52186395560a11ad7e525a2b9553
Import exactly this: cavelon apply --confirm pv1_55ed52186395560a11ad7e525a2b9553 --env test
```

If the instance lists imports in this credential's `needs_a_person`, an API
key still previews but gets no confirm command. A person imports in the
Admin or with their own personal access token; `apply --confirm` with the
restricted credential refuses before sending (`import_needs_a_person`,
exit 5). JSON previews carry `import_access` with `allowed: false`, the
instance's `needs_a_person` reason and the person hint. On an older instance
that publishes no restriction, the server decides whether the import is
allowed.

The preview lists what the import would create, change and delete, which
active solutions it reaches, what the tenant still needs (secrets, variables,
grants), and the instance's warnings. The two warnings here are expected:

- *Matched by name*: the import looks a knowledge base up by its name across
  the tenant. If the tenant already has one called "Support FAQ", the solution
  uses that one rather than a new one (see [Under your own
  name](#under-your-own-name)).
- *Config only*: the package carries the knowledge base's settings, never its
  documents. They come in step 7.

A solution that uses a secret (`{{secret:<name>}}`, declared in
`package/required_secrets.yaml`) lists it under "needs secrets" with the
`cavelon secrets set <name>` command that sets it. Only a role allowed to
manage secrets runs that, such as the tenant's Owner: with a Builder's token
`secrets set` is refused and names who sets it instead (a tenant Owner, in the
Admin under Settings › Secrets or with their own token). `cavelon whoami` shows
whether your token may ("may set secrets"). Where the instance lets no token
set a secret, the preview names the Admin page instead of the command: set it
there, signed in.

`apply` previews into a solution that exists and never creates one. If
`env/test.yaml` names a solution that is not on the instance (you skipped
`init`'s draft, or wrote the slug by hand), it stops before the preview
(`solution_not_found`, exit 1) and names the command that creates the draft:

```text
error: Solution support-faq, which env/test.yaml names, is not on the instance yet; apply previews into an existing solution and creates none.
hint: Create it as a draft: cavelon harness new support-faq --name 'Support FAQ', then run `cavelon apply --env test` again.
```

Read the preview, then confirm exactly that preview:

```bash
cavelon apply --env test --confirm pv1_55ed52186395560a11ad7e525a2b9553
```

```text
applied: preview pv1_55ed52186395560a11ad7e525a2b9553 to support-faq (env test)
created: 1 agents, 1 knowledge_bases, 1 skills, 1 test_suites
```

If the solution changed on the instance, or the package files changed, after
the preview, the confirm is refused (exit 4) and nothing is imported; preview
again. See
[Preview and confirm](concepts.md#preview-and-confirm).

## 7. Upload the knowledge

```bash
cavelon kb upload seeds/faq --kb "Support FAQ" --wait
```

```text
Uploaded 3 files.
op_document_ingestion_3db2fad227b346a6a81a63d7e619edc3  document_ingestion  succeeded  phase ready  1/1
op_document_ingestion_587709377db846d7ac299add39f815fc  document_ingestion  succeeded  phase ready  1/1
op_document_ingestion_bc92267fb1f04e11adbbae5b83ae1cac  document_ingestion  succeeded  phase ready  1/1
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
op_test_run_82f8a0a73ef74dc29e24b89e3e7d5303  test_run  succeeded  phase completed  1/1

Smoke: completed  passed 4  failed 0  errors 0  pass_rate 1
```

When a case does not pass, the command exits 1 and names it:

```text
op_test_run_82f8a0a73ef74dc29e24b89e3e7d5303  test_run  succeeded  phase completed  1/1
  test run 82f8a0a7-3ef7-4dc2-9e24-b89e3e7d5303 (Smoke) finished, but cases did not pass: 1 failed
    Not in the FAQ (step 1)  fail: The answer contains a poem.
  Look closer: cavelon trace 82f8a0a7-3ef7-4dc2-9e24-b89e3e7d5303
```

The operation succeeded (the run finished); its result did not pass. That is
why the exit code is 1, so a script or CI job stops there. A run whose answers
wait for a person's verdict exits 5.

For a suite that checks knowledge access or an identity-bound database query,
choose a test Chat User of the acting tenant:

```bash
cavelon whoami
cavelon api list_chat_users -p tenant_id=<tenant_id> --json
cavelon test run --suite Smoke --as-chat-user <chat_user_id> --wait --timeout 5m
```

The reader applies to these runs only; the saved suite keeps its settings.
Without `--as-chat-user`, each suite uses its saved reader. A personal access
token needs `knowledge_bases.view` and `end_users.read` to choose this reader,
besides its permission to run tests. Listing Chat Users needs
`chat_users.view`. For a query bound to `end_user.email`, choose an identity
whose published `email_verified` is true: an unverified address asks the
visitor to sign in. An older instance may omit that flag; its absence does
not prove the email is verified. Use test identities and known test rows.

An instance without reader support refuses the selection before starting
anything. An older instance may publish reader fields but refuse a PAT on
them; follow its refusal or ask the operator for reader support. Omitting
the option keeps normal test runs available.

## 9. Read the trace

```bash
cavelon trace 82f8a0a7-3ef7-4dc2-9e24-b89e3e7d5303
```

```text
CASE            STEP  STATUS  SCORE  AGENT      CONVERSATION_ID
Opening hours   1     pass    0.9    faq-agent  11111111-1111-4111-8111-111111111111
Return window   1     pass    0.95   faq-agent  22222222-2222-4222-8222-222222222222
Refund time     1     pass    0.9    faq-agent  33333333-3333-4333-8333-333333333333
Not in the FAQ  1     pass    1      faq-agent  44444444-4444-4444-8444-444444444444

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

For a test run, `trace` lists each case with its score, the agent that
answered it and, where the instance sent it, the judge's reasoning; a case that
did not pass also shows its error.
Each command `trace` prints works as printed: it carries the id its route
needs. A case's traces are under its conversation id, so `cavelon trace
<conversation_id> --kind conversation` opens one case's conversation: its
traces, then with `--trace <trace_id>` their spans (model calls, retrievals,
tool calls), each level with the command that shows the next. A knowledge
search's spans show what the agent recorded the search found, in a
KNOWLEDGE_OUTCOME column, on an instance that records it. A test run's id
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
instance, the tenant by name, the solution with its state and whether it is
the tenant's default route, its running operations and any open previews for
this folder.

## 11. Activate

When the tests pass, activate the solution through its readiness gate:

```bash
cavelon activate
```

```text
Activated Support FAQ (support-faq); status active.
Readiness checks:
  ready  Outcome defined: …
  ready  Solution setup is confirmed: …
  ready  Runtime has an active agent: …
  ready  A start path is defined: …
  ready  Graph check passes: No blocking graph errors; 0 warnings.
  ready  Expected behavior is tested: …
  ready  Every agent has a model this tenant carries: All agents resolve to an active registry entry.
  ready  Tenant values are filled in: Every variable the prompts reference has a value.
```

The checks, their names and their texts are the instance's own; `…` stands
for a text that depends on your solution. `activate` reads the solution's
readiness first and activates only when it passes; it never forces. It prints
each check with its state (`ready`, or `action_required` for one that blocks)
and every warning under `Warnings:`; a warning does not block activation
(`--json`: `checks` and `warnings`). A solution that is not ready exits 3 and lists its
blockers. A token without **May activate** is refused before anything is sent
(exit 7): a person then activates in the Admin, or creates a token that may.
A new draft that nothing reaches yet activates at once, as above. A solution
that a channel or an active trigger already reaches goes live for them the
moment it is active, so there `activate` previews first: it names the
channels and triggers (on an instance that does not say what reaches a
solution, it says so), activates nothing, and prints the command that does,
`cavelon activate --harness support-faq --confirm` (from a coding agent's
shell, with the preview's token).

`activate` also says whether the solution is the tenant's **default route**,
the one the tenant's chat and widget answer with where no solution is named:

```text
Not the default route: the tenant's chat and widget answer with Default (default) where a conversation names no solution.
Ask the person whether Support FAQ (support-faq) should answer there; that changes live traffic. Preview: cavelon harness default support-faq
```

To make it the default, preview the change, then confirm it:

```bash
cavelon activate --make-default
cavelon activate --make-default --confirm
```

That bare `--confirm` is your form, in your terminal. Run by a coding agent,
the preview prints the command with a token instead
(`cavelon activate --make-default --confirm 3f9a0c1d2e4b`), and the agent
confirms with exactly that: its shell refuses a bare `--confirm` (exit 5), so
it cannot skip the preview you are shown.

`cavelon harness default <solution>` does the same for a solution that is
already active, and `cavelon harness list` marks the default in its DEFAULT
column. See [Default route](concepts.md#default-route).

### Try it without making it the default

The tenant's chat and widget answer only with the default route, so an active
solution that is not the default answers nobody there. Talk to it by name
instead:

```bash
cavelon chat "When are you open?" --harness support-faq
```

```text
Support FAQ (support-faq) answered:
We are open Monday to Friday, 9:00 to 17:00 CET.

session:          3f1c…   continue with: cavelon chat '<message>' --session 3f1c…
conversation_id:  5b2e…   its traces: cavelon trace 5b2e… --kind conversation
```

`chat` sends one message and prints the answer; `--session` continues the
conversation, and `--json` gives `response`, `session_id`, `conversation_id`,
`agent_run_id` and `harness`. Inside the solution folder `--harness` can be
left out: `chat` then talks to the solution `cavelon.yaml` names (outside one,
to the default route). A draft answers as a Playground run, so only a person's
token gets an answer from one, never a tenant API key.

To try the same knowledge and query access as a test Chat User, use
`cavelon chat "What are my orders?" --harness support-faq --as-chat-user
<chat_user_id>`. It needs a personal access token with
`knowledge_bases.view` and `end_users.read`. Choose the id with
`cavelon api list_chat_users -p tenant_id=<tenant_id>` and check
`email_verified` for email-bound queries. The continuation command keeps
the selected reader and solution. Without the option, chat keeps its usual
reader. A missing, deleted or cross-tenant reader is refused by the instance;
use a current identity from the acting tenant's list.

### Take it out of service

`cavelon deactivate` takes an active solution out of live traffic: its status
becomes `inactive`, not `draft`. A draft has not been activated yet; an
inactive solution was taken out of service, keeps its configuration, and
`cavelon activate` puts it back through its readiness gate. It previews first,
and changes nothing until you confirm:

```bash
cavelon deactivate
cavelon deactivate --harness support-faq --confirm
```

A coding agent cannot confirm it: over MCP your agent client asks you, and
from the agent's shell the preview names the command you run in your own
terminal, as for `activate --make-default`.

Deactivating is a person's decision. A solution that is the tenant's default
route is refused before anything is sent: make another solution the default
first (`cavelon harness default <other>`). On an instance that publishes no
way to deactivate, the command says so (`operation_unavailable`, exit 1), and a
person deactivates in the Admin.

## With your coding agent

Every step above is one your coding agent can run for you. Once
`cavelon setup` has set it up, open the folder in your agent and describe what
you want, for example: *"Add a question about shipping costs to the smoke tests and make
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
