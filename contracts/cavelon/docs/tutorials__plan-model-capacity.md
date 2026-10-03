# Plan Capacity for a Self-Hosted Model

> A worked example — from what your model server can serve to the platform's endpoint limit, run caps and per-tenant caps, then load-test, read the signals and tune

Acme runs its own model server: a vLLM instance on one GPU, serving the model every Acme solution uses. The server answers well up to about sixteen requests at once; beyond that, answers slow down until requests time out. Three kinds of work share it:

- the **support chat** on the website, where a visitor waits for every answer;
- a **nightly report** trigger that summarises the day's tickets, one run per ticket, with a For-each step;
- **knowledge-base ingestion**, which asks the model for a short contextual prefix for every chunk of an uploaded document.

In this walkthrough you will give the platform the server's real capacity, share it between the three, run a load test, and learn to read what the platform shows you. For how each limit works, read [Capacity and Concurrency](/docs/concepts/capacity-and-concurrency) first; this page is the do-it version.

> [!NOTE]
> You need a platform operator account for the run caps, and `agents.manage_llm_config` in the tenant for the model. Everything here also applies to a hosted gateway that limits concurrent requests per key.

## 1. Find the number your server can serve

The number to give the platform is how many requests the server answers **at an acceptable speed**, not the most it accepts. A vLLM server started with `--max-num-seqs 64` accepts 64 sequences, but on one GPU each of them may then take several times as long.

Measure it once:

1. Send the server batches of identical requests — 4, 8, 16, 24 at once — with a typical prompt from your own traffic.
2. Note the time to the first token and the total time for each batch size.
3. Pick the largest batch where both are still acceptable for a waiting chat visitor.

For Acme that is **16**. Write it down; it is the only number in this walkthrough that comes from outside the platform.

> [!TIP]
> Leave headroom when the same server also serves something the platform does not see — another application, a batch job outside Cavelon. The platform only counts its own requests.

## 2. Tell the platform: Max Concurrent Requests

1. Open **Settings › Model roles** in the tenant and edit the model that points at the server — the one whose **Base URL** is `http://gpu-1.acme.internal:8000/v1`.
2. Set **Max Concurrent Requests** to `16` and save.
3. Repeat this for **every** model whose Base URL points at the same server, in this tenant and any other — for example a second registry entry for the same model used by the utility role. Models that send the same API key (or none) share one count; each applies its own limit to it, so give them all the same number. A model that sends a different key is counted separately.

From now on the platform never has more than 16 requests in flight to that server. Request number 17 waits in line until one finishes. The line is first come, first served across chat, triggers and ingestion, and across the API and every worker.

A request waits at most `MODEL_ENDPOINT_SLOT_WAIT_SECONDS` (120 seconds by default). After that, it fails like a provider rate limit with the code `model_endpoint_busy`. A chat visitor then gets the persona's fallback message, and a nightly run fails. If 120 seconds is too long for your chat or too short for your batches, the operator changes it in the deployment's environment.

## 3. Share the capacity: run caps

The endpoint limit protects the server, but its line is first come, first served: when the nightly report starts 200 runs, they can fill all 16 slots and the website chat waits behind them. Run caps decide how much each workspace may start at once.

Acme keeps the website chat and the back-office automations in two tenants, **Acme Support** and **Acme Back Office**. As a platform operator:

1. Open **Platform › Operations › Rate limits › Run caps**.
2. Set **Agent runs on the platform** to `24`. That is a little above the server's 16, so the server is never idle while work is waiting. It is not far above it, because every extra run would only wait in the endpoint's line while holding worker time.
3. Leave **Agent runs per tenant** at its default, or set it to `16`.
4. Open the **Acme Back Office** tenant, go to its **Limits** section, and set **Concurrent Agent Runs** to `6`.

Now the nightly report runs at most six at a time. Its other runs wait as **pending** and start as slots free; they do not fail. At least ten of the server's slots stay available for the website chat.

| Tenant | Cap | Why |
|---|---|---|
| Acme Support | 16 (platform per-tenant value) | Visitors wait for these answers |
| Acme Back Office | 6 (its own cap) | Overnight work; finishing a little later costs nothing |
| All together | 24 | Slightly above the server, so it stays busy |

> [!IMPORTANT]
> A run is not a request. A run that reaches a For-each or fanout step makes up to its **Max concurrency** calls at once — 8 by default. Six back-office runs with an eight-wide For-each can occupy all 16 endpoint slots by themselves. Open the nightly report's For-each node in the workbench and set its **Max concurrency** to `2`. Then six runs make at most twelve calls, and the chat keeps four slots even at the batch's peak.

## 4. Keep ingestion in its lane

Ingestion is not a run, so the run caps do not see it. Only the endpoint limit does. By default each document makes one contextual-prefix call at a time (`CONTEXTUAL_PREFIX_MAX_CONCURRENCY` is 1), and at most two scrapes run per tenant (`SCRAPE_TENANT_CONCURRENCY_LIMIT` is 2). A large upload during business hours therefore takes one or two slots at a time, not all of them.

If a prefix call waits too long and fails with `model_endpoint_busy`, ingestion retries that chunk in its next round (`CONTEXTUAL_PREFIX_RETRY_ROUNDS`, 3 by default) instead of indexing it without a prefix. Plan bulk imports outside office hours anyway: they finish faster when they don't share the line with chat.

## 5. Load-test it

Before customers notice, make the platform busy on purpose and watch:

1. Open **Platform › Operations › Rate limits** in one window.
2. Fire the nightly report's webhook 50 times in a row, for example with a short script that POSTs the same payload.
3. While the runs drain, have two or three people chat on the website.

What you should see:

- **Model Endpoints** shows the server at or near `16 / 16 in use`, with a **waiting** count that rises during the burst and falls back to zero.
- **Run Concurrency** stays at or below 24, and the back-office tenant never has more than six runs executing.
- **Run Concurrency** shows the back-office runs waiting for a slot while the batch drains.
- In **Workflow runs**, the back-office runs move from **Waiting for capacity** to **Running** to **Completed** in waves of six. None fails.
- The website chat answers, a little more slowly at the peak.

## 6. Read the signals and tune

| What you see | What it means | What to change |
|---|---|---|
| **Waiting** stays above zero for minutes and chat answers slowly | The server is the bottleneck | Lower the back-office cap or its For-each width, move batches off-peak, or add server capacity |
| Traces or failed runs name `model_endpoint_busy` | Requests waited longer than the slot wait | The same as above, or raise `MODEL_ENDPOINT_SLOT_WAIT_SECONDS` for batch-heavy installations |
| Runs show **Waiting for capacity** while Model Endpoints shows free slots | The run caps are tighter than the server | Raise the tenant's **Concurrent Agent Runs** or the platform cap |
| Chat visitors see "I'm helping several people at once" | The tenant's run cap was full for 30 seconds | Raise the tenant's cap if the server has room, otherwise this is the cap doing its job |
| The server's own latency climbs while in use stays at 16 | 16 is more than it serves well | Lower **Max Concurrent Requests** on every model of that server |
| Failed runs name `run_capacity_busy` | A run was refused a run slot on a path nobody waits on | Check the caps; worker-executed runs wait instead of failing |

Change one number at a time and repeat the load test. Run caps apply within a minute without a restart; a model's limit applies within a minute of saving it.

## Checklist

- [ ] The server's real concurrency is measured, with headroom for anything outside the platform.
- [ ] **Max Concurrent Requests** is set to the same number on every model that points at that server.
- [ ] The platform run cap is slightly above that number.
- [ ] Each tenant that runs background batches has its own **Concurrent Agent Runs**.
- [ ] For-each and fanout steps in batch solutions have a **Max concurrency** that fits.
- [ ] Bulk ingestion is scheduled outside peak hours.
- [ ] A load test shows the waiting count draining and no `model_endpoint_busy` failures.

## Related

- [Capacity and Concurrency](/docs/concepts/capacity-and-concurrency) — how each limit works, and what waits or is refused
- [Model Registry](/docs/administration/model-registry#limiting-concurrent-requests-to-an-endpoint) — the Max Concurrent Requests field
- [Operations](/docs/administration/operations#rate-limits) — the Rate limits page
- [Air-Gapped, Sovereign Deployment](/docs/tutorials/air-gapped-sovereign-deployment) — pointing every model role at local endpoints
