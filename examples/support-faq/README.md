# Example: a support FAQ

A small Cavelon solution to copy and try: one agent that answers customers'
questions from a support FAQ and says when it does not know. It is what
`cavelon init` and `cavelon pull` write for such a solution, plus three FAQ
pages to upload.

```text
support-faq/
  cavelon.yaml        instance, tenant and solution; never a token
  package/            the solution, one file per section of the package schema
    manifest.yaml       package format v3
    harnesses.yaml      the solution "support-faq", a draft
    knowledge_bases.yaml the knowledge base "Support FAQ"
    skills.yaml         "Answer from the FAQ": the search tool and the knowledge base it searches
    agents.yaml         the one agent, its model and prompt
  tests/smoke.yaml    four test cases: three the FAQ answers, one it must decline
  env/test.yaml       where `cavelon apply --env test` goes
  env/prod.yaml       where `cavelon apply --env prod` goes (empty until you promote)
  seeds/faq/          the FAQ pages to upload; documents live in Cavelon, not here
  AGENTS.md           the short Cavelon block for coding agents
```

`pull` writes a file for every section of the schema, empty ones included; this
example leaves the empty ones out, since the schema requires only the manifest.

## Try it

You need the `cavelon` CLI ([installation](../../docs/installation.md)) and a
login ([getting started](../../docs/getting-started.md#2-log-in)). The
getting-started tutorial walks through this example step by step.

```bash
cp -r examples/support-faq ~/support-faq && cd ~/support-faq
git init
```

Edit two lines of `cavelon.yaml`: `instance` is your Cavelon URL, `tenant` your
tenant's slug (`cavelon whoami` shows it). The agent uses the model `gpt-4.1`
from `openai`; `cavelon models list` shows the models your tenant has, so change
`llm_model` and `llm_provider` in `package/agents.yaml` if it has another.

```bash
cavelon validate                                  # the files against your instance's package schema
cavelon apply --env test                          # a preview, and its id
cavelon apply --env test --confirm <preview-id>   # creates the draft solution and its knowledge base
cavelon kb upload seeds/faq --kb "Support FAQ" --wait
cavelon test run --suite Smoke --wait --timeout 5m
cavelon trace <run>                               # why a case did or did not pass
```

From here, change the prompt, the FAQ or the tests, and run the loop again:
`validate`, `apply`, `test run`, `trace`. With the Cavelon plugin in your coding
agent, open this folder and ask it, for example, to "add a question about
shipping costs to the smoke tests and make it pass".

When the tests pass, activate the solution through its readiness gate:
`cavelon activate`.
