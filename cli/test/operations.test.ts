import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CASE_STATUSES, NOT_PASSED_COUNTS, WAITING_COUNTS } from "../src/results.js";
import { CONTRACTS, startFakeServer, traceFixture, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});
beforeEach(() => {
  server.state.defaultSteps = ["queued", "running", "succeeded"];
  server.state.serveOperations = true;
  server.state.serveSse = true;
});

type WaitOutput = { operations: Array<{ id: string; status: string }>; settled: boolean; timed_out: boolean; resume?: string };

describe("wait", () => {
  it("returns when the operation succeeds (exit 0)", async () => {
    const op = server.addOperation("document_ingestion", tenant, ["queued", "running", "succeeded"]);
    const result = await cli(sb, ["wait", op.id, "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<WaitOutput>()).toMatchObject({ settled: true, timed_out: false, operations: [{ id: op.id, status: "succeeded" }] });
  });

  it("stops at the timeout with the current state, and the next wait resumes (exit 6, then 0)", async () => {
    const op = server.addOperation("test_run", tenant, ["running", "running", "running", "running", "running", "running", "running", "running", "succeeded"]);
    const first = await cli(sb, ["wait", op.id, "--timeout", "100ms", "--json"]);
    expect(first.code).toBe(6);
    const state = first.json<WaitOutput>();
    expect(state).toMatchObject({ settled: false, timed_out: true, timeout_ms: 100, resume: `cavelon wait ${op.id}` });
    expect((state as WaitOutput & { waited_ms: number }).waited_ms).toBeGreaterThanOrEqual(100);
    expect(state.operations[0]!.status).toBe("running");

    const text = await cli(sb, ["wait", op.id, "--timeout", "0"]);
    expect(text.code).toBe(6);
    expect(text.stdout).toMatch(new RegExp(`Wait with: cavelon wait ${op.id}`));
    // A timeout of 0 reads the state once; it never claims to have waited.
    const once = await cli(sb, ["wait", op.id, "--timeout", "0", "--json"]);
    expect(once.json<WaitOutput & { timeout_ms: number }>()).toMatchObject({ settled: false, timed_out: false, timeout_ms: 0 });

    const second = await cli(sb, ["wait", op.id, "--timeout", "30s", "--json"]);
    expect(second.code).toBe(0);
    expect(second.json<WaitOutput>().operations[0]!.status).toBe("succeeded");
  });

  it("returns on needs_action with the reason and the Admin link (exit 5)", async () => {
    const op = server.addOperation("test_run", tenant, ["running", "needs_action"], {
      action: { reason: "2 answers wait for a manual verdict.", admin_url: "https://admin.example/test-suites/runs/1" },
    });
    const result = await cli(sb, ["wait", op.id]);
    expect(result.code).toBe(5);
    expect(result.stdout).toMatch(/needs a person: 2 answers wait for a manual verdict/);
    expect(result.stdout).toMatch(/https:\/\/admin\.example\/test-suites\/runs\/1/);
  });

  it("reports a failure with the server's code (exit 1)", async () => {
    const op = server.addOperation("document_ingestion", tenant, ["failed"], { error: { code: "document_ingestion_failed", message: "Unreadable PDF" } });
    const result = await cli(sb, ["wait", op.id, "--json"]);
    expect(result.code).toBe(1);
    expect(result.json<{ operations: Array<{ error: { code: string } }> }>().operations[0]!.error.code).toBe("document_ingestion_failed");
  });

  it("waits for several at once and exits with the most urgent code", async () => {
    const ok = server.addOperation("document_ingestion", tenant, ["succeeded"]);
    const stuck = server.addOperation("document_ingestion", tenant, ["needs_action"]);
    expect((await cli(sb, ["wait", ok.id, stuck.id])).code).toBe(5);
  });

  it("explains unknown ids and a missing operations API", async () => {
    expect((await cli(sb, ["wait", "not-an-op"])).code).toBe(2);
    const unknown = await cli(sb, ["wait", "op_test_run_00000000000000000000000000000000", "--json"]);
    expect(unknown.code).toBe(1);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("operation_not_found");
    server.state.serveOperations = false;
    const off = await cli(sb, ["wait", "op_test_run_00000000000000000000000000000000", "--json"]);
    expect(off.json<{ error: { code: string } }>().error.code).toBe("operations_unavailable");
  });

  it("rejects a malformed timeout (exit 2)", async () => {
    expect((await cli(sb, ["wait", "op_x", "--timeout", "soon"])).code).toBe(2);
  });
});

describe("watch", () => {
  it("streams changes until the operation ends", async () => {
    const op = server.addOperation("scrape", tenant, ["queued", "running", "succeeded"]);
    const result = await cli(sb, ["watch", op.id, "--json"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n").map((l) => JSON.parse(l) as { operation: { status: string } });
    expect(lines.map((l) => l.operation.status)).toEqual(["queued", "running", "succeeded"]);
  });

  it("reconnects when the connection drops mid-stream", async () => {
    server.state.dropStreams = 2;
    const op = server.addOperation("scrape", tenant, ["queued", "running", "running", "succeeded"]);
    const result = await cli(sb, ["watch", op.id, "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const statuses = result.stdout.trim().split("\n").map((l) => (JSON.parse(l) as { operation: { status: string } }).operation.status);
    expect(statuses.at(-1)).toBe("succeeded");
    expect(server.state.dropStreams).toBe(0);
  });

  it("falls back to polling when the instance has no event stream", async () => {
    server.state.serveSse = false;
    const op = server.addOperation("scrape", tenant, ["running", "failed"]);
    const result = await cli(sb, ["watch", op.id]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/running[\s\S]*failed/);
  });
});

describe("kb upload", () => {
  it("uploads a folder in batches and returns one operation id per document", async () => {
    const kbId = "4c1b9a3e-0000-4000-8000-00000000c0de";
    server.state.kbs.push({ id: kbId, tenant_id: tenant, name: "FAQ" });
    const dir = path.join(sb.home, "docs");
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    for (let i = 0; i < 23; i++) writeFileSync(path.join(dir, `doc-${i}.md`), `# Doc ${i}\n`);
    writeFileSync(path.join(dir, ".hidden.md"), "secret");
    writeFileSync(path.join(dir, "sub", "nested.pdf"), "%PDF");

    const dry = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--dry-run", "--json"]);
    expect(dry.json<{ count: number }>().count).toBe(23);

    server.state.requests.length = 0;
    const result = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "-r", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const data = result.json<{ documents: unknown[]; operation_ids: string[] }>();
    expect(data.documents).toHaveLength(24);
    expect(data.operation_ids).toHaveLength(24);
    expect(data.operation_ids.every((id) => id.startsWith("op_document_ingestion_"))).toBe(true);
    const uploads = server.state.requests.filter((r) => r.path.endsWith("/documents/upload"));
    expect(uploads).toHaveLength(2);

    const waited = await cli(sb, ["wait", ...data.operation_ids.slice(0, 3), "--json"]);
    expect(waited.code).toBe(0);
  });

  it("waits when asked, and filters by extension", async () => {
    const dir = path.join(sb.home, "mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "a.pdf"), "%PDF");
    writeFileSync(path.join(dir, "b.txt"), "text");
    const result = await cli(sb, ["kb", "upload", dir, "--kb", "4c1b9a3e-0000-4000-8000-00000000c0de", "--ext", "pdf", "--wait", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<{ documents: unknown[]; settled: boolean }>()).toMatchObject({ settled: true });
    expect(result.json<{ documents: unknown[] }>().documents).toHaveLength(1);
  });

  it("reports what was uploaded when a later batch fails", async () => {
    const dir = path.join(sb.home, "many");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 25; i++) writeFileSync(path.join(dir, `f-${String(i).padStart(2, "0")}.md`), "x");
    server.state.uploadsBeforeFailure = 1;
    try {
      const result = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--json"]);
      expect(result.code).toBe(8);
      const data = result.json<{ operation_ids: string[]; not_uploaded: string[]; error: { code: string } }>();
      expect(data.operation_ids).toHaveLength(20);
      expect(data.not_uploaded).toHaveLength(5);
      expect(data.error.code).toBe("server_error");
    } finally {
      server.state.uploadsBeforeFailure = Infinity;
    }
  });

  it("reports what was uploaded when the answer to a later batch breaks off", async () => {
    const dir = path.join(sb.home, "many-cut");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 25; i++) writeFileSync(path.join(dir, `f-${String(i).padStart(2, "0")}.md`), "x");
    server.state.interruptions = [{ method: "POST", path: /\/documents\/upload$/, mode: "cut", skip: 1 }];
    try {
      const result = await cli(sb, ["kb", "upload", dir, "--kb", "FAQ", "--json"]);
      expect(result.code, result.stdout).toBe(8);
      const data = result.json<{ operation_ids: string[]; not_uploaded: string[]; error: { code: string } }>();
      expect(data.operation_ids).toHaveLength(20);
      expect(data.not_uploaded).toHaveLength(5);
      expect(data.error.code).toBe("network_error");
    } finally {
      server.state.interruptions = [];
    }
  });

  it("needs --kb and an existing knowledge base", async () => {
    expect((await cli(sb, ["kb", "upload", sb.home])).code).toBe(2);
    const missing = await cli(sb, ["kb", "upload", path.join(sb.home, "docs"), "--kb", "Nope", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("kb_not_found");
  });
});

describe("test run", () => {
  it("starts every suite of a harness and returns operation ids", async () => {
    const created = await cli(sb, ["harness", "new", "support", "--json"]);
    const harnessId = created.json<{ id: string }>().id;
    server.state.suites.push(
      { id: "5a17e000-0000-4000-8000-000000000001", tenant_id: tenant, name: "smoke", harness_id: harnessId, archived_at: null },
      { id: "5a17e000-0000-4000-8000-000000000002", tenant_id: tenant, name: "regression", harness_id: harnessId, archived_at: null },
      { id: "5a17e000-0000-4000-8000-000000000003", tenant_id: tenant, name: "old", harness_id: harnessId, archived_at: "2026-01-01T00:00:00Z" },
    );
    const result = await cli(sb, ["test", "run", "--harness", "support", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const data = result.json<{ runs: Array<{ suite: string; operation_id: string }>; operation_ids: string[] }>();
    expect(data.runs.map((r) => r.suite)).toEqual(["smoke", "regression"]);
    expect(data.operation_ids).toHaveLength(2);
    const start = server.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/runs")).pop()!;
    expect(start.body).toEqual({ harness_id: harnessId });
  });

  it("runs one suite and waits for its result", async () => {
    const result = await cli(sb, ["test", "run", "--suite", "smoke", "--wait", "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const data = result.json<{ runs: Array<{ summary: { passed: number } }>; failed_cases: number; settled: boolean }>();
    expect(data).toMatchObject({ failed_cases: 0, settled: true });
    expect(data.runs[0]!.summary.passed).toBe(2);
  });

  it("exits 1 when a case failed, though the run itself finished", async () => {
    server.state.runSummary = { passed: 1, failed: 1, pass_rate: 0.5 };
    try {
      const result = await cli(sb, ["test", "run", "--suite", "smoke", "--wait", "--json"]);
      expect(result.code).toBe(1);
      expect(result.json<{ failed_cases: number }>().failed_cases).toBe(1);
    } finally {
      server.state.runSummary = { passed: 2, failed: 0, pass_rate: 1 };
    }
  });

  describe("a run that measured nothing comparable", () => {
    afterAll(() => {
      server.state.runSummary = { passed: 2, failed: 0, pass_rate: 1 };
    });
    const notRun = { passed: 0, failed: 0, errors: 0, not_run: 3, comparable: false, non_comparable_reasons: ["unrun_steps"], pass_rate: null };
    const pendingReview = { passed: 0, failed: 0, errors: 0, pending_review: 2, comparable: false, pass_rate: null };

    async function waitOn(summary: Record<string, unknown>) {
      server.state.runSummary = summary;
      const started = await cli(sb, ["test", "run", "--suite", "smoke", "--json"]);
      expect(started.code, started.stdout).toBe(0);
      const operationId = started.json<{ operation_ids: string[] }>().operation_ids[0]!;
      return { testRun: await cli(sb, ["test", "run", "--suite", "smoke", "--wait"]), wait: await cli(sb, ["wait", operationId, "--json"]) };
    }

    it("exits 1 when steps were not run, from test run --wait and from wait, and names the count", async () => {
      const { testRun, wait } = await waitOn(notRun);
      expect(testRun.code, testRun.stdout).toBe(1);
      expect(testRun.stdout).toMatch(/smoke: completed {2}passed 0 {2}failed 0 {2}errors 0 {2}3 not run {2}pass_rate null {2}not comparable \(unrun_steps\)/);
      expect(testRun.stdout).toMatch(/finished, but cases did not pass: 3 not run/);
      expect(wait.code, wait.stdout).toBe(1);
      expect(wait.json<{ failed_results: Array<Record<string, unknown>> }>().failed_results[0]).toMatchObject({
        counts: { not_run: 3 },
        comparable: false,
        non_comparable_reasons: ["unrun_steps"],
        exit_code: 1,
      });
    });

    it("exits 5 when answers wait for a manual verdict, from test run --wait and from wait", async () => {
      const { testRun, wait } = await waitOn(pendingReview);
      expect(testRun.code, testRun.stdout).toBe(5);
      expect(testRun.stdout).toMatch(/finished, but answers wait for a person: 2 pending review/);
      expect(wait.code, wait.stdout).toBe(5);
      expect(wait.json<{ failed_results: Array<Record<string, unknown>> }>().failed_results[0]).toMatchObject({ counts: { pending_review: 2 }, exit_code: 5 });
    });

    it("says why a case waits: the short reason next to the count, the case's own reason, and the explain to run", async () => {
      server.state.runResults = [
        { name: "Refund policy", status: "calibration_required", error_message: "knowledge_base_not_ready: Policies has no ready documents" },
        { name: "Greets", status: "pass" },
      ];
      try {
        const { testRun, wait } = await waitOn({ passed: 1, failed: 0, errors: 0, calibration_required: 1, comparable: false, pass_rate: null });
        expect(testRun.code, testRun.stdout).toBe(5);
        expect(testRun.stdout).toContain("smoke: completed  passed 1  failed 0  errors 0  1 calibration required (a knowledge base or value the case needs was not ready)");
        expect(testRun.stdout).toContain("Refund policy (step 1)  calibration_required: knowledge_base_not_ready: Policies has no ready documents");
        expect(testRun.stdout).toContain("What to do: cavelon explain calibration_required");
        expect(wait.json<{ failed_results: Array<{ cases: unknown[] }> }>().failed_results[0]!.cases).toEqual([
          expect.objectContaining({ case: "Refund policy", status: "calibration_required", reason: expect.stringContaining("knowledge_base_not_ready") }),
        ]);
      } finally {
        server.state.runResults = null;
      }
    });

    it("exits 1 for a run the instance marks not comparable without a count, and for an older instance's null pass rate", async () => {
      for (const summary of [
        { passed: 0, failed: 0, errors: 0, comparable: false, non_comparable_reasons: ["no_behavior_verdict"], pass_rate: null },
        { passed: 0, failed: 0, errors: 0, pass_rate: null },
      ]) {
        const { testRun, wait } = await waitOn(summary);
        expect(testRun.code, testRun.stdout).toBe(1);
        expect(testRun.stdout).toMatch(/it measured nothing comparable and has no pass rate/);
        expect(wait.code, wait.stdout).toBe(1);
      }
    });

    it("an older instance's summary without the newer counts still passes", async () => {
      const { testRun, wait } = await waitOn({ passed: 2, failed: 0, errors: 0 });
      expect(testRun.code, testRun.stdout).toBe(0);
      expect(wait.code, wait.stdout).toBe(0);
    });
  });

  it("--wait ends its output with the one command that resumes, with the same timeout (exit 6)", async () => {
    server.state.defaultSteps = ["queued", ...Array<"running">(12).fill("running"), "succeeded"];
    const text = await cli(sb, ["test", "run", "--suite", "smoke", "--wait", "--timeout", "100ms"]);
    expect(text.code).toBe(6);
    const lines = text.stdout.trimEnd().split("\n");
    const last = lines.at(-1)!;
    expect(last).toMatch(/^Still running after the timeout; the runs go on\. Resume: cavelon wait op_test_run_\S+ --timeout 100ms$/);
    // Said once, at the end.
    expect(text.stdout.match(/cavelon wait/g)).toHaveLength(1);

    const json = await cli(sb, ["test", "run", "--suite", "smoke", "--wait", "--timeout", "100ms", "--json"]);
    expect(json.code).toBe(6);
    const resume = json.json<{ resume: string }>().resume;
    expect(resume).toMatch(/^cavelon wait op_test_run_\S+ --timeout 100ms$/);
    // The command works as printed: each call resumes, until the run finishes.
    let again = await cli(sb, resume.split(" ").slice(1));
    for (let i = 0; i < 30 && again.code === 6; i++) again = await cli(sb, resume.split(" ").slice(1));
    expect(again.code, again.stdout).toBe(0);
  });

  it("names a suite that does not exist", async () => {
    const result = await cli(sb, ["test", "run", "--suite", "ghost", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("suite_not_found");
  });
});

describe("trace", () => {
  it("summarises a trigger run's traces, its spans, and one span in full", async () => {
    const runId = "7aace000-0000-4000-8000-000000000001";
    const traceId = "7aace000-0000-4000-8000-0000000000aa";
    server.state.traces.set(`trigger:${runId}`, [traceFixture(traceId, null)]);
    const list = await cli(sb, ["trace", runId, "--json"]);
    expect(list.code, list.stderr).toBe(0);
    expect(list.json<{ kind: string; traces: { items: Array<{ trace_id: string; spans: number }> } }>()).toMatchObject({
      kind: "trigger",
      traces: { items: [{ trace_id: traceId, spans: 3 }] },
    });

    const spans = await cli(sb, ["trace", runId, "--trace", traceId, "--json"]);
    const items = spans.json<{ spans: { items: Array<{ name: string; status: string; error: string | null }> } }>().spans.items;
    expect(items.map((s) => s.name)).toEqual(["Main", "generate", "search_documents"]);
    expect(items[2]).toMatchObject({ status: "error", error: expect.stringMatching(/tool exploded/) });

    const span = await cli(sb, ["trace", runId, "--trace", traceId, "--span", `${traceId}-span-2`, "--json"]);
    const detail = span.json<{ input: string; output: unknown }>();
    expect(typeof detail.input).toBe("string");
    expect(detail.input).toMatch(/more characters/);
    const full = await cli(sb, ["trace", runId, "--trace", traceId, "--span", `${traceId}-span-2`, "--full", "--json"]);
    expect(full.json<{ input: { prompt: string } }>().input.prompt).toHaveLength(5000);

    const text = await cli(sb, ["trace", runId]);
    expect(text.stdout).toContain(`Spans of a trace, by the trigger run id and the trace_id in its row: cavelon trace ${runId} --kind trigger --trace ${traceId}`);
    expect(list.json<{ traces: { items: Array<{ spans_command: string }> } }>().traces.items[0]!.spans_command).toBe(
      `cavelon trace ${runId} --kind trigger --trace ${traceId}`,
    );
  });

  it("follows an operation id to its test run's results", async () => {
    const started = await cli(sb, ["test", "run", "--suite", "smoke", "--json"]);
    const opId = started.json<{ operation_ids: string[] }>().operation_ids[0]!;
    const result = await cli(sb, ["trace", opId, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const data = result.json<{ kind: string; results: { items: Array<{ case: string; conversation_id: string | null }> } }>();
    expect(data.kind).toBe("test");
    expect(data.results.items.map((r) => r.case)).toEqual(["Greets", "Answers"]);
  });

  it("reads a conversation's traces", async () => {
    const conversation = "11111111-1111-4111-8111-111111111111";
    server.state.traces.set(`conversation:${conversation}`, [traceFixture("c0000000-0000-4000-8000-000000000001", conversation)]);
    // Guessed: the trigger and test routes answer nothing useful, the conversation does.
    const result = await cli(sb, ["trace", conversation, "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<{ kind: string }>().kind).toBe("conversation");
    const named = await cli(sb, ["trace", conversation, "--kind", "conversation", "--json"]);
    expect(named.json<{ kind: string }>().kind).toBe("conversation");
    // Named, an empty kind is shown as empty rather than skipped.
    const empty = await cli(sb, ["trace", conversation, "--kind", "test", "--json"]);
    expect(empty.json<{ kind: string; results: { items: unknown[] } }>()).toMatchObject({ kind: "test", results: { items: [] } });
  });

  describe("a test run's cases", () => {
    const conversation = "c0a7e000-0000-4000-8000-000000000001";
    const traceId = "c0a7e000-0000-4000-8000-0000000000aa";
    const caseRun = "c0a7e000-0000-4000-8000-0000000000bb";

    beforeAll(() => {
      server.state.traces.set(`conversation:${conversation}`, [traceFixture(traceId, conversation)]);
      server.state.runResults = [
        // A case answered in a conversation also names the agent's run: its traces are under the conversation.
        { name: "Refund limit", status: "pass", conversation_id: conversation, agent_run_id: caseRun, llm_judge_score: 0.55, llm_judge_reasoning: "Names the limit but not the approver." },
        { name: "Greets", status: "pass", llm_judge_score: 0.9 },
        { name: "Escalates", status: "fail", llm_judge_score: 0.1, llm_judge_reasoning: "Did not escalate." },
      ];
    });
    afterAll(() => {
      server.state.runResults = null;
    });

    async function testRunId(): Promise<string> {
      const started = await cli(sb, ["test", "run", "--suite", "smoke", "--json"]);
      return started.json<{ runs: Array<{ run_id: string }> }>().runs[0]!.run_id;
    }

    /** The command on the line that starts with `label`, split as a shell would. */
    function printed(stdout: string, label: string): string[] {
      const line = stdout.split("\n").find((l) => l.startsWith(label));
      expect(line, `no line "${label}" in:\n${stdout}`).toBeDefined();
      return line!.slice(line!.indexOf("cavelon ")).split(" ").slice(1);
    }

    it("print the drill-down with the id each route needs, and each command works as printed", async () => {
      const runId = await testRunId();
      const view = await cli(sb, ["trace", runId]);
      expect(view.code, view.stderr).toBe(0);
      const byCase = printed(view.stdout, "A case's traces, by the conversation_id in its row:");
      expect(byCase).toEqual(["trace", conversation, "--kind", "conversation"]);
      expect(view.stdout).not.toContain(`cavelon trace ${caseRun}`);

      const traces = await cli(sb, byCase);
      expect(traces.code, traces.stderr).toBe(0);
      const spansOf = printed(traces.stdout, "Spans of a trace, by the conversation id and the trace_id in its row:");
      expect(spansOf).toEqual(["trace", conversation, "--kind", "conversation", "--trace", traceId]);

      const spans = await cli(sb, spansOf);
      expect(spans.code, spans.stderr).toBe(0);
      const oneSpan = printed(spans.stdout, "One span in full, by the span_id in its row:");
      const span = await cli(sb, oneSpan);
      expect(span.code, span.stderr).toBe(0);
      expect(JSON.parse(span.stdout)).toMatchObject({ span_id: `${traceId}-span-1` });

      const json = await cli(sb, ["trace", runId, "--json"]);
      const items = json.json<{ results: { items: Array<{ case: string; trace_command: string | null }> } }>().results.items;
      expect(items.map((r) => r.trace_command)).toEqual([`cavelon trace ${conversation} --kind conversation`, null, null]);
    });

    it("show the judge's reasoning for every judged case, a pass too", async () => {
      const runId = await testRunId();
      const view = await cli(sb, ["trace", runId]);
      expect(view.stdout).toContain("Did not pass:\n  Escalates (step 1)  fail\n    Did not escalate.");
      expect(view.stdout).toContain("Judge's reasoning:\n  Refund limit (step 1)  pass  score 0.55\n    Judge: Names the limit but not the approver.");
      // A pass the instance sent no reasoning for is only scored.
      expect(view.stdout).not.toMatch(/Greets \(step 1\) {2}pass/);
      const json = await cli(sb, ["trace", runId, "--json"]);
      const items = json.json<{ results: { items: Array<{ case: string; judge_reasoning: string | null }> } }>().results.items;
      expect(items.map((r) => [r.case, r.judge_reasoning])).toEqual([
        ["Refund limit", "Names the limit but not the approver."],
        ["Greets", null],
        ["Escalates", "Did not escalate."],
      ]);
    });

    it("a wrong id gets a hint naming the id to use", async () => {
      const runId = await testRunId();
      // A test run's id where the route needs a conversation id.
      const wrongOwner = await cli(sb, ["trace", runId, "--trace", traceId, "--json"]);
      expect(wrongOwner.code).toBe(1);
      const error = wrongOwner.json<{ error: { code: string; message: string; hint: string } }>().error;
      expect(error.code).toBe("trace_not_found");
      expect(error.message).toContain(`No trace ${traceId} under trigger run or conversation ${runId}`);
      expect(error.hint).toMatch(/a conversation id with --kind conversation \(a test case's traces are under its conversation_id/);
      expect(error.hint).toContain(`List them with: cavelon trace ${runId}`);

      // The agent's run id named as a conversation.
      const asConversation = await cli(sb, ["trace", caseRun, "--kind", "conversation", "--json"]);
      expect(asConversation.code).toBe(1);
      expect(asConversation.json<{ error: { code: string; hint: string } }>().error).toMatchObject({
        code: "run_not_found",
        hint: expect.stringContaining("--kind conversation takes a conversation id (a test case's conversation_id"),
      });
      const named = await cli(sb, ["trace", caseRun, "--kind", "conversation", "--trace", traceId, "--json"]);
      expect(named.json<{ error: { code: string; hint: string } }>().error).toMatchObject({ code: "trace_not_found", hint: expect.stringContaining("conversation_id") });
    });
  });

  it("says when nothing has that id", async () => {
    const result = await cli(sb, ["trace", "99999999-9999-4999-8999-999999999999", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("run_not_found");
  });
});

describe("test-case statuses that are neither pass nor fail", () => {
  const statuses = CASE_STATUSES.map((s) => s.status);

  it("are the five the instance records, each tied to the summary counts test run prints", () => {
    expect(statuses).toEqual(["calibration_required", "pending_review", "not_run", "not_evaluated", "skip"]);
    // Every count test run prints is a failed verdict or one of these statuses, so each has an explanation.
    const verdicts = ["failed", "errors", "technical_errors", "unmeasurable_cases"];
    const explained = new Set(CASE_STATUSES.flatMap((s) => s.counts));
    for (const count of [...NOT_PASSED_COUNTS, ...WAITING_COUNTS].filter((c) => !verdicts.includes(c))) expect(explained, count).toContain(count);
    // Each count they name is a field of the run summary the instance publishes.
    const openapi = JSON.parse(readFileSync(path.join(CONTRACTS, "openapi.json"), "utf8")) as { components: { schemas: Record<string, { properties: object }> } };
    const summary = openapi.components.schemas.TestRunSummary!.properties;
    for (const count of explained) expect(Object.keys(summary), count).toContain(count);
  });

  it("explain answers each, by status, summary count or label, with what to do next", async () => {
    for (const name of [...statuses, "skipped", "cases_not_run", "Calibration Required"]) {
      const result = await cli(sb, ["explain", name, "--json"]);
      expect(result.code, `${name}: ${result.stderr}`).toBe(0);
      expect(result.json()).toMatchObject({ kind: "test_case_status", message: expect.any(String), hint: expect.any(String) });
    }
    const text = await cli(sb, ["explain", "calibration_required"]);
    expect(text.stdout).toMatch(/meaning: +The instance did not run the case\. .*knowledge_base_not_ready/);
    expect(text.stdout).toMatch(/docs: +http:\/\/\S+\/docs\/concepts\/regression-testing#preflight-is-decided-when-the-run-is-accepted/);
  });

  it("are listed in the cavelon-testing skill", () => {
    const skill = readFileSync(path.join(CONTRACTS, "..", "..", "plugin", "skills", "cavelon-testing", "SKILL.md"), "utf8");
    for (const status of statuses) expect(skill, status).toContain(`\`${status}\``);
  });
});
