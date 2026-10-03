import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildArchive } from "../src/tar.js";
import { readTar, type FakeSandbox, type FakeTrigger, type LoopPlan } from "./fake-long-running.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type CliResult, type Sandbox } from "./helpers.js";

/**
 * The plan's loops (05, "What the kit adds") end to end against the fake
 * instance: the sandbox-free counter loop, the orders loop on an isolated
 * container, and a customer VM, which refuses what its mode does not offer.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let token: string;
const harness: Record<string, string> = {};

function addHarness(slug: string): string {
  const id = randomUUID();
  server.state.harnesses.push({ id, tenant_id: tenant, slug, name: slug, status: "draft" });
  harness[slug] = id;
  return id;
}

function addSandbox(name: string, mode: FakeSandbox["execution_mode"], allowed: string[], files: Record<string, string> = {}): FakeSandbox {
  const s: FakeSandbox = {
    id: randomUUID(),
    tenant_id: tenant,
    name,
    execution_mode: mode,
    lifecycle_state: "ready",
    config_version: 3,
    revision: 0,
    allowed_harness_ids: allowed,
    machine_api_key_ids: [],
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
    writer_owner_run_id: null,
    healthy: true,
    readiness: { passed: true, checks: [] },
    activity: [],
    refreshKeys: new Map(),
  };
  server.state.lr.sandboxes.push(s);
  return s;
}

function addTrigger(slug: string, harnessId: string, loop?: LoopPlan): FakeTrigger {
  const t: FakeTrigger = {
    id: randomUUID(),
    tenant_id: tenant,
    slug,
    name: slug,
    harness_id: harnessId,
    trigger_type: "webhook",
    is_active: true,
    identity: { api_key_id: null, version: 1 },
    required_solutions: [{ id: harnessId, name: slug }],
    loop,
  };
  server.state.lr.triggers.push(t);
  return t;
}

const requestsTo = (method: string, fragment: string) => server.state.requests.filter((r) => r.method === method && r.path.includes(fragment));
const jsonLines = (result: CliResult) =>
  result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  server.state.features = {
    ...server.state.features,
    sandbox_feature_enabled: true,
    sandbox_outbound_enrollment_enabled: true,
    sandbox_isolated_container_enabled: true,
    masterloop_enabled: true,
  };
  server.state.capsPatch = { sandbox: { execution_modes: ["customer_vm", "isolated_container"] } };
  sb = sandbox();
  token = server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, email: "ada@example.com" });
  await login(sb, server.url, token);
  server.state.lr.apiKeys.push({ id: randomUUID(), tenant_id: tenant, name: "loop-runner", key_prefix: "cbp_ab12", is_active: true });
  server.state.suites.push(
    { id: randomUUID(), tenant_id: tenant, name: "counter-loop", harness_id: null, archived_at: null },
    { id: randomUUID(), tenant_id: tenant, name: "orders-loop", harness_id: null, archived_at: null },
  );
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("the counter loop (no Sandbox)", () => {
  let trigger: FakeTrigger;
  let runId: string;
  let operationId: string;

  beforeAll(() => {
    trigger = addTrigger("counter", addHarness("counter-parent"), { iterations: 3 });
  });

  it("binds the trigger's execution identity only with --confirm", async () => {
    const shown = await cli(sb, ["trigger", "identity", "counter", "--json"]);
    expect(shown.code).toBe(0);
    expect(shown.json()).toMatchObject({ api_key_id: null, version: 1, required_solutions: ["counter"] });

    const preview = await cli(sb, ["trigger", "identity", "counter", "loop-runner", "--json"]);
    expect(preview.code).toBe(0);
    expect(preview.json()).toMatchObject({ changed: false, would: 'bind API key "loop-runner"', confirm: "cavelon trigger identity counter loop-runner --confirm" });
    expect(requestsTo("PUT", "/execution-identity")).toHaveLength(0);

    const bound = await cli(sb, ["trigger", "identity", "counter", "loop-runner", "--confirm", "--json"]);
    expect(bound.code).toBe(0);
    expect(bound.json()).toMatchObject({ changed: true, key: "loop-runner", version: 2 });
    expect(requestsTo("PUT", "/execution-identity")[0]!.body).toMatchObject({ expected_version: 1 });

    // The same binding again changes nothing; clearing it needs --confirm too.
    expect((await cli(sb, ["trigger", "identity", "counter", "loop-runner", "--confirm", "--json"])).json()).toMatchObject({ changed: false });
    expect((await cli(sb, ["trigger", "identity", "counter", "--clear", "--json"])).json()).toMatchObject({ changed: false, would: "clear the binding" });
  });

  it("never takes a key or token value, and does not echo it", async () => {
    const secret = `cbp_${"9".repeat(40)}`;
    const result = await cli(sb, ["trigger", "identity", "counter", secret, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.json<{ error: { message: string } }>().error.message).toMatch(/never goes into an argument/);
  });

  it("starts the loop through its trigger, as the caller", async () => {
    const started = await cli(sb, ["loop", "start", "counter", "--input", '{"start": 0}', "--json"]);
    expect(started.code).toBe(0);
    const data = started.json<{ run_id: string; operation_id: string; acting_as: string }>();
    expect(data.acting_as).toBe("ada@example.com");
    expect(data.operation_id).toBe(`op_trigger_run_${data.run_id.replace(/-/g, "")}`);
    expect(requestsTo("POST", `/api/v1/triggers/${trigger.id}/run`)[0]!.body).toEqual({ payload: { start: 0 } });
    runId = data.run_id;
    operationId = data.operation_id;
  });

  it("watches the iterations as a stream until the loop completes", async () => {
    const watched = await cli(sb, ["loop", "watch", runId, "--json", "--timeout", "30s"]);
    expect(watched.code, watched.stdout + watched.stderr).toBe(0);
    const lines = jsonLines(watched);
    const iterations = lines.filter((l) => l.type === "iteration");
    expect(iterations.map((l) => l.iteration)).toEqual([1, 2, 3]);
    expect(iterations.map((l) => l.outcome)).toEqual(["continue", "continue", "done"]);
    expect(iterations.map((l) => l.verdict)).toEqual(["accepted", "accepted", "accepted"]);
    expect(lines.at(-2)).toMatchObject({ type: "loop", loop: { state: "completed", iteration: 3 } });
    expect(lines.at(-1)).toMatchObject({ type: "outcome", state: "completed", iterations: 3, last_outcome: "done" });
  });

  it("lists the iterations and waits on the run's operation", async () => {
    const page = await cli(sb, ["loop", "iterations", runId, "--json"]);
    expect(page.code).toBe(0);
    expect(page.json()).toMatchObject({ loop: { state: "completed", iteration: 3, max_iterations: 12 }, iterations: { next_cursor: null } });
    const text = await cli(sb, ["loop", "iterations", runId]);
    expect(text.stdout).toMatch(/ITERATION\s+CHILD_STATUS/);
    expect((await cli(sb, ["wait", operationId, "--json"])).code).toBe(0);
  });

  it("runs the loop test suite", async () => {
    const result = await cli(sb, ["test", "run", "--suite", "counter-loop", "--wait", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ failed_cases: 0 });
  });

  it("cancels only with --confirm, and an ended run has nothing to cancel", async () => {
    const run = (await cli(sb, ["loop", "start", "counter", "--json"])).json<{ run_id: string }>().run_id;
    const preview = await cli(sb, ["loop", "cancel", run, "--json"]);
    expect(preview.json()).toMatchObject({ cancelled: false, confirm: `cavelon loop cancel ${run} --confirm` });
    expect(requestsTo("POST", `/runs/${run}/cancel`)).toHaveLength(0);
    const cancelled = await cli(sb, ["loop", "cancel", run, "--confirm", "--json"]);
    expect(cancelled.json()).toMatchObject({ cancelled: true, run: { status: "cancelled" } });
    expect((await cli(sb, ["loop", "cancel", run, "--confirm", "--json"])).json()).toMatchObject({ cancelled: false });
    expect((await cli(sb, ["loop", "watch", run, "--json"])).code).toBe(1);
  });
});

describe("loop start's Idempotency-Key", () => {
  let trigger: FakeTrigger;
  const runsOf = () => server.state.lr.runs.filter((r) => r.trigger.id === trigger.id);

  beforeAll(() => {
    trigger = addTrigger("keyed", addHarness("keyed-parent"));
  });

  it("always sends one, and says which in --json", async () => {
    const started = await cli(sb, ["loop", "start", "keyed", "--json"]);
    expect(started.code, started.stdout).toBe(0);
    const key = started.json<{ idempotency_key: string }>().idempotency_key;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestsTo("POST", `/api/v1/triggers/${trigger.id}/run`).pop()!.headers["idempotency-key"]).toBe(key);
  });

  it("two starts with the same key create one run", async () => {
    const key = randomUUID();
    const before = runsOf().length;
    const first = await cli(sb, ["loop", "start", "keyed", "--idempotency-key", key, "--json"]);
    const second = await cli(sb, ["loop", "start", "keyed", "--idempotency-key", key, "--json"]);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.json<{ run_id: string }>().run_id).toBe(first.json<{ run_id: string }>().run_id);
    expect(runsOf().length).toBe(before + 1);
  });

  it("a start that timed out names its key, and the retry with it starts no second run", async () => {
    const before = runsOf().length;
    server.state.interruptions = [{ method: "POST", path: new RegExp(`/api/v1/triggers/${trigger.id}/run$`), mode: "stall" }];
    let timedOut: CliResult;
    try {
      timedOut = await cli(sb, ["loop", "start", "keyed", "--json"], { env: { CAVELON_HTTP_TIMEOUT_MS: "500" } });
    } finally {
      server.state.interruptions = [];
    }
    expect(timedOut.code, timedOut.stdout).toBe(8);
    const error = timedOut.json<{ error: { code: string; hint: string; details: { idempotency_key: string } } }>().error;
    expect(error.code).toBe("request_timeout");
    const key = error.details.idempotency_key;
    expect(error.hint).toContain(`--idempotency-key ${key}`);
    // The instance got the start.
    expect(runsOf().length).toBe(before + 1);

    const retried = await cli(sb, ["loop", "start", "keyed", "--idempotency-key", key, "--json"]);
    expect(retried.code, retried.stdout).toBe(0);
    expect(runsOf().length).toBe(before + 1);
  });
});

describe("the orders loop (isolated container)", () => {
  let orders: FakeSandbox;
  let runId: string;
  const seeds = () => path.join(sb.home, "seeds", "orders");
  const longName = `${"nested-folder/".repeat(4)}${"a".repeat(50)}.csv`;

  beforeAll(() => {
    const iteration = addHarness("orders-iteration");
    const parent = addHarness("orders-parent");
    orders = addSandbox("orders-test", "isolated_container", [iteration, parent], { "old.txt": "stale" });
    addTrigger("orders", parent, { iterations: 3, sandboxId: orders.id, output: { "output/orders-summary.json": '{"orders": 2, "total": 30}' } });
    mkdirSync(path.join(seeds(), "input"), { recursive: true });
    writeFileSync(path.join(seeds(), "input", "orders.csv"), "id,amount\n1,10\n2,20\n");
    writeFileSync(path.join(seeds(), "Bestellübersicht.md"), "# Bestellungen\n");
    mkdirSync(path.dirname(path.join(seeds(), longName)), { recursive: true });
    writeFileSync(path.join(seeds(), longName), "long\n");
    mkdirSync(path.join(seeds(), "empty"));
  });

  it("lists the Sandboxes with their mode and what it offers", async () => {
    const result = await cli(sb, ["sandbox", "list", "--json"]);
    expect(result.code).toBe(0);
    const item = result.json<{ items: Array<Record<string, unknown>>; instance_modes: string[] }>();
    expect(item.instance_modes).toEqual(["customer_vm", "isolated_container"]);
    expect(item.items.find((i) => i.name === "orders-test")).toMatchObject({ mode: "isolated_container", state: "ready", offers: expect.arrayContaining(["seed", "artifacts export"]) });
  });

  it("validates the Sandbox, and exits 3 when a check fails", async () => {
    expect((await cli(sb, ["sandbox", "validate", "orders-test", "--json"])).json()).toMatchObject({ ready: true });
    expect(requestsTo("POST", "/validate").pop()!.headers["if-match"]).toBe('"3"');
    orders.healthy = false;
    const failed = await cli(sb, ["sandbox", "validate", "orders-test"]);
    expect(failed.code).toBe(3);
    expect(failed.stdout).toMatch(/workspace_quota\s+quota_unavailable/);
    orders.healthy = true;
    expect((await cli(sb, ["sandbox", "validate", "orders-test"])).code).toBe(0);
  });

  it("seeds a folder: a preview first, then the archive with --confirm", async () => {
    const preview = await cli(sb, ["sandbox", "seed", "orders-test", "seeds/orders", "--harness", "orders-iteration", "--json"]);
    expect(preview.code).toBe(0);
    const planned = preview.json<{ seeded: boolean; revision: string; archive: { files: number; sha256: string } }>();
    expect(planned).toMatchObject({ seeded: false, revision: "revision-0", archive: { files: 3 } });
    expect(requestsTo("POST", "/artifact-jobs")).toHaveLength(0);

    const seeded = await cli(sb, ["sandbox", "seed", "orders-test", "seeds/orders", "--harness", "orders-iteration", "--confirm", "--wait", "--json"]);
    expect(seeded.code, seeded.stdout).toBe(0);
    expect(seeded.json()).toMatchObject({ seeded: true, archive: { sha256: planned.archive.sha256 }, operations: [{ status: "succeeded" }] });
    const put = requestsTo("PUT", "/content")[0]!;
    expect(put.headers["content-type"]).toBe("application/octet-stream");
    // The archive became the workspace: every name intact, the old file gone.
    expect([...orders.files.keys()].sort()).toEqual(["Bestellübersicht.md", "input/orders.csv", longName].sort());
    expect(orders.files.get("input/orders.csv")!.toString()).toBe("id,amount\n1,10\n2,20\n");
    expect(orders.revision).toBe(1);

    // The same seed again is the same job, not a second import.
    const again = await cli(sb, ["sandbox", "seed", "orders-test", "seeds/orders", "--harness", "orders-iteration", "--revision", "revision-0", "--confirm", "--json"]);
    expect(again.json<{ job_id: string }>().job_id).toBe(seeded.json<{ job_id: string }>().job_id);
  });

  it("reads the workspace: files and file content", async () => {
    const files = await cli(sb, ["sandbox", "files", "orders-test", "input", "--harness", "orders-iteration", "--json"]);
    expect(files.json()).toMatchObject({ workspace_revision: "revision-1", entries: [{ path: "input/orders.csv", kind: "file" }] });
    const cat = await cli(sb, ["sandbox", "cat", "orders-test", "input/orders.csv", "--harness", "orders-iteration"]);
    expect(cat.code).toBe(0);
    expect(cat.stdout).toBe("id,amount\n1,10\n2,20\n");
    const page = await cli(sb, ["sandbox", "cat", "orders-test", "input/orders.csv", "--harness", "orders-iteration", "--length", "5"]);
    expect(page.stdout).toBe("id,am\n");
    expect(page.stderr).toMatch(/--offset 5/);
  });

  it("refuses a solution the Sandbox does not allow (exit 7), and asks which one when several are", async () => {
    addHarness("stranger");
    const refused = await cli(sb, ["sandbox", "files", "orders-test", "--harness", "stranger", "--json"]);
    expect(refused.code).toBe(7);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("sandbox_harness_not_allowed");
    expect((await cli(sb, ["sandbox", "files", "orders-test"])).code).toBe(2);
  });

  it("runs the loop: start, pause (wait exits 5), resume, watch to the end", async () => {
    const started = await cli(sb, ["loop", "start", "orders", "--input", '{"orders": "input/orders.csv"}', "--json"]);
    runId = started.json<{ run_id: string }>().run_id;
    const opId = started.json<{ operation_id: string }>().operation_id;
    const paused = await cli(sb, ["loop", "pause", runId, "--json"]);
    expect(paused.code).toBe(0);
    expect(paused.json()).toMatchObject({ action: "pause", pause_requested: true });
    expect(requestsTo("POST", "/pause")[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    const waited = await cli(sb, ["wait", opId]);
    expect(waited.code).toBe(5);
    expect(waited.stdout).toMatch(/needs a person: The loop is paused/);
    // A paused loop cannot be paused again; it can be resumed.
    expect((await cli(sb, ["loop", "pause", runId, "--json"])).code).toBe(4);
    // A person's pause takes no review, and a review names the pause reason, never free text.
    const freeText = await cli(sb, ["loop", "resume", runId, "--reason", "checked the first iterations", "--json"]);
    expect(freeText.code).toBe(2);
    expect(freeText.json<{ error: { message: string } }>().error.message).toMatch(/paused for user_paused, not "checked the first iterations"/);
    expect(requestsTo("POST", "/resume")).toHaveLength(0);
    const resumed = await cli(sb, ["loop", "resume", runId, "--json"]);
    expect(resumed.json()).toMatchObject({ action: "resume", state: "running", reviewed_reason: null });

    const watched = await cli(sb, ["loop", "watch", runId, "--json"]);
    expect(watched.code).toBe(0);
    expect(jsonLines(watched).filter((l) => l.type === "iteration").map((l) => l.iteration)).toEqual([1, 2, 3]);
  });

  it("inspects what the loop did: activity, logs, receipt and its output", async () => {
    const activity = await cli(sb, ["sandbox", "activity", "orders-test", "--harness", "orders-parent", "--json"]);
    const items = activity.json<{ items: Array<{ activity_id: string; action: string }> }>().items;
    expect(items).toHaveLength(3);
    const one = items[0]!.activity_id;
    expect((await cli(sb, ["sandbox", "activity", "orders-test", one, "--harness", "orders-parent"])).stdout).toMatch(/Receipt: cavelon sandbox receipt orders-test/);
    const logs = await cli(sb, ["sandbox", "logs", "orders-test", one, "--harness", "orders-parent"]);
    expect(logs.stdout).toBe("iteration 1: ok\n");
    const receipt = await cli(sb, ["sandbox", "receipt", "orders-test", one, "--harness", "orders-parent", "--json"]);
    expect(receipt.json()).toMatchObject({ receipt: { policy: "runner_validation", passed: true } });
    const cat = await cli(sb, ["sandbox", "cat", "orders-test", "output/orders-summary.json", "--harness", "orders-parent"]);
    expect(JSON.parse(cat.stdout)).toEqual({ orders: 2, total: 30 });
  });

  it("exports the results as a tar archive, never over an existing file", async () => {
    const exported = await cli(sb, ["artifacts", "export", "orders-test", "--path", "output", "--harness", "orders-parent", "--out", "results.tar", "--wait", "--json"]);
    expect(exported.code, exported.stdout).toBe(0);
    const data = exported.json<{ file: string; sha256: string; job_id: string }>();
    expect(data.file).toBe("results.tar");
    const tar = readTar(readFileSync(path.join(sb.home, "results.tar")));
    expect([...tar.keys()]).toEqual(["output/orders-summary.json"]);

    const again = await cli(sb, ["artifacts", "export", "orders-test", "--job", data.job_id, "--out", "results.tar", "--json"]);
    expect(again.code).toBe(4);
    expect(again.json<{ error: { code: string } }>().error.code).toBe("file_exists");
    // Without --out the name comes from the job id.
    const fresh = await cli(sb, ["artifacts", "export", "orders-test", "--job", data.job_id, "--json"]);
    expect(fresh.json<{ file: string }>().file).toBe(`sandbox-${data.job_id}.tar`);
  });

  it("starts an export without waiting, and downloads it later by job", async () => {
    const started = await cli(sb, ["artifacts", "export", "orders-test", "--harness", "orders-parent", "--json"]);
    expect(started.code).toBe(0);
    const { job_id: job, operation_id: op } = started.json<{ job_id: string; operation_id: string; download: string }>();
    expect((await cli(sb, ["wait", op, "--json"])).code).toBe(0);
    const later = await cli(sb, ["artifacts", "export", "orders-test", "--job", job, "--out", "all.tar", "--json"]);
    expect(later.code).toBe(0);
    expect([...readTar(readFileSync(path.join(sb.home, "all.tar"))).keys()]).toContain("input/orders.csv");
  });

  it("runs the loop test suite", async () => {
    expect((await cli(sb, ["test", "run", "--suite", "orders-loop", "--wait"])).code).toBe(0);
  });

  it("refuses a refresh on an isolated container, naming its mode", async () => {
    const result = await cli(sb, ["sandbox", "refresh", "orders-test", "--json"]);
    expect(result.code).toBe(3);
    const error = result.json<{ error: { code: string; message: string; hint: string } }>().error;
    expect(error.code).toBe("sandbox_workspace_refresh_unavailable");
    expect(error.message).toMatch(/isolated_container mode/);
    expect(error.hint).toMatch(/cavelon sandbox seed orders-test/);
    expect(requestsTo("POST", "/refresh-workspace")).toHaveLength(0);
  });
});

describe("a customer VM", () => {
  let vm: FakeSandbox;

  beforeAll(() => {
    vm = addSandbox("spec-vm", "customer_vm", [addHarness("spec-agent")], { "README.md": "# repo\n" });
    mkdirSync(path.join(sb.home, "seeds", "spec"), { recursive: true });
    writeFileSync(path.join(sb.home, "seeds", "spec", "spec.md"), "spec\n");
  });

  it.each([
    [["sandbox", "seed", "spec-vm", "seeds/spec", "--confirm"], "sandbox_capability_unavailable", /cavelon sandbox refresh spec-vm/],
    [["artifacts", "export", "spec-vm", "--wait"], "sandbox_capability_unavailable", /cavelon sandbox cat spec-vm/],
    [["sandbox", "receipt", "spec-vm", randomUUID()], "sandbox_validation_receipt_unavailable", /cavelon sandbox files spec-vm/],
  ])("refuses %j before sending anything, naming the mode", async (args, code, hint) => {
    const before = server.state.requests.length;
    const result = await cli(sb, [...args, "--json"]);
    expect(result.code).toBe(3);
    const error = result.json<{ error: { code: string; message: string; hint: string } }>().error;
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/runs in customer_vm mode/);
    expect(error.hint).toMatch(hint);
    const sent = server.state.requests.slice(before);
    expect(sent.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("refreshes the workspace after files were put on the VM", async () => {
    vm.files.set("spec.md", Buffer.from("spec\n"));
    const result = await cli(sb, ["sandbox", "refresh", "spec-vm", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ previous_revision: "revision-0", revision: "revision-1" });
    const sent = requestsTo("POST", "/refresh-workspace")[0]!;
    expect(sent.headers["if-match"]).toBe('"3"');
    expect(sent.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    // Its results come out with cat, its single allowed solution chosen without --harness.
    expect((await cli(sb, ["sandbox", "cat", "spec-vm", "spec.md"])).stdout).toBe("spec\n");
  });
});

describe("an instance that does not serve its OpenAPI", () => {
  const plain = sandbox();
  let vm: FakeSandbox;
  let containers: FakeSandbox;

  beforeAll(async () => {
    server.state.serveOpenapi = false;
    await login(plain, server.url, token);
    vm = addSandbox("plain-vm", "customer_vm", [addHarness("plain-vm-agent")]);
    containers = addSandbox("plain-box", "isolated_container", [addHarness("plain-box-agent")], { "out/a.txt": "a\n" });
    addTrigger("plain-loop", addHarness("plain-loop-parent"), { iterations: 50, sandboxId: containers.id });
    mkdirSync(path.join(plain.home, "seed"), { recursive: true });
    writeFileSync(path.join(plain.home, "seed", "in.txt"), "in\n");
  });
  afterAll(() => {
    server.state.serveOpenapi = true;
    plain.cleanup();
  });

  const lastTo = (method: string, fragment: string) => requestsTo(method, fragment).pop()!;

  it("validates and refreshes a Sandbox with If-Match and the key as headers", async () => {
    const validated = await cli(plain, ["sandbox", "validate", "plain-vm", "--json"]);
    expect(validated.code, validated.stdout).toBe(0);
    expect(validated.stderr).toMatch(/Arguments are not checked before sending/);
    expect(lastTo("POST", `/sandboxes/${vm.id}/validate`).headers["if-match"]).toBe(`"${vm.config_version - 2}"`);

    const refreshed = await cli(plain, ["sandbox", "refresh", "plain-vm", "--json"]);
    expect(refreshed.code, refreshed.stdout).toBe(0);
    const sent = lastTo("POST", `/sandboxes/${vm.id}/refresh-workspace`);
    expect(sent.headers["if-match"]).toMatch(/^"\d+"$/);
    expect(sent.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("seeds a Sandbox and exports its artifacts with the key as a header", async () => {
    const seeded = await cli(plain, ["sandbox", "seed", "plain-box", "seed", "--confirm", "--wait", "--json"]);
    expect(seeded.code, seeded.stdout).toBe(0);
    expect(lastTo("POST", `/sandboxes/${containers.id}/artifact-jobs`).headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    const exported = await cli(plain, ["artifacts", "export", "plain-box", "--wait", "--out", "plain.tar", "--json"]);
    expect(exported.code, exported.stdout).toBe(0);
    expect(lastTo("POST", `/sandboxes/${containers.id}/artifact-jobs`).headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("pauses and resumes a loop with the key as a header", async () => {
    const started = await cli(plain, ["loop", "start", "plain-loop", "--json"]);
    expect(started.code, started.stdout).toBe(0);
    const runId = started.json<{ run_id: string }>().run_id;
    const paused = await cli(plain, ["loop", "pause", runId, "--json"]);
    expect(paused.code, paused.stdout).toBe(0);
    expect(lastTo("POST", "/pause").headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await cli(plain, ["wait", started.json<{ operation_id: string }>().operation_id]);
    const resumed = await cli(plain, ["loop", "resume", runId, "--json"]);
    expect(resumed.code, resumed.stdout).toBe(0);
    expect(lastTo("POST", "/resume").headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await cli(plain, ["loop", "cancel", runId, "--confirm"]);
  });
});

describe("refusals", () => {
  it("refuses Sandbox and loop commands the instance has switched off", async () => {
    const off = sandbox();
    try {
      const other = server.addTenant("other");
      await login(off, server.url, server.addToken({ kind: "pat", tenantIds: [other], defaultTenant: other }));
      const saved = server.state.features;
      server.state.features = { ...saved, sandbox_feature_enabled: false, masterloop_enabled: false };
      try {
        const env = { CAVELON_CONTRACT_TTL_SECONDS: "0" };
        const list = await cli(off, ["sandbox", "list", "--json"], { env });
        expect(list.code).toBe(1);
        expect(list.json<{ error: { code: string } }>().error.code).toBe("sandbox_feature_disabled");
        const start = await cli(off, ["loop", "start", "counter", "--json"], { env });
        expect(start.json<{ error: { code: string } }>().error.code).toBe("masterloop_feature_disabled");
      } finally {
        server.state.features = saved;
      }
    } finally {
      off.cleanup();
    }
  });

  it("refuses links, compressed archives and empty folders as seeds", async () => {
    const dir = path.join(sb.home, "seeds", "linked");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "a.txt"), "a");
    let linked = true;
    try {
      symlinkSync(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    } catch {
      linked = false; // Windows without the privilege to make links
    }
    if (linked) {
      const result = await cli(sb, ["sandbox", "seed", "orders-test", "seeds/linked", "--harness", "orders-iteration", "--json"]);
      expect(result.code).toBe(2);
      expect(result.json<{ error: { message: string } }>().error.message).toMatch(/links or special files.*b\.txt/);
    }
    writeFileSync(path.join(sb.home, "seed.tar.gz"), "x");
    expect((await cli(sb, ["sandbox", "seed", "orders-test", "seed.tar.gz"])).code).toBe(2);
    writeFileSync(path.join(sb.home, "fake.tar"), "not a tar");
    expect((await cli(sb, ["sandbox", "seed", "orders-test", "fake.tar"])).stderr).toMatch(/not an uncompressed \(USTAR\) tar/);
    mkdirSync(path.join(sb.home, "seeds", "none"), { recursive: true });
    expect((await cli(sb, ["sandbox", "seed", "orders-test", "seeds/none"])).stderr).toMatch(/holds no files/);
  });

  it("sends a .tar as it is, and any other file under its own name", async () => {
    const bundle = path.join(sb.home, "repository.bundle");
    writeFileSync(bundle, "git bundle bytes");
    const file = await cli(sb, ["sandbox", "seed", "orders-test", "repository.bundle", "--harness", "orders-iteration", "--json"]);
    expect(file.json()).toMatchObject({ archive: { from: "file", files: 1 } });
    const tar = buildArchive([{ name: "x.txt", directory: false, content: Buffer.from("x") }]);
    writeFileSync(path.join(sb.home, "ready.tar"), tar.bytes);
    const asIs = await cli(sb, ["sandbox", "seed", "orders-test", "ready.tar", "--harness", "orders-iteration", "--json"]);
    expect(asIs.json()).toMatchObject({ archive: { from: "tar", sha256: tar.sha256 } });
    expect(existsSync(path.join(sb.home, "ready.tar"))).toBe(true);
  });
});

describe("the archive", () => {
  it("is USTAR the runner reads: long and non-ASCII names, folders, deterministic bytes", () => {
    const name = `${"d/".repeat(70)}file.txt`;
    const entries = [
      { name: "b.txt", directory: false, content: Buffer.from("b") },
      { name: "a", directory: true },
      { name: "a/ü.txt", directory: false, content: Buffer.alloc(1500, 1) },
      { name, directory: false, content: Buffer.from("") },
    ];
    const first = buildArchive(entries);
    expect(buildArchive([...entries].reverse()).sha256).toBe(first.sha256);
    const read = readTar(Buffer.from(first.bytes));
    expect([...read.keys()]).toEqual(["a", "a/ü.txt", "b.txt", name].sort());
    expect(read.get("a")).toBeNull();
    expect(read.get("a/ü.txt")!).toHaveLength(1500);
    expect(first.bytes.length % 512).toBe(0);
  });
});
