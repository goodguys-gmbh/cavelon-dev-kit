import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { detectShell, shellWord } from "../src/shell.js";
import type { FakeSandbox, FakeTrigger, LoopPlan } from "./fake-long-running.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type CliResult, type Sandbox } from "./helpers.js";

/**
 * The CLI tells the developer what actually happened: a test run whose cases failed is a failure, an iteration is shown with its real
 * verdict and usage, a run that ends without a loop says why, and printed
 * commands can be copied as they are.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;

function addHarness(slug: string): string {
  const id = randomUUID();
  server.state.harnesses.push({ id, tenant_id: tenant, slug, name: slug, status: "draft" });
  return id;
}

function addTrigger(slug: string, extra: { loop?: LoopPlan; stageError?: FakeTrigger["stageError"] }): FakeTrigger {
  const harnessId = addHarness(`${slug}-parent`);
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
    ...extra,
  };
  server.state.lr.triggers.push(t);
  return t;
}

function addSandbox(name: string, mode: FakeSandbox["execution_mode"]): FakeSandbox {
  const s: FakeSandbox = {
    id: randomUUID(),
    tenant_id: tenant,
    name,
    execution_mode: mode,
    lifecycle_state: "ready",
    config_version: 1,
    revision: 0,
    allowed_harness_ids: [addHarness(`${name.replaceAll(/\W/g, "-")}-agent`)],
    machine_api_key_ids: [],
    files: new Map(),
    writer_owner_run_id: null,
    healthy: true,
    readiness: { passed: true, checks: [] },
    activity: [],
    refreshKeys: new Map(),
  };
  server.state.lr.sandboxes.push(s);
  return s;
}

const jsonLines = (result: CliResult) =>
  result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);

async function startRun(trigger: string): Promise<string> {
  const started = await cli(sb, ["loop", "start", "--confirm", trigger, "--json"]);
  expect(started.code, started.stdout).toBe(0);
  return started.json<{ run_id: string }>().run_id;
}

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
  server.state.suites.push({ id: randomUUID(), tenant_id: tenant, name: "Counter loop", harness_id: null, archived_at: null });
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("a test run whose cases failed", () => {
  const caseRun = "7e57ca5e-0000-4000-8000-000000000001";

  beforeAll(() => {
    // The live check's trigger case: the loop was cancelled, so the run's only case failed.
    server.state.runSummary = { total_cases: 1, passed: 0, failed: 1, errors: 0 };
    server.state.runResults = [
      {
        name: "Counter loop",
        status: "fail",
        llm_judge_score: 0,
        error_message: "Assertion failed: The run ended cancelled; expected completed.; output/report.json does not exist in Sandbox.",
        llm_judge_reasoning: "The trigger run did not complete.",
        judge_breakdown: { evaluation_kind: "deterministic", trigger_run_id: caseRun },
        agent_run_id: caseRun,
      },
    ];
  });
  afterAll(() => {
    server.state.runSummary = { passed: 2, failed: 0, pass_rate: 1 };
    server.state.runResults = null;
  });

  async function startTestRun(): Promise<{ run_id: string; operation_id: string }> {
    const started = await cli(sb, ["test", "run", "--suite", "Counter loop", "--json"]);
    expect(started.code, started.stdout).toBe(0);
    return started.json<{ runs: Array<{ run_id: string; operation_id: string }> }>().runs[0]!;
  }

  it("wait: a finished test run with a failed case exits 1 and names the case and why", async () => {
    const { run_id, operation_id } = await startTestRun();
    const result = await cli(sb, ["wait", operation_id, "--json"]);
    expect(result.code).toBe(1);
    const data = result.json<{ operations: Array<{ status: string }>; failed_results: Array<Record<string, any>> }>();
    // The operation itself succeeded: the run finished. Its result did not pass.
    expect(data.operations[0]!.status).toBe("succeeded");
    expect(data.failed_results).toEqual([
      expect.objectContaining({
        operation_id,
        type: "test_run",
        id: run_id,
        failed_cases: 1,
        cases: [expect.objectContaining({ case: "Counter loop", status: "fail", run_id: caseRun, reason: expect.stringContaining("The run ended cancelled") })],
        trace: `cavelon trace ${run_id}`,
      }),
    ]);

    const text = await cli(sb, ["wait", operation_id]);
    expect(text.code).toBe(1);
    expect(text.stdout).toMatch(/cases did not pass: 1 failed/);
    expect(text.stdout).toMatch(/Counter loop \(step 1\) {2}fail: Assertion failed: The run ended cancelled; expected completed\./);
    expect(text.stdout).toContain(`Look closer: cavelon trace ${run_id}`);
  });

  it("watch: the stream ends with the failed cases, exit 1", async () => {
    const { operation_id } = await startTestRun();
    const result = await cli(sb, ["watch", operation_id, "--json"]);
    expect(result.code).toBe(1);
    expect(jsonLines(result).at(-1)).toMatchObject({ type: "result", result_failure: { failed_cases: 1, cases: [{ case: "Counter loop" }] } });
  });

  it("trace: a failed trigger case shows what the instance recorded and the run it started", async () => {
    const { run_id } = await startTestRun();
    const result = await cli(sb, ["trace", run_id]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Did not pass:\n {2}Counter loop \(step 1\) {2}fail\n {4}Assertion failed: The run ended cancelled; expected completed\.; output\/report\.json does not exist/);
    expect(result.stdout).toContain("Judge: The trigger run did not complete.");
    expect(result.stdout).toContain(`Its traces (by its trigger run id): cavelon trace ${caseRun} --kind trigger`);
    expect(result.stdout).not.toMatch(/no trace to open/);
    const json = await cli(sb, ["trace", run_id, "--json"]);
    expect(json.json<{ results: { items: Array<Record<string, unknown>> } }>().results.items[0]).toMatchObject({
      run_id: caseRun,
      reason: expect.stringContaining("output/report.json does not exist"),
      judge_reasoning: "The trigger run did not complete.",
      judge_breakdown: { evaluation_kind: "deterministic" },
    });
  });
});

describe("loop watch shows what happened to each iteration", () => {
  it("prints an iteration once it is accepted, with its outcome and actual usage, then the loop's outcome", async () => {
    // Each iteration is accepted at the controller's next tick, and reserves far more than it uses.
    addTrigger("lagging", {
      loop: {
        iterations: 2,
        acceptLater: true,
        reserve: { model_requests: 77, input_tokens: 1_000_000, output_tokens: 86_224 },
        use: { model_requests: 1, input_tokens: 3000, output_tokens: 385 },
      },
    });
    const runId = await startRun("lagging");
    const watched = await cli(sb, ["loop", "watch", runId, "--json", "--timeout", "30s"]);
    expect(watched.code, watched.stdout).toBe(0);
    const lines = jsonLines(watched);
    const iterations = lines.filter((l) => l.type === "iteration");
    expect(iterations.map((l) => [l.iteration, l.verdict, l.outcome])).toEqual([
      [1, "accepted", "continue"],
      [2, "accepted", "done"],
    ]);
    expect(iterations[0]!.usage).toEqual({ model_requests: 1, input_tokens: 3000, output_tokens: 385 });
    expect(iterations[0]!.reserved_usage.model_requests).toBe(77);
    expect(lines.at(-1)).toMatchObject({ type: "outcome", state: "completed", iterations: 2, last_outcome: "done" });

    const listed = await cli(sb, ["loop", "iterations", runId]);
    expect(listed.stdout).toMatch(/ITERATION\s+CHILD_STATUS\s+VERDICT\s+OUTCOME/);
    expect(listed.stdout).toMatch(/2\s+completed\s+accepted\s+done/);
  });

  it("a text watch never shows the reservation as usage", async () => {
    addTrigger("lagging-text", {
      loop: { iterations: 1, acceptLater: true, reserve: { model_requests: 77, input_tokens: 1_000_000, output_tokens: 86_224 }, use: { model_requests: 1, input_tokens: 3000, output_tokens: 385 } },
    });
    const watched = await cli(sb, ["loop", "watch", await startRun("lagging-text"), "--timeout", "30s"]);
    expect(watched.code).toBe(0);
    expect(watched.stdout).toMatch(/^iteration 1 {2}accepted {2}→ done {2}25 ms {2}requests 1 {2}tokens 3385$/m);
    expect(watched.stdout).not.toMatch(/not accepted|requests 77/);
    expect(watched.stdout).toMatch(/Loop \S+ completed after 1 iteration \(last outcome: done\)\.\nCharged: /);
  });

  it("a paused loop ends the watch at once (exit 5), with the iteration's failure and how to resume", async () => {
    addTrigger("blocking", { loop: { iterations: 3, blockAt: 1, publishResume: false, reserve: { model_requests: 77, input_tokens: 1_000_000, output_tokens: 86_224 } } });
    const runId = await startRun("blocking");
    const started = Date.now();
    const watched = await cli(sb, ["loop", "watch", runId, "--json", "--timeout", "9m"]);
    expect(watched.code).toBe(5);
    expect(Date.now() - started).toBeLessThan(5000);
    const lines = jsonLines(watched);
    const [iteration] = lines.filter((l) => l.type === "iteration");
    expect(iteration).toMatchObject({ iteration: 1, verdict: "failed", child_status: "failed", accepted: false, reason: "task_blocked", usage: null });
    const outcome = lines.at(-1)!;
    expect(outcome).toMatchObject({ type: "outcome", state: "paused", reason: "task_blocked", blocked_reason: "child_result_unavailable" });
    // This instance does not publish whether the pause needs a review; its catalog explains the reason.
    const catalog = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-error-catalog.json"), "utf8")) as { api_error_codes: Array<{ code: string; message: string; hint: string }> };
    const blocked = catalog.api_error_codes.find((e) => e.code === "task_blocked")!;
    expect(outcome.go_on).toEqual({
      resume: null,
      decided_by: "loop_state",
      reason_text: `${blocked.message} ${blocked.hint}`,
      why_not: null,
      commands: [`cavelon loop resume ${runId} --loop ${outcome.loop_id}`],
      if_review_required: `cavelon loop resume ${runId} --loop ${outcome.loop_id} --reason task_blocked`,
    });

    const text = await cli(sb, ["loop", "watch", runId, "--timeout", "9m"]);
    expect(text.code).toBe(5);
    expect(text.stdout).toMatch(/iteration 1 {2}failed \(child failed\) .* usage not reported yet; reserved requests 77, tokens 1086224 {2}\(task_blocked\)/);
    expect(text.stdout).toMatch(/is paused after 1 iteration \(task_blocked: child_result_unavailable\)\.[\s\S]*It waits for a person/);
    expect(text.stderr).not.toMatch(/Stopped watching/);
  });
});

describe("a run that ends without a loop, and an iteration's child run", () => {
  const authority = "OrchestrationNodeExecutionError: loop_run_authority_missing: This run may not start a Masterloop. Both solutions must be active.";

  beforeAll(() => {
    addTrigger("no-authority", { stageError: { key: "node:count", index: 2, type: "OrchestrationNodeExecutionError", message: authority } });
  });

  it("loop watch names the stage that errored", async () => {
    const runId = await startRun("no-authority");
    const result = await cli(sb, ["loop", "watch", runId, "--json"]);
    expect(result.code).toBe(1);
    const error = result.json<{ error: { code: string; message: string; hint: string; details: { stage_errors: unknown[] } } }>().error;
    expect(error.code).toBe("loop_not_found");
    expect(error.message).toBe(`Run ${runId} ended (completed) without a loop. Stage 2 (node:count) completed_with_error: ${authority}`);
    expect(error.details.stage_errors).toEqual([{ stage: "node:count", index: 2, status: "completed_with_error", message: authority }]);
    expect(error.hint).toBe(`\`cavelon trace ${runId}\` shows its traces.`);
  });

  it("loop start --wait says why, and exits 1 although the run completed", async () => {
    const result = await cli(sb, ["loop", "start", "--confirm", "no-authority", "--wait"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/succeeded/);
    expect(result.stdout).toContain(`The run ended (completed) without a loop. Stage 2 (node:count) completed_with_error: ${authority}`);
  });

  it("trace finds an iteration's child run without --kind", async () => {
    addTrigger("child-fails", { loop: { iterations: 2, blockAt: 1 } });
    const runId = await startRun("child-fails");
    await cli(sb, ["loop", "watch", runId, "--json"]);
    const listed = await cli(sb, ["loop", "iterations", runId, "--json"]);
    const child = listed.json<{ iterations: { items: Array<{ child_run_id: string }> } }>().iterations.items[0]!.child_run_id;
    // The instance records no trace for a failed iteration child: its list is empty.
    server.state.traces.set(`trigger:${child}`, []);
    const result = await cli(sb, ["trace", child]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^Run ${child} is failed and has no traces\\.`));
    expect(result.stdout).toContain("ContextBudgetError: context_budget_current_turn_exceeded");
  });
});

describe("printed commands are quoted for the shell", () => {
  afterEach(() => {
    delete sb.env.CAVELON_SHELL;
  });

  it("quotes a word for POSIX shells, PowerShell and cmd", () => {
    expect(shellWord("orders-test", "posix")).toBe("orders-test");
    expect(shellWord("Lab VM 4073", "posix")).toBe("'Lab VM 4073'");
    expect(shellWord("it's $HOME", "posix")).toBe(String.raw`'it'\''s $HOME'`);
    expect(shellWord("Lab VM 4073", "powershell")).toBe("'Lab VM 4073'");
    expect(shellWord("it's $HOME `x`", "powershell")).toBe("'it''s $HOME `x`'");
    expect(shellWord("a,b", "powershell")).toBe("'a,b'");
    expect(shellWord("@list", "powershell")).toBe("'@list'");
    expect(shellWord(String.raw`C:\seeds\demo`, "powershell")).toBe(String.raw`C:\seeds\demo`);
    expect(shellWord("Lab VM 4073", "cmd")).toBe('"Lab VM 4073"');
    expect(shellWord('say "hi" & %PATH%', "cmd")).toBe('"say ""hi"" & %PATH%"');
    expect(shellWord("", "posix")).toBe("''");
  });

  it("knows the shell from the environment", () => {
    expect(detectShell({}, "linux")).toBe("posix");
    expect(detectShell({ CAVELON_SHELL: "cmd" }, "linux")).toBe("cmd");
    expect(detectShell({ MSYSTEM: "MINGW64" }, "win32")).toBe("posix");
    expect(detectShell({ PSModulePath: String.raw`C:\Users\a\Documents\PowerShell\Modules;C:\Program Files\PowerShell\Modules;C:\Windows\system32\WindowsPowerShell\v1.0\Modules` }, "win32")).toBe("powershell");
    expect(detectShell({ PSModulePath: String.raw`C:\Program Files\WindowsPowerShell\Modules;C:\Windows\system32\WindowsPowerShell\v1.0\Modules` }, "win32")).toBe("cmd");
  });

  it("a Sandbox name with spaces stays one argument in the hints and the confirm command", async () => {
    addSandbox("Lab VM 4073", "customer_vm");
    const orders = addSandbox("Orders lab 4073", "isolated_container");
    mkdirSync(path.join(sb.home, "seeds", "demo"), { recursive: true });
    writeFileSync(path.join(sb.home, "seeds", "demo", "orders.csv"), "id\n1\n");

    sb.env.CAVELON_SHELL = "posix";
    const refused = await cli(sb, ["sandbox", "seed", "Lab VM 4073", "seeds/demo", "--json"]);
    expect(refused.code).toBe(3);
    const hint = refused.json<{ error: { hint: string } }>().error.hint;
    expect(hint).toContain("`cavelon sandbox refresh 'Lab VM 4073'`");
    expect(hint).toContain("`cavelon sandbox cat 'Lab VM 4073' <path>`");

    const preview = await cli(sb, ["sandbox", "seed", "Orders lab 4073", "seeds/demo", "--json"]);
    expect(preview.code, preview.stdout).toBe(0);
    expect(preview.json<{ confirm: string }>().confirm).toBe("cavelon sandbox seed 'Orders lab 4073' seeds/demo --confirm");

    sb.env.CAVELON_SHELL = "cmd";
    const cmd = await cli(sb, ["sandbox", "seed", "Orders lab 4073", "seeds/demo", "--harness", orders.allowed_harness_ids[0]!, "--json"]);
    expect(cmd.json<{ confirm: string }>().confirm).toBe(`cavelon sandbox seed "Orders lab 4073" seeds/demo --harness ${orders.allowed_harness_ids[0]} --confirm`);

    sb.env.CAVELON_SHELL = "powershell";
    const ps = await cli(sb, ["sandbox", "seed", "Orders lab 4073", "seeds/demo"]);
    expect(ps.stdout).toContain("Seed it with: cavelon sandbox seed 'Orders lab 4073' seeds/demo --confirm");
  });
});
