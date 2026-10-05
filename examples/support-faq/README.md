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
    agents.yaml         the one agent, its model and prompt: what it does
    persona.yaml        who the assistant is: its name, voice, greeting and fallback
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
tenant's slug, name or id (`cavelon tenant list` shows all three).

Pick the model: the agent uses `gpt-5.4-mini` from `openai`, and the models a
tenant has differ per instance. `cavelon models list` shows yours; set
`llm_model` and `llm_provider` in `package/agents.yaml` to one of them. The
agent's `temperature` is 0.4, the instance's default, because the package
schema requires one. On a reasoning model (the GPT-5 family, the o-series) from
OpenAI, Azure OpenAI or Anthropic the instance does not send it; set the
reasoning level in the agent's **Model** tab in the Admin instead, and
`cavelon pull` brings it into the file.

If someone in your tenant has tried the example already, copy it under your
own name, because knowledge bases are matched by name across the tenant and
two copies would share one. Change the solution's slug in `cavelon.yaml` and
`env/test.yaml`, its `slug` and `name` in `package/harnesses.yaml`,
`harness_slug` in `package/agents.yaml` and `tests/smoke.yaml`, the knowledge
base's `name` in `package/knowledge_bases.yaml` and `knowledge_base_name` in
`package/skills.yaml`, and use that name with `kb upload --kb` below.

`apply` previews into a solution that exists and never creates one, so create
the draft first:

```bash
cavelon harness new support-faq --name "Support FAQ"   # the empty draft solution
cavelon validate                                  # the files against your instance's package schema
cavelon apply --env test                          # a preview, and its id
cavelon apply --env test --confirm <preview-id>   # imports the agent, skill, knowledge base and tests
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
