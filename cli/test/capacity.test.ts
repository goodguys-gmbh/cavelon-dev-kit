import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CAPACITY_WAIT_AFTER_MS, capacityCodeIn, capacityWait, MODEL_ENDPOINT_BUSY, RUN_CAPACITY_BUSY } from "../src/capacity.js";
import type { PackageSchema } from "../src/contracts.js";
import { errorFromResponse } from "../src/http.js";
import { parseLimits } from "../src/limits.js";
import { checkPackage } from "../src/package-check.js";
import type { FakeRun, FakeTrigger } from "./fake-long-running.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

/**
 * Run and model endpoint capacity: a run that says it waits for a slot (`waiting_for_capacity`) reads
 * "waiting for run capacity" from the first poll, and on an instance without
 * the field, a run queued past a normal start does; a capacity refusal names
 * the limit to raise and who raises it, and `limits` and `status` show where
 * the run caps are set. An instance without the new fields reads as before.
 */

type LimitEntry = Record<string, unknown> & { key: string };

let server: FakeServer;
let sb: Sandbox;
let tenant: string;

const capsSnapshot = () => JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8")) as { limits: { values: LimitEntry[] } };
const packageSchema = () => JSON.parse(readFileSync(path.join(CONTRACTS, "meta-package-schema-v3.json"), "utf8")) as PackageSchema;

/** The snapshot's `limits`, with some entries changed. */
function limitsWith(edit: (values: LimitEntry[]) => LimitEntry[]): Record<string, unknown> {
  const caps = capsSnapshot();
  return { ...caps.limits, values: edit(caps.limits.values) };
}

/** As an older instance publishes them: no entry has an origin. */
const withoutOrigin = (values: LimitEntry[]) => values.map(({ origin: _origin, ...rest }) => rest as LimitEntry);

/** As a current instance publishes them: the tenant cap set in the Admin, the global one by the environment. */
const withOrigins = (values: LimitEntry[]) =>
  withoutOrigin(values).map((v) => {
    if (v.key === "max_concurrent_agent_runs_per_tenant") return { ...v, value: 40, origin: "platform_setting" };
    if (v.key === "max_concurrent_agent_runs_global") return { ...v, origin: "environment" };
    if (v.key === "agent_run_slot_wait_seconds") return { ...v, origin: "default" };
    return v;
  });

/** A tenant's own run cap: source tenant, its setting, no origin. */
const withTenantCap = (values: LimitEntry[]) =>
  withOrigins(values).map((v) =>
    v.key === "max_concurrent_agent_runs_per_tenant" ? (({ origin: _o, ...rest }) => ({ ...rest, value: 5, source: "tenant", setting: "max_concurrent_agent_runs" }))(v) : v,
  );

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A trigger run; `waiting` is its waiting_for_capacity, `older` an older instance that does not publish it. */
function addRun(status: string, createdAt: string, errorSummary?: string, options: { waiting?: boolean; older?: boolean } = {}): FakeRun {
  const trigger: FakeTrigger = {
    id: randomUUID(),
    tenant_id: tenant,
    slug: "nightly",
    name: "Nightly",
    harness_id: randomUUID(),
    trigger_type: "schedule",
    is_active: true,
    identity: { api_key_id: null, version: 1 },
    required_solutions: [],
  };
  const run: FakeRun = {
    id: randomUUID(),
    tenant_id: tenant,
    trigger,
    status,
    payload: {},
    acting_as: { kind: "key", name: "runner" },
    created_at: createdAt,
    ended_at: status === "failed" ? new Date().toISOString() : null,
    error_summary: errorSummary,
    waiting_for_capacity: options.waiting,
    olderInstance: options.older,
  };
  server.state.lr.runs.push(run);
  return run;
}

/** A trigger run's operation, as the instance maps it: pending and queued read queued. */
function runOperation(run: FakeRun, status: "queued" | "failed") {
  return server.addOperation("trigger_run", tenant, [status], {
    created_at: run.created_at,
    resultRef: { type: "agent_run", id: run.id, href: `/api/v1/triggers/runs/${run.id}` },
    ...(status === "failed" ? { error: { code: "trigger_run_failed", message: "The run failed." } } : {}),
  });
}

/** A run as an older instance shows it: no waiting_for_capacity, so the time queued decides. */
const olderRun = (status: string, createdAt: string) => addRun(status, createdAt, undefined, { older: true });
/** A run the instance holds back for a slot, created a moment ago. */
const heldRun = (status = "pending") => addRun(status, ago(1_000), undefined, { waiting: true });

const BUSY_SUMMARY = "Run capacity busy: every run slot of this tenant or the platform was in use. (run_capacity_busy)";

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterEach(() => {
  server.state.capsPatch = {};
  server.state.features = { personal_access_tokens_enabled: true, operations_api_enabled: true };
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("waiting for run capacity", () => {
  it("reads the run's own waiting_for_capacity: waiting from the first poll, and not waiting however long it is queued", () => {
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const held = capacityWait({ status: "pending", created_at: at(1_000), waiting_for_capacity: true }, now)!;
    expect(held).toMatchObject({ waiting_for: "run_capacity", inferred: false, queued_seconds: 1 });
    expect(held.note).toMatch(/^waiting for run capacity \(queued 1 s\): every run slot is in use.*not stuck/);
    // The instance says it is not held back: no wait, however long it has been queued.
    expect(capacityWait({ status: "queued", created_at: at(600_000), waiting_for_capacity: false }, now)).toBeUndefined();
    // Without a creation time, the wait still reads as one.
    expect(capacityWait({ status: "queued", waiting_for_capacity: true }, now)).toMatchObject({ queued_seconds: null, note: expect.stringMatching(/^waiting for run capacity: /) });
  });

  it("on an instance without the field, infers it after a normal start: 30 s, above the instance's 5–20 s retry", () => {
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(CAPACITY_WAIT_AFTER_MS).toBe(30_000);
    expect(capacityWait({ status: "queued", created_at: at(29_000) }, now)).toBeUndefined();
    expect(capacityWait({ status: "pending", created_at: at(31_000) }, now)?.note).toMatch(/^waiting for run capacity \(queued 31 s\).*not stuck/);
    expect(capacityWait({ status: "queued", created_at: at(120_000) }, now)).toMatchObject({ queued_seconds: 120, inferred: true });
    // A null field is no answer either.
    expect(capacityWait({ status: "queued", created_at: at(120_000), waiting_for_capacity: null }, now)?.inferred).toBe(true);
    // Started, ended, or no time to go by: no wait.
    expect(capacityWait({ status: "running", created_at: at(600_000) }, now)).toBeUndefined();
    expect(capacityWait({ status: "failed", created_at: at(600_000) }, now)).toBeUndefined();
    expect(capacityWait({ status: "queued", created_at: "not a time" }, now)).toBeUndefined();
    expect(capacityWait({ status: "queued", created_at: null }, now)).toBeUndefined();
  });

  it("names the run caps and where each is set, when the instance publishes them", () => {
    const limits = parseLimits({ limits: limitsWith(withOrigins) });
    const queued = { status: "queued", waiting_for_capacity: true, created_at: new Date(Date.now() - 60_000).toISOString() };
    const wait = capacityWait(queued, new Date(), limits)!;
    expect(wait.caps.map((c) => [c.key, c.origin])).toEqual([
      ["max_concurrent_agent_runs_per_tenant", "platform_setting"],
      ["max_concurrent_agent_runs_global", "environment"],
    ]);
    expect(wait.note).toMatch(/max_concurrent_agent_runs_per_tenant is 40, set by a platform setting, changed in the Admin \(Platform › Operations › Rate limits\)/);
    expect(wait.note).toMatch(/max_concurrent_agent_runs_global is \d+, set by the environment variable MAX_CONCURRENT_AGENT_RUNS_GLOBAL/);

    const tenantCap = capacityWait(queued, new Date(), parseLimits({ limits: limitsWith(withTenantCap) }))!;
    expect(tenantCap.note).toMatch(/max_concurrent_agent_runs_per_tenant is 5, this tenant's own cap \(max_concurrent_agent_runs; the instance operator changes it with PATCH \/api\/v1\/tenants\/\{tenant_id\}\/limits\)/);

    // An instance older than the limits: the wait still reads as one, without names.
    const bare = capacityWait(queued, new Date(), parseLimits({}))!;
    expect(bare.caps).toEqual([]);
    expect(bare.note).toMatch(/not stuck\.$/);
  });

  it("wait: a run the instance holds back reads as waiting for capacity on the first poll", async () => {
    server.state.capsPatch = { limits: limitsWith(withOrigins) };
    const op = runOperation(heldRun(), "queued");
    const text = await cli(sb, ["wait", op.id, "--timeout", "0"]);
    expect(text.code).toBe(6);
    expect(text.stdout).toMatch(/trigger_run {2}queued[^\n]*\n {2}waiting for run capacity \(queued \d s\): every run slot is in use/);
    expect(text.stdout).toMatch(/max_concurrent_agent_runs_per_tenant is 40, set by a platform setting/);
    expect(text.stdout).toMatch(new RegExp(`Waiting for run capacity\\. Wait with: cavelon wait ${op.id}`));
    const json = (await cli(sb, ["wait", op.id, "--timeout", "0", "--json"])).json<{ capacity_waits: Array<{ operation_id: string; inferred: boolean }> }>();
    expect(json.capacity_waits).toMatchObject([{ operation_id: op.id, waiting_for: "run_capacity", inferred: false }]);
  });

  it("wait: a run the instance does not hold back is just still running, however long it is queued", async () => {
    const op = runOperation(addRun("pending", ago(300_000), undefined, { waiting: false }), "queued");
    const result = await cli(sb, ["wait", op.id, "--timeout", "0", "--json"]);
    expect(result.code).toBe(6);
    expect(result.json()).not.toHaveProperty("capacity_waits");
  });

  it("wait on an older instance: a run operation queued past a normal start reads as waiting for capacity, and keeps waiting until the timeout (exit 6)", async () => {
    server.state.capsPatch = { limits: limitsWith(withOrigins) };
    const op = runOperation(olderRun("pending", ago(90_000)), "queued");
    const text = await cli(sb, ["wait", op.id, "--timeout", "100ms"]);
    expect(text.code).toBe(6);
    expect(text.stdout).toMatch(/trigger_run {2}queued/);
    expect(text.stdout).toMatch(/waiting for run capacity \(queued 9\d s\).*not stuck/);
    expect(text.stdout).toMatch(/max_concurrent_agent_runs_per_tenant is 40, set by a platform setting/);
    expect(text.stdout).toMatch(new RegExp(`Waiting for run capacity after the timeout; resume with: cavelon wait ${op.id}`));

    const json = await cli(sb, ["wait", op.id, "--timeout", "100ms", "--json"]);
    expect(json.code).toBe(6);
    const data = json.json<{ settled: boolean; capacity_waits: Array<{ operation_id: string; waiting_for: string; caps: Array<{ key: string; origin: string | null }> }> }>();
    expect(data.settled).toBe(false);
    expect(data.capacity_waits).toMatchObject([{ operation_id: op.id, waiting_for: "run_capacity", inferred: true }]);
    expect(data.capacity_waits[0]!.caps[0]).toMatchObject({ key: "max_concurrent_agent_runs_per_tenant", origin: "platform_setting" });
  });

  it("wait on an older instance: a run within a normal start is just still running", async () => {
    const op = runOperation(olderRun("pending", ago(5_000)), "queued");
    const result = await cli(sb, ["wait", op.id, "--timeout", "100ms", "--json"]);
    expect(result.code).toBe(6);
    expect(result.json()).not.toHaveProperty("capacity_waits");
    const text = await cli(sb, ["wait", op.id, "--timeout", "0"]);
    expect(text.stdout).toMatch(/Still running\. Wait with/);
    expect(text.stdout).not.toMatch(/run capacity/);
  });

  it("wait: other queued work (an upload) never reads as waiting for run capacity", async () => {
    const op = server.addOperation("document_ingestion", tenant, ["queued"], { created_at: ago(300_000) });
    const result = await cli(sb, ["wait", op.id, "--timeout", "100ms"]);
    expect(result.code).toBe(6);
    expect(result.stdout).not.toMatch(/run capacity/);
  });

  it("watch: says why a queued run has not started, from its first line and when it stops watching", async () => {
    server.state.serveSse = false;
    try {
      for (const run of [heldRun("queued"), olderRun("queued", ago(60_000))]) {
        const op = runOperation(run, "queued");
        const result = await cli(sb, ["watch", op.id, "--timeout", "150ms"]);
        expect(result.code).toBe(6);
        expect(result.stdout.split("\n").slice(0, 2).join("\n")).toMatch(new RegExp(`^${op.id} {2}trigger_run {2}queued[^\\n]*\\n {2}waiting for run capacity`));
        expect(result.stderr).toMatch(new RegExp(`Stopped watching; ${op.id} is still queued\\. Resume: cavelon watch ${op.id}\\n {2}waiting for run capacity`));
      }
    } finally {
      server.state.serveSse = true;
    }
  });

  it("loop watch: a run held back with no loop yet waits for capacity from the first look", async () => {
    server.state.features = { ...server.state.features, masterloop_enabled: true };
    const run = heldRun();
    const result = await cli(sb, ["loop", "watch", run.id, "--timeout", "0", "--json"]);
    expect(result.code).toBe(6);
    const first = JSON.parse(result.stdout.trim().split("\n")[0]!) as { type: string; run: { capacity_wait: { inferred: boolean } } };
    expect(first).toMatchObject({ type: "run", run: { status: "pending", capacity_wait: { waiting_for: "run_capacity", inferred: false } } });
    expect(result.stderr).toMatch(/the loop is still not started: its run is waiting for run capacity/);
  });

  it("loop watch on an older instance: a run with no loop yet waits for capacity, said once, until the timeout", async () => {
    server.state.features = { ...server.state.features, masterloop_enabled: true };
    const run = olderRun("pending", ago(45_000));
    const result = await cli(sb, ["loop", "watch", run.id, "--timeout", "150ms"]);
    expect(result.code).toBe(6);
    expect(result.stdout.match(/waiting for run capacity/g)).toHaveLength(1);
    expect(result.stderr).toMatch(/the loop is still not started: its run is waiting for run capacity/);

    const json = await cli(sb, ["loop", "watch", run.id, "--timeout", "100ms", "--json"]);
    const first = JSON.parse(json.stdout.trim().split("\n")[0]!) as { type: string; run: { status: string; capacity_wait: { waiting_for: string } } };
    expect(first).toMatchObject({ type: "run", run: { status: "pending", capacity_wait: { waiting_for: "run_capacity" } } });
  });

  it("trace: a queued run has no traces yet, and says it waits for capacity, as it says or on an older instance after 30 s", async () => {
    for (const run of [heldRun("queued"), olderRun("queued", ago(40_000))]) {
      const result = await cli(sb, ["trace", run.id]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`Run ${run.id} is queued and has no traces yet\\.\\n {2}waiting for run capacity`));
    }
    const fresh = olderRun("queued", ago(5_000));
    expect((await cli(sb, ["trace", fresh.id])).stdout).not.toMatch(/run capacity/);
  });

  it("status: a queued run operation reads as waiting for capacity, as its run says or on an older instance after 30 s", async () => {
    const held = runOperation(heldRun(), "queued");
    const older = runOperation(olderRun("pending", ago(120_000)), "queued");
    const notHeld = runOperation(addRun("pending", ago(120_000), undefined, { waiting: false }), "queued");
    const result = await cli(sb, ["status"]);
    expect(result.code).toBe(0);
    const line = (id: string) => result.stdout.split("\n").find((l) => l.includes(id)) ?? "";
    expect(line(held.id)).toMatch(/trigger_run {2}queued.* {2}waiting for run capacity \(queued \d s\)/);
    expect(line(older.id)).toMatch(/trigger_run {2}queued.* {2}waiting for run capacity \(queued 12\d s\)/);
    expect(line(notHeld.id)).toMatch(/trigger_run {2}queued/);
    expect(line(notHeld.id)).not.toMatch(/run capacity/);
    const json = (await cli(sb, ["status", "--json"])).json<{ capacity_waits: Array<{ operation_id: string; waiting_for: string; inferred: boolean }> }>();
    expect(json.capacity_waits).toContainEqual(expect.objectContaining({ operation_id: held.id, waiting_for: "run_capacity", inferred: false }));
    expect(json.capacity_waits).toContainEqual(expect.objectContaining({ operation_id: older.id, waiting_for: "run_capacity", inferred: true }));
    expect(json.capacity_waits.map((w) => w.operation_id)).not.toContain(notHeld.id);
    for (const op of [held, older, notHeld]) server.state.operations.delete(op.id);
  });
});

describe("capacity refusals", () => {
  it("finds the code in a code or a failure summary", () => {
    expect(capacityCodeIn(BUSY_SUMMARY)).toBe(RUN_CAPACITY_BUSY);
    expect(capacityCodeIn(null, "model_endpoint_busy")).toBe(MODEL_ENDPOINT_BUSY);
    expect(capacityCodeIn("trigger_run_failed", "The run failed.")).toBeUndefined();
  });

  it("explain run_capacity_busy: the catalog's meaning and fix, and which cap to raise, who can, and that retrying is fine", async () => {
    server.state.capsPatch = { limits: limitsWith(withOrigins) };
    const result = await cli(sb, ["explain", "run_capacity_busy"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/meaning: +Every run slot of this tenant or the platform was in use/);
    expect(result.stdout).toMatch(/raise: +Retrying later is fine; a trigger or channel run waits for a free slot on its own\./);
    expect(result.stdout).toMatch(/the instance operator raises max_concurrent_agent_runs_per_tenant: for this tenant alone with PATCH \/api\/v1\/tenants\/\{tenant_id\}\/limits \(limits\.manage\)/);
    expect(result.stdout).toMatch(/Now: max_concurrent_agent_runs_per_tenant is 40, set by a platform setting/);
    // The instance's own pages on capacity, the concept first.
    expect(result.stdout).toMatch(/\nread: +cavelon docs get concepts\/capacity-and-concurrency; cavelon docs get tutorials\/plan-model-capacity\n/);
    const json = (await cli(sb, ["explain", "run_capacity_busy", "--json"])).json<{ kind: string; area: string; kit_hint: string; read: Array<{ page: string; command: string }> }>();
    expect(json).toMatchObject({ kind: "api", area: "capacity" });
    expect(json.kit_hint).toMatch(/max_concurrent_agent_runs_global caps the whole instance/);
    expect(json.read).toEqual([
      { page: "concepts/capacity-and-concurrency", command: "cavelon docs get concepts/capacity-and-concurrency" },
      { page: "tutorials/plan-model-capacity", command: "cavelon docs get tutorials/plan-model-capacity" },
    ]);
  });

  it("explain model_endpoint_busy: raise the registry row's max_concurrent_requests, or retry later", async () => {
    const result = await cli(sb, ["explain", "model_endpoint_busy"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/meaning: +The model endpoint was at its limit of concurrent requests/);
    expect(result.stdout).toMatch(/raise: +Retrying later is fine\./);
    expect(result.stdout).toMatch(/a tenant admin raises max_concurrent_requests on its Model Registry row \(cavelon models set-limit <model_id> <n>, the Admin's model form/);
    expect(result.stdout).toMatch(/every row with the same base_url shares that count/);
    expect(result.stdout).toMatch(/model_endpoint_slot_wait_seconds is \d+ s; the instance operator changes it with MODEL_ENDPOINT_SLOT_WAIT_SECONDS/);
    // Planning an endpoint's limit is the tutorial's subject, so it comes first.
    expect(result.stdout).toMatch(/\nread: +cavelon docs get tutorials\/plan-model-capacity; cavelon docs get concepts\/capacity-and-concurrency\n/);
  });

  it("the pages explain links are the instance's own, read with docs get", async () => {
    const concept = await cli(sb, ["docs", "get", "concepts/capacity-and-concurrency"]);
    expect(concept.code, concept.stderr).toBe(0);
    expect(concept.stdout).toMatch(/^# Capacity and Concurrency/m);
    const tutorial = await cli(sb, ["docs", "get", "tutorials/plan-model-capacity"]);
    expect(tutorial.code, tutorial.stderr).toBe(0);
    expect(tutorial.stdout).toMatch(/^# Plan Capacity for a Self-Hosted Model/m);
  });

  it("explain links no page an instance does not publish", async () => {
    // A fresh login, so no docs index from an earlier read is cached.
    const older = sandbox();
    server.state.serveDocs = false;
    try {
      await login(older, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
      const json = (await cli(older, ["explain", "model_endpoint_busy", "--json"])).json<Record<string, unknown>>();
      expect(json.kit_hint).toMatch(/max_concurrent_requests/);
      expect(json).not.toHaveProperty("read");
    } finally {
      server.state.serveDocs = true;
      older.cleanup();
    }
  });

  it("explain on an instance without limits still adds the hint, without today's values", async () => {
    server.state.capsPatch = { limits: undefined };
    const json = (await cli(sb, ["explain", "run_capacity_busy", "--json"])).json<{ kit_hint: string }>();
    expect(json.kit_hint).toMatch(/raises max_concurrent_agent_runs_per_tenant/);
    expect(json.kit_hint).not.toMatch(/Now:/);
  });

  it("wait: a run that failed for capacity names the cap to raise (exit 1)", async () => {
    const op = runOperation(addRun("failed", ago(5_000), BUSY_SUMMARY), "failed");
    const result = await cli(sb, ["wait", op.id]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/error trigger_run_failed: The run failed\.\n {2}run_capacity_busy: Retrying later is fine/);
    const json = (await cli(sb, ["wait", op.id, "--json"])).json<{ capacity_refusals: Array<{ operation_id: string; code: string; hint: string }> }>();
    expect(json.capacity_refusals).toMatchObject([{ operation_id: op.id, code: "run_capacity_busy" }]);
  });

  it("wait: a run that failed for another reason gets no capacity hint", async () => {
    const op = runOperation(addRun("failed", ago(5_000)), "failed");
    const result = await cli(sb, ["wait", op.id, "--json"]);
    expect(result.code).toBe(1);
    expect(result.json()).not.toHaveProperty("capacity_refusals");
  });

  it("loop cancel shows a run's capacity refusal", async () => {
    server.state.features = { ...server.state.features, masterloop_enabled: true };
    const run = addRun("failed", ago(5_000), BUSY_SUMMARY);
    const result = await cli(sb, ["loop", "cancel", run.id]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/is already failed; nothing to stop\.\n {2}run_capacity_busy: Retrying later is fine/);
  });

  it("a 429 with model_endpoint_busy keeps the instance's retry and adds which limit to raise", () => {
    const error = errorFromResponse(
      429,
      { detail: { code: "model_endpoint_busy", message: "The model endpoint was at its limit." } },
      "POST /api/v1/x",
      new Headers({ "retry-after": "10" }),
    );
    expect(error.code).toBe("model_endpoint_busy");
    expect(error.exitCode).toBe(8);
    expect(error.hint).toMatch(/^Retry after 10 seconds\. Retrying later is fine\./);
    expect(error.hint).toMatch(/raises max_concurrent_requests on its Model Registry row/);
    expect(error.hint).toMatch(/`cavelon explain model_endpoint_busy` says more\.$/);

    const busy = errorFromResponse(503, { detail: BUSY_SUMMARY }, "POST /api/v1/triggers/x/run");
    expect(busy.hint).toMatch(/raises max_concurrent_agent_runs_per_tenant/);
    expect(errorFromResponse(429, { detail: "Too many requests" }, "GET /api/v1/x").hint).toBe("Retry later.");
  });
});

describe("limits and status show where the run caps are set", () => {
  it("limits: the origin of each run cap, and where an operator changes it", async () => {
    server.state.capsPatch = { limits: limitsWith(withOrigins) };
    const result = await cli(sb, ["limits", "--source", "platform"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/KEY\s+VALUE\s+CHANGED_BY\s+ORIGIN\s+SETTING\s+DOCS/);
    expect(result.stdout).toMatch(/max_concurrent_agent_runs_per_tenant\s+40\s+the instance operator\s+platform_setting\s+MAX_CONCURRENT_AGENT_RUNS_PER_TENANT/);
    expect(result.stdout).toMatch(/max_concurrent_agent_runs_global\s+\d+\s+the instance operator\s+environment\s+MAX_CONCURRENT_AGENT_RUNS_GLOBAL/);
    expect(result.stdout).toMatch(/Where the run caps are set:\n {2}max_concurrent_agent_runs_per_tenant is 40, set by a platform setting/);
    expect(result.stdout).toMatch(/agent_run_slot_wait_seconds is \d+ s, set by the built-in default/);
    const json = (await cli(sb, ["limits", "--key", "max_concurrent_agent_runs_per_tenant", "--json"])).json<{ groups: Array<{ limits: LimitEntry[] }> }>();
    expect(json.groups[0]!.limits[0]).toMatchObject({ key: "max_concurrent_agent_runs_per_tenant", source: "platform", origin: "platform_setting" });
  });

  it("limits: a tenant's own run cap shows as the tenant's, set with the tenant limits route", async () => {
    server.state.capsPatch = { limits: limitsWith(withTenantCap) };
    const result = await cli(sb, ["limits", "--source", "tenant"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Set by this tenant[^\n]*\n[^\n]*\nmax_concurrent_agent_runs_per_tenant\s+5\s+the instance operator\s+max_concurrent_agent_runs/);
    expect(result.stdout).toMatch(/this tenant's own cap \(max_concurrent_agent_runs; the instance operator changes it with PATCH \/api\/v1\/tenants\/\{tenant_id\}\/limits\)/);
  });

  it("limits: entries without origin show as before", async () => {
    server.state.capsPatch = { limits: limitsWith(withoutOrigin) };
    const result = await cli(sb, ["limits"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/ORIGIN/);
    expect(result.stdout).not.toMatch(/Where the run caps are set/);
    expect(result.stdout).toMatch(/KEY\s+VALUE\s+CHANGED_BY\s+SETTING\s+DOCS/);
    expect(result.stdout).toMatch(/max_concurrent_agent_runs_per_tenant\s+\d+\s+the instance operator\s+MAX_CONCURRENT_AGENT_RUNS_PER_TENANT/);
    const json = (await cli(sb, ["limits", "--key", "max_concurrent_agent_runs_per_tenant", "--json"])).json<{ groups: Array<{ limits: LimitEntry[] }> }>();
    expect(json.groups[0]!.limits[0]).not.toHaveProperty("origin");
  });

  it("status: the run caps with source and origin, and the slot waits", async () => {
    server.state.capsPatch = { limits: limitsWith(withOrigins) };
    const result = await cli(sb, ["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /run capacity: +max_concurrent_agent_runs_per_tenant 40 \(platform, platform setting\); max_concurrent_agent_runs_global \d+ \(platform, environment\); agent_run_slot_wait_seconds \d+ s \(platform, default\); model_endpoint_slot_wait_seconds \d+ s \(platform\)/,
    );
    const json = (await cli(sb, ["status", "--json"])).json<{ limits: { capacity: LimitEntry[] } }>();
    expect(json.limits.capacity.map((c) => c.key)).toEqual([
      "max_concurrent_agent_runs_per_tenant",
      "max_concurrent_agent_runs_global",
      "agent_run_slot_wait_seconds",
      "model_endpoint_slot_wait_seconds",
    ]);
    expect(json.limits.capacity[0]).toMatchObject({ origin: "platform_setting" });
  });

  it("status on an older instance: run caps without origin show their source; without limits, no capacity line", async () => {
    server.state.capsPatch = {
      limits: limitsWith((values) => withoutOrigin(values).filter((v) => v.key !== "model_endpoint_slot_wait_seconds")),
    };
    const older = await cli(sb, ["status"]);
    expect(older.stdout).toMatch(/run capacity: +max_concurrent_agent_runs_per_tenant \d+ \(platform\); max_concurrent_agent_runs_global \d+ \(platform\); agent_run_slot_wait_seconds \d+ s \(platform\)\n/);

    server.state.capsPatch = { limits: undefined };
    const oldest = await cli(sb, ["status", "--json"]);
    expect(oldest.code).toBe(0);
    expect(oldest.json<{ limits: Record<string, unknown> }>().limits).toEqual({ published: false });
    expect((await cli(sb, ["status"])).stdout).not.toMatch(/^run capacity:/m);
  });
});

describe("Model Registry rows in a package", () => {
  const disk = (rows: Array<Record<string, unknown>>) => ({ package: { model_registry: rows }, sources: {}, findings: [], empty: false });
  /** The findings about endpoint limits; the bare package misses sections the schema requires. */
  const check = (rows: Array<Record<string, unknown>>, schema: PackageSchema) =>
    checkPackage(disk(rows), { schema }).filter((f) => f.code.startsWith("model_endpoint_limit"));
  const row = (extra: Record<string, unknown>) => ({ model_id: "llama-70b", display_name: "Llama 70B", provider: "openai", ...extra });

  /** The snapshot's schema, which carries max_concurrent_requests on Model Registry rows. */
  function schemaWithEndpointLimit(): PackageSchema {
    const schema = packageSchema();
    const defs = schema.$defs as Record<string, { properties: Record<string, unknown> }>;
    expect(defs.PackageModelRegistryEntry!.properties.max_concurrent_requests).toBeDefined();
    return schema;
  }

  /** The schema of an older instance: Model Registry rows without the field. */
  function schemaWithoutEndpointLimit(): PackageSchema {
    const schema = packageSchema();
    delete (schema.$defs as Record<string, { properties: Record<string, unknown> }>).PackageModelRegistryEntry!.properties.max_concurrent_requests;
    return schema;
  }

  it("the snapshot carries the field as the instance publishes it: a positive integer, or null to clear it", () => {
    const field = (schemaWithEndpointLimit().$defs as Record<string, { properties: Record<string, unknown> }>).PackageModelRegistryEntry!.properties
      .max_concurrent_requests as { anyOf: Array<Record<string, unknown>>; default: unknown };
    expect(field.anyOf).toEqual(expect.arrayContaining([expect.objectContaining({ type: "integer", minimum: 1 }), { type: "null" }]));
    expect(field.default).toBeNull();
  });

  it("validate refuses max_concurrent_requests without a base_url, offline", () => {
    const findings = check([row({ max_concurrent_requests: 4 }), row({ model_id: "vllm", base_url: "http://vllm:8000/v1", max_concurrent_requests: 4 })], schemaWithEndpointLimit());
    expect(findings).toMatchObject([
      { code: "model_endpoint_limit_without_base_url", severity: "error", path: "model_registry[0].max_concurrent_requests" },
    ]);
    expect(findings[0]!.message).toMatch(/Model "llama-70b" sets max_concurrent_requests without a base_url/);
    expect(findings[0]!.hint).toMatch(/add the row's base_url/);
  });

  it("an empty limit (null clears the target's), or none (keeps the target's), needs no base_url", () => {
    expect(check([row({ max_concurrent_requests: null }), row({})], schemaWithEndpointLimit())).toEqual([]);
  });

  it("where the package schema does not carry the field, warns that the import ignores it", () => {
    const schema = schemaWithoutEndpointLimit();
    const findings = check([row({ base_url: "http://vllm:8000/v1", max_concurrent_requests: 4 }), row({ max_concurrent_requests: 4 })], schema);
    expect(findings).toMatchObject([
      { code: "model_endpoint_limit_not_in_package_schema", severity: "warning" },
      { code: "model_endpoint_limit_not_in_package_schema", severity: "warning" },
    ]);
    expect(findings[0]!.hint).toMatch(/PATCH \/api\/v1\/model-registry\/\{model_registry_id\}/);
  });
});
