# Response rules and plain language

The persona supplies the shared response rules. An agent's `response_rules`
is a sparse map: an absent key or `inherit` takes the persona's rule, and
`off` disables that rule. `{}` inherits everything. `skip_persona: true`
turns every rule off and wins over the map; use it for structured JSON and
internal pipeline agents. An agent answering a person normally leaves both
settings unset.

For a consulted agent that returns evidence to the answering agent, keep the
citations and turn the other rules off in its entry in `package/agents.yaml`:

```yaml
response_rules:
  identity: off
  citations: inherit
  images: off
  action_buttons: off
  response_style: off
  language_hint: off
  plain_language: off
```

Check the current map's keys in `cavelon schema agents` before authoring it.
`response_style` can also select a preset, for example
`{preset: concise}` (`balanced`, `detailed`, `conversational` and `formal`
are the other presets). `language_hint` can override with a language code;
`plain_language` can override with one of the levels below. The map is open
in the package schema: the instance's import preview validates its rule
values. A `config_invalid` blocker names `agents[i].response_rules`; correct
that entry before confirming.

## Choose plain language

Set the solution's level in `package/persona.yaml`, for example:

```yaml
plain_language: on_request
```

| Level | Choose it when |
|---|---|
| `off` | The assistant should use ordinary wording without a plain-language instruction. This is the default. |
| `on_request` | People should be able to ask for a simpler explanation; until then, wording stays ordinary. |
| `auto` | The audience varies: the instance judges the reader once from the first messages. Test both general and specialist openings. |
| `lay` | The answer is for general readers: explain specialist terms and use short, direct sentences. |
| `expert` | Specialists need precise terminology in clear, direct prose. |

The instance composes the DIN 8581 plain-language instructions, ASD-STE100
guidance for technical content and an email layout for emails. Apply this
to the agent answering the person; consulted agents and pipeline stages
feeding another node should not simplify their intermediate output.

Omitting `plain_language` or an agent's `response_rules` on import preserves
the instance's saved value. To turn plain language off explicitly, set `off`;
to reset per-agent overrides to inheritance, set `{}`. A pull from an older
instance cannot be used to reset a newer instance's saved settings.

## Check the wording with a suite

Add a case to a suite in `tests/`. Test the intended level, and for
`on_request` also test a follow-up asking for a simpler explanation. A style
judge criterion checks clarity and meaning; sentence length alone does not
prove either. For example, for the support FAQ:

```yaml
test_cases:
  - name: Explain returns in plain language
    steps:
      - user_message: Please explain in simple words how I return an order.
        evaluation_criteria:
          - text: Uses short, direct sentences and familiar words, explains necessary terms and preserves the return policy's facts.
            dimension: style
          - type: must_not_contain
            label: Long sentence (26 or more words; heuristic)
            value: '\b[^\s.!?]+(?:\s+[^\s.!?]+){25}\b'
            match: regex
            scope: model_answer
            gate: false
```

The assertion is report-only (`gate: false`): it is evaluated and shown, but
its failure does not fail the step. `scope: model_answer` leaves out text the
instance appends, such as a sources list. The regex is a rough signal:
abbreviations, lists and punctuation can skew it. Review the actual answer
and the judge's reasoning in `cavelon trace <run>`.

Run `cavelon validate`, preview and confirm `cavelon apply`, then
`cavelon test run --suite <name> --wait` and read the trace. Check
`cavelon schema test_suites.test_cases.steps.evaluation_criteria` before using
`gate` and `scope`. An older instance without the response-rule fields warns
`package_field_unknown` and lists them as ignored in the apply preview; do
not claim the settings took effect there. Wait for an instance that publishes
them, or omit them for that target.
