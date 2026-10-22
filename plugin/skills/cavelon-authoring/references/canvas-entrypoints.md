# Canvas entrypoints and demo inputs

When creating an ordinary chat or trigger solution, leave it ready to inspect
and debug in the Canvas. Start nodes are optional in the platform, so schema
validation alone cannot establish this. Read the instance's schema for
`registry_entities.orchestration_nodes`, `registry_entities.graph_edges`,
`NodeConfig_chat_start` and `NodeConfig_trigger_start` before writing them;
`cavelon docs get reference/nodes-and-edges` explains the graph rules.

## Chat

Add one `chat_start` and a `pipeline` edge to the first agent or workflow node
in the same harness. Give `config.demo_message` a realistic question from
the solution's tests, rather than a placeholder. For example, alongside an
agent `faq-agent` in harness `support-faq`, `package/registry_entities.yaml`:

```yaml
orchestration_nodes:
  - slug: chat
    name: Chat
    node_type: chat_start
    harness_slug: support-faq
    config:
      demo_message: When can I reach your support team?
    canvas_x: 0
    canvas_y: 200
graph_edges:
  - harness_slug: support-faq
    from_node_ref: {kind: orchestration, slug: chat}
    to_node_ref: {kind: agent, slug: faq-agent}
    edge_type: pipeline
    config: {}
```

Keep conversation history on the Chat Start-to-agent edge at its default.
There is at most one active Chat Start per harness. Starts have no incoming
edges and cannot connect directly to a Join.

## Triggers

For each intended trigger entry, add a `trigger_start` whose
`config.trigger_slug` names the actual trigger in the same harness, then
connect it to the intended first agent or workflow node with a `pipeline`
edge. There is at most one Trigger Start per trigger. A chat-and-trigger
solution can have both kinds of start; a trigger-only solution needs no
artificial chat route.

Suggest and save `config.demo_payload` with realistic, non-sensitive example
values derived from the trigger's actual `config.payload_schema` and
`config.sample_payload`. Include required fields, honor types, enums and
formats, and choose values that exercise a useful path. For a trigger whose
contract requires `order_id` (string) and `total` (number), an appropriate
node fragment is:

```yaml
node_type: trigger_start
config:
  trigger_slug: order-received
  demo_payload: {order_id: DEMO-1001, total: 49.9}
```

Keep the trigger's `config.sample_payload` coherent with that demo. On a
webhook, the **trigger's** `config.payload_schema` validates incoming
payloads. A start node's `sample_payload` or `payload_schema` does not replace
that runtime contract. Supply `demo_request_context` or
`demo_document_names` only when the scenario needs them and the schema offers
them. Demo input neither sets secrets nor grants execution identity; keep a
new trigger inactive until the intended activation is approved.

## Exceptions and completion

Masterloop **iteration** harnesses have constrained entrypoints. A native
iteration requires its agent to be the only root, marked `is_entrypoint`;
pure iterations must also retain their required unambiguous root. Follow
those rules rather than inserting a Chat Start or Trigger Start. Put the
external trigger entry on the parent where appropriate. Do not rewrite legacy or deliberately
headless harnesses solely to satisfy this recommendation.

Before handing over a new ordinary solution, check that its start references
the right harness/trigger, its outgoing edge resolves, and its saved demo
input is useful and schema-compatible. Validate and preview the whole
package, then use the cavelon-testing skill for suites and Canvas debugging.
Running a Canvas demo executes real tools; saved examples alone run nothing.
