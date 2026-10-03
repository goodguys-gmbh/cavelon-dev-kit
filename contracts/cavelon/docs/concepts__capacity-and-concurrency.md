# Capacity and Concurrency

> Every limit that decides how much work runs at once — model endpoint slots, run caps, branches inside a run, ingestion and rate limits — what waits, what is refused, and where each one is set and seen

A model endpoint you run yourself — a vLLM server, an on-premises gateway, a GPU box — serves a fixed number of requests at once. Send it more and the extra requests either queue invisibly on the server until they time out or are refused there. Cavelon lets you state that number and keeps every part of the platform under it: chat, triggered and channel runs, and knowledge-base ingestion share one count.

This page explains each limit that decides how much work runs at the same time, how they fit together, and what happens when one of them is full. To plan the numbers for a concrete server, follow [Plan Capacity for a Self-Hosted Model](/docs/tutorials/plan-model-capacity). For every variable and its default, see the [Configuration Reference](/docs/reference/configuration#concurrency-rate-limits-and-circuit-breaker).

## The layers at a glance

Work reaches a model through several gates. Each one counts something different:

| Layer | Counts | Default | Set in | When full |
|---|---|---|---|---|
| **Endpoint limit** | Requests in flight to one model server | No limit | The model's **Max Concurrent Requests** in [Model roles](/docs/administration/model-registry#limiting-concurrent-requests-to-an-endpoint) | The request waits in line, up to 120 seconds, then fails with `model_endpoint_busy` |
| **Run caps** | Agent runs executing at once, per tenant and platform-wide | 20 per tenant, 200 in total | **Platform › Operations › Rate limits › Run caps**; a tenant's own cap in its **Limits** section | Chat waits up to 30 seconds, then shows a friendly busy message; a triggered or channel run waits in line until a slot frees |
| **Branch concurrency** | Branches of one fan-out, or items of one Map loop, running at once | 8 per node, 32 per worker process | A node's **Max concurrency**; `ORCHESTRATION_MAX_BRANCH_CONCURRENCY`, `ORCHESTRATION_PROCESS_MAX_BRANCH_INFLIGHT` | Further branches wait for a branch slot |
| **Ingestion** | Contextual-prefix calls per document batch; scrapes per tenant | 1 call per batch; 2 scrapes per tenant | `CONTEXTUAL_PREFIX_MAX_CONCURRENCY`, `SCRAPE_TENANT_CONCURRENCY_LIMIT` | Further work waits its turn |
| **Rate limits** | Requests per minute per tenant and endpoint group | 200 chat rpm, 600 read, 120 admin | `RATE_LIMIT_*_RPM`, per-tenant overrides | HTTP 429 with rate-limit headers; chat answers with a friendly message |

The first two are the ones you plan with. Branch concurrency decides how fast one run with a fan-out or a Map loop finishes. The last two shape how much load one document or one integration can create, and protect the platform rather than a model.

### One name per limit

These docs, the Admin and the API use the following names for the three limits you set yourself:

| Name | In the Admin | In the API and configuration | Refusal code |
|---|---|---|---|
| **Endpoint limit** | **Max Concurrent Requests** on a model in Model roles | `max_concurrent_requests`; one request in flight holds one *endpoint slot* | `model_endpoint_busy` |
| **Run cap** | **Run caps** under Platform › Operations › Rate limits; a tenant's own cap is its **Concurrent Agent Runs** | `MAX_CONCURRENT_AGENT_RUNS_PER_TENANT`, `MAX_CONCURRENT_AGENT_RUNS_GLOBAL`; one running run holds one *run slot* | `run_capacity_busy` |
| **Branch concurrency** | **Max concurrency** on a fan-out edge or a For Each Item node in Map mode | `max_concurrency`, `ORCHESTRATION_MAX_BRANCH_CONCURRENCY`, `ORCHESTRATION_PROCESS_MAX_BRANCH_INFLIGHT` | none: a branch waits for a branch slot |

## Model endpoint slots

The endpoint limit is the one that protects a model server. It belongs to a model in the registry, and only to a model with its own **Base URL**: models that reach a provider through the platform's own routes (OpenAI, Anthropic through the gateway) are bounded by that provider's rate limits instead.

- **Everything counts.** Every request to the endpoint takes a slot: chat turns, triggered and channel runs, guardrail and utility calls, and the contextual prefixes and metadata extraction of ingestion — whenever the model they use is this one. The count is held in Redis, so the API and every worker share it.
- **One count per server and API key.** Every model that sends the same API key (or none) to the same Base URL (same scheme, host, port and path) shares the count, in this tenant and in any other. Each model applies its own limit to it, so give every model on one server the same number. Models with different keys on one URL are different accounts, at a public gateway for example, and are counted separately; so are several virtual keys in front of one server.
- **First come, first served.** A request beyond the limit waits in line instead of reaching the server. A streamed answer keeps its slot until the stream ends.
- **Bounded wait.** A request that finds no free slot within `MODEL_ENDPOINT_SLOT_WAIT_SECONDS` (120 seconds by default) fails like a provider's rate limit, with the code `model_endpoint_busy`, and is not retried by the model client.
- **Self-healing.** A slot whose process crashed is freed within 30 seconds. If Redis cannot be reached, requests go out without a slot rather than stopping every model call.

What a refusal looks like depends on who is waiting:

| Caller | After the wait runs out |
|---|---|
| A chat turn | The persona's fallback message; the conversation trace names `model_endpoint_busy` |
| A triggered or channel run | The run fails, and its trace names `model_endpoint_busy` |
| Ingestion (contextual prefixes) | The chunk is retried in the next of `CONTEXTUAL_PREFIX_RETRY_ROUNDS` rounds |

## Run caps

A run cap counts **agent runs**, not requests. One run holds one slot from its start to its end — through hand-offs, tool calls and pipeline stages — and releases it when it pauses at an approval or a wait. The parallel branches of a fanout or Map node share the run's slot.

- **Per tenant and platform-wide.** A run needs a slot under both caps. The defaults are 20 per tenant and 200 in total.
- **Set in the Admin.** A platform operator changes the three values under **Platform › Operations › Rate limits › Run caps**: runs per tenant, runs on the platform, and how long a chat waits for a slot. Every process applies a change within a minute, without a restart. A value set there wins over the environment variable, which stays the installation's baseline: clearing the field returns to it. Each value shows where it comes from — set here, the environment, or the code default.
- **Per tenant.** A tenant can get its own cap — larger or smaller — in its **Limits** section (**Concurrent Agent Runs**). Only a platform operator can set it; the platform cap still binds on top.
- **Chat waits briefly.** A chat request waits up to 30 seconds (`AGENT_RUN_SEMAPHORE_TIMEOUT`) and then answers with a friendly, translated "I'm helping several people at once" message instead of an error.
- **Background work waits in line.** A run the worker executes — started by a trigger, a schedule or a channel message, or continued after an approval expired or a wait ended — never gives up for capacity. It stays pending — shown as **Waiting for capacity** in **Workflow runs** and on its run page — and asks again every 5 to 20 seconds until a slot frees, so a burst of triggers drains at the pace the caps allow. If a run is still refused on a path nobody watches, it ends **failed** with `run_capacity_busy` — never as a completed run whose answer is the busy message.

## Branch concurrency

Branch concurrency counts the parallel work **inside one run**: the branches of a fan-out, or the items of a For Each Item node in **Map** mode. It holds no run slot of its own; all branches share their run's slot. Every branch makes its own model calls, though, so each one takes its own endpoint slot.

- **Width per node.** A node runs at most 8 branches at once (`ORCHESTRATION_MAX_BRANCH_CONCURRENCY`). Its own **Max concurrency** (`max_concurrency`) can lower that width for this node, never raise it: a value above the platform width is capped. A Map loop over 46 sections at width 8 keeps eight of them in flight and starts the next one as soon as one finishes.
- **Ceiling per process.** All runs in one worker or API process share at most 32 branch slots (`ORCHESTRATION_PROCESS_MAX_BRANCH_INFLIGHT`). A branch beyond that waits for a slot to free.
- **Switched on twice.** Concurrent branches need the platform switch `ORCHESTRATION_PARALLEL_FANOUT_ENABLED` and the tenant's feature flag **Concurrent parallel fanout** under [Feature Flags](/docs/administration/feature-flags). Both are on by default. With either off, the same graph runs its branches one after another and gives the same result.

**When a loop runs one item after another.** The width only matters when the node may run concurrently at all. A fan-out or Map loop falls back to running its branches in sequence, with the same result, when:

- the run is a **Debug step-by-step** run;
- a branch is not a plain agent, or its agent writes Run State, has an external side effect or can pause;
- a Map loop's body has more than one node, or an extra per-item condition;
- a Map loop's body agent has an error edge that does not lead to **one recovery agent returning straight into the loop**. With that shape the loop stays concurrent, and a failed item runs the recovery agent in its own slot. Any other recovery shape, such as a transform or a chain of nodes, runs the loop in sequence so the recovery happens as wired.

The difference is large for long documents. Governed Document Review reviews the 46 sections of a 144-page regulation concurrently and reaches its approval step in about two and a half minutes. Run in sequence, the same section loop took about 25 minutes. The rules per node are in [Hybrid Orchestration](/docs/concepts/hybrid-orchestration#fan-out-versus-for-each) and [Concurrent execution and debug mode](/docs/concepts/hybrid-orchestration#concurrent-execution-and-debug-mode).

## Which limit to use

The two limits answer different questions, and most installations with a self-hosted model use both:

- **The endpoint limit** (Max Concurrent Requests) answers *"how much can the server take?"* It is the only limit that sees every call, including the ones no run makes (ingestion) and the several calls one run can make at once (a fanout of eight branches makes up to eight calls).
- **Run caps** answer *"how much work may one tenant, or the platform, start at once?"* They keep one tenant from occupying every slot and bound memory, database connections and worker time.
- **Branch concurrency** answers *"how fast may one run go?"* Lower a node's **Max concurrency** when its branches would crowd out other runs on a small endpoint; leave it at the platform width to finish a long document quickly.

A run cap alone cannot protect a model server: it counts runs, ingestion is not a run, and a single run may hold several requests at once. An endpoint limit alone cannot keep tenants fair: the line is first come, first served. Set the endpoint limit to what the server serves, and use the run caps to share it.

## Watching it

**Platform › Operations › Rate limits** shows the live state:

- **Run Concurrency** — runs executing now against the platform cap, and how many runs wait for a slot, in total and per tenant.
- **Model Endpoints** — one entry per server with a limit, listing the models that share its count: requests in use against the largest limit, and how many are waiting. A warning names a server whose models have different limits. A waiting count that stays above zero means the server is the bottleneck.
- **Run caps** — the caps in force and where each comes from.

In a solution's **Workflow runs**, a run held back for a slot shows **Waiting for capacity** instead of Pending, and its run page says why. The runs API reports the same as `waiting_for_capacity`. Per run, the conversation or run trace names `model_endpoint_busy` or `run_capacity_busy` when one of the limits refused it. Both codes are in the API's error catalog (`GET /api/v1/meta/error-catalog`).

## For developers and agents

`GET /api/v1/meta/capabilities` publishes the limits that apply to a workspace in its `limits` section, read with any API key or personal access token:

- `max_concurrent_agent_runs_per_tenant` — `source: tenant` when the tenant has its own cap, otherwise `source: platform` with an `origin` of `platform_setting`, `environment` or `default`.
- `max_concurrent_agent_runs_global` and `agent_run_slot_wait_seconds` — the platform values, each with its `origin`.
- `model_endpoint_slot_wait_seconds` — how long a request waits for an endpoint slot.
- `orchestration_max_branch_concurrency` — the width per node. A node's `max_concurrency` above it is capped.
- `orchestration_process_max_branch_inflight` — the branch slots one process shares, with `scope: instance`.
- `orchestration_parallel_branches` — `true` when this workspace's branches run concurrently. Its `switches` list the platform switch `ORCHESTRATION_PARALLEL_FANOUT_ENABLED` and the workspace's feature flag (`feature_flags.ORCHESTRATION_PARALLEL_FANOUT_ENABLED`), each with `enabled`. With branches off, `setting` names the switch that turned them off. Both switches are `changeable_by: operator`, because only a platform operator reaches Feature Flags. Its `change` sets the workspace's flag (`PUT /api/v1/admin/feature-flags/{tenant_id}/ORCHESTRATION_PARALLEL_FANOUT_ENABLED`, field `enabled`) as a platform admin or superadmin, in Platform mode; the platform switch is configuration and has none.

Each run cap also carries a `change`: the operation that changes it, the body `field`, its `minimum` and `maximum`, the global roles in `requires_role` and `mode: platform`. An operator changes a run cap from the dev-kit or a script with a personal access token in Platform mode (no `X-Tenant-Id`), validated and audited as the Admin's save:

- the three platform caps through `PATCH /api/v1/platform-settings/runs/capacity` (fields `per_tenant`, `global`, `wait_seconds`), as a superadmin, as in the Admin. A field left out keeps its value; `null` clears it back to the baseline.
- one tenant's own cap through `PATCH /api/v1/tenants/{tenant_id}/limits` (field `max_concurrent_agent_runs`), as a platform admin or superadmin. It is published as `tenant_change` on `max_concurrent_agent_runs_per_tenant`; `null` returns the tenant to the platform's cap.

With the dev-kit that is `cavelon limits set max_concurrent_agent_runs_global 150 --confirm`, and `--tenant` for a tenant's own cap. A tenant's token, an operator's token in Tenant mode and an API key are refused. A limit only the environment sets, such as `model_endpoint_slot_wait_seconds`, has no `change` and cannot be changed at runtime.

A model's own limit is a field of the model registry API, `max_concurrent_requests`: a positive integer, accepted only on a model with a `base_url`, `null` for no limit. The dev-kit's `cavelon limits` shows the same values, and `cavelon explain` explains both refusal codes. A package whose node sets a `max_concurrency` above the published width still imports; the node runs at the width.

## Related

- [Plan Capacity for a Self-Hosted Model](/docs/tutorials/plan-model-capacity) — a worked example, from the server's numbers to the platform's settings
- [Model Registry](/docs/administration/model-registry#limiting-concurrent-requests-to-an-endpoint) — setting Max Concurrent Requests
- [Limits and Quotas](/docs/reference/limits-and-quotas#concurrency-limits) — every concurrency limit and its default
- [Operations](/docs/administration/operations#rate-limits) — the Rate limits page
- [Scaling & Capacity](/docs/reference/scaling-and-capacity) — sizing the API and worker fleet
- [Triggers](/docs/concepts/triggers#waiting-for-capacity) — how a triggered run waits for a slot
