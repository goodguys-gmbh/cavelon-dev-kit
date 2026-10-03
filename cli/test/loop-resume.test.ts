import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoopPlan } from "./fake-long-running.js";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type CliResult, type Sandbox } from "./helpers.js";

/**
 * A paused loop says how it goes on: `loop watch` offers `loop resume`
 * only where the instance would accept it, `--reason` is the pause reason a
 * person reviewed and never free text, and a pause that cannot be resumed names
 * what to do instead. Where the instance publishes the loop's `resume`,
 * the kit follows it; until then, the loop's
 * published state and the instance's answer to the resume decide.
 */

let server: FakeServer;
let sb: Sandbox;
let tenant: string;

/** The snapshot's catalog explains the pause reasons and the resume refusals. */
const catalog = (JSON.parse(readFileSync(path.join(CONTRACTS, "meta-error-catalog.json"), "utf8")) as { api_error_codes: Array<{ code: string; message: string; hint: string }> }).api_error_codes;
const entry = (code: string) => catalog.find((e) => e.code === code)!;
const RUNTIME_EVIDENCE = entry("runtime_evidence_invalid");
const REVIEW_REQUIRED = entry("loop_resume_review_required");
const CONTROL_UNAVAILABLE = entry("loop_control_unavailable");
const CONTROL_INVALID = entry("loop_control_invalid");

function addTrigger(slug: string, loop: LoopPlan): void {
  const harnessId = randomUUID();
  server.state.harnesses.push({ id: harnessId, tenant_id: tenant, slug: `${slug}-parent`, name: slug, status: "draft" });
  server.state.lr.triggers.push({
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
  });
}

const jsonLines = (result: CliResult) =>
  result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);

const resumes = () => server.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/resume"));

/** Starts the trigger's run and watches it to its pause. */
async function pausedRun(slug: string): Promise<{ runId: string; loopId: string; outcome: Record<string, any>; text: string }> {
  const started = await cli(sb, ["loop", "start", slug, "--json"]);
  expect(started.code, started.stdout).toBe(0);
  const runId = started.json<{ run_id: string }>().run_id;
  const watched = await cli(sb, ["loop", "watch", runId, "--json", "--timeout", "30s"]);
  expect(watched.code, watched.stdout).toBe(5);
  const outcome = jsonLines(watched).at(-1)!;
  expect(outcome).toMatchObject({ type: "outcome", state: "paused" });
  const text = await cli(sb, ["loop", "watch", runId, "--timeout", "30s"]);
  expect(text.code).toBe(5);
  return { runId, loopId: outcome.loop_id, outcome, text: text.stdout };
}

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  server.state.features = { ...server.state.features, masterloop_enabled: true };
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
afterAll(async () => {
  sb.cleanup();
  await server.close();
});

describe("the instance publishes how a pause goes on", () => {
  it("a resumable pause offers the plain resume, and a reviewed reason is refused with what to run instead", async () => {
    addTrigger("evidence", { iterations: 3, blockAt: 1, pauseReason: "runtime_evidence_invalid", resume: "plain" });
    const { runId, loopId, outcome, text } = await pausedRun("evidence");
    const resume = `cavelon loop resume ${runId} --loop ${loopId}`;
    expect(outcome.go_on).toEqual({
      resume: "plain",
      decided_by: "instance",
      reason_text: `${RUNTIME_EVIDENCE.message} ${RUNTIME_EVIDENCE.hint}`,
      why_not: null,
      commands: [resume],
      if_review_required: null,
    });
    expect(text).toContain(`It waits for a person: fix the cause, then resume it:\n  ${resume}\n`);
    expect(text).not.toMatch(/--reason/);

    // The re-run's call: the instance refuses a reviewed reason for this pause.
    const reviewed = await cli(sb, ["loop", "resume", runId, "--reason", "runtime_evidence_invalid", "--json"]);
    expect(reviewed.code).toBe(3);
    const error = reviewed.json<{ error: { code: string; hint: string } }>().error;
    expect(error.code).toBe("loop_control_invalid");
    expect(error.hint).toBe(`${CONTROL_INVALID.hint} This pause (runtime_evidence_invalid) takes no review; resume it without --reason: ${resume}`);

    const resumed = await cli(sb, ["loop", "resume", runId, "--json"]);
    expect(resumed.code, resumed.stdout).toBe(0);
    expect(resumed.json()).toMatchObject({ action: "resume", reviewed_reason: null });
  });

  it("a verdict on the task offers the resume with the pause reason, and refuses free text before sending", async () => {
    addTrigger("verdict", { iterations: 3, blockAt: 1, pauseReason: "invalid_continuation" });
    const { runId, loopId, outcome, text } = await pausedRun("verdict");
    const review = `cavelon loop resume ${runId} --loop ${loopId} --reason invalid_continuation`;
    expect(outcome.go_on).toMatchObject({ resume: "review_required", decided_by: "instance", commands: [review], if_review_required: null });
    expect(text).toContain(`The pause is a verdict on the task: check the cause and fix it, then resume and name the pause reason as reviewed:\n  ${review}`);

    const before = resumes().length;
    const freeText = await cli(sb, ["loop", "resume", runId, "--reason", "checked the output", "--json"]);
    expect(freeText.code).toBe(2);
    const usage = freeText.json<{ error: { message: string; hint: string } }>().error;
    expect(usage.message).toMatch(/paused for invalid_continuation, not "checked the output"/);
    expect(usage.hint).toBe(`After a review of invalid_continuation: ${review}`);

    const bare = await cli(sb, ["loop", "resume", runId, "--json"]);
    expect(bare.code).toBe(5);
    const needed = bare.json<{ error: { code: string; hint: string } }>().error;
    expect(needed.code).toBe("loop_resume_review_required");
    expect(needed.hint).toMatch(new RegExp(`then: ${review}$`));
    expect(resumes()).toHaveLength(before);

    const resumed = await cli(sb, ["loop", "resume", runId, "--reason", "invalid_continuation", "--json"]);
    expect(resumed.code, resumed.stdout).toBe(0);
    expect(resumed.json()).toMatchObject({ action: "resume", reviewed_reason: "invalid_continuation" });
    expect(resumes().at(-1)!.body).toMatchObject({ reviewed_reason: "invalid_continuation" });
  });

  it("a pause that cannot be resumed names cancel and a new run instead, and resume refuses it before sending", async () => {
    addTrigger("stuck", { iterations: 3, blockAt: 1, pauseReason: "runtime_evidence_invalid", resume: "none" });
    const { runId, outcome, text } = await pausedRun("stuck");
    const instead = [`cavelon loop cancel ${runId} --confirm`, "cavelon loop start stuck"];
    expect(outcome.go_on).toMatchObject({ resume: "none", decided_by: "instance", commands: instead });
    expect(text).toContain(`${RUNTIME_EVIDENCE.message} ${RUNTIME_EVIDENCE.hint}\nIt cannot be resumed. Instead, stop the run, fix the cause and start a new run:\n  ${instead[0]}\n  ${instead[1]}`);
    expect(text).not.toMatch(/loop resume/);

    const before = resumes().length;
    const refused = await cli(sb, ["loop", "resume", runId, "--json"]);
    expect(refused.code).toBe(4);
    const error = refused.json<{ error: { code: string; hint: string } }>().error;
    expect(error.code).toBe("loop_not_resumable");
    expect(error.hint).toBe(`Instead, stop the run, fix the cause and start a new run: ${instead.join(", then ")}`);
    expect(resumes()).toHaveLength(before);
  });
});

describe("the instance does not publish it: the loop's state and the resume's answer decide", () => {
  it("a loop whose state rules out a resume is not offered one", async () => {
    addTrigger("switched-off", { iterations: 3, blockAt: 1, publishResume: false, pauseReason: "feature_disabled", pausedDetail: { resume_enabled: false } });
    const off = await pausedRun("switched-off");
    expect(off.outcome.go_on).toMatchObject({
      resume: "none",
      decided_by: "loop_state",
      why_not: "Masterloop or Sandboxes are switched off on this instance",
      commands: [`cavelon loop cancel ${off.runId} --confirm`, "cavelon loop start switched-off"],
    });
    expect(off.text).toContain("It cannot be resumed: Masterloop or Sandboxes are switched off on this instance. Instead,");

    addTrigger("expired", { iterations: 3, blockAt: 1, publishResume: false, pauseReason: "user_paused", pausedDetail: { deadline_at: "2026-01-01T00:00:00Z" } });
    const expired = await pausedRun("expired");
    expect(expired.outcome.go_on).toMatchObject({ resume: "none", why_not: "its deadline passed (2026-01-01T00:00:00Z)" });

    addTrigger("unknown-op", { iterations: 3, blockAt: 1, publishResume: false, pauseReason: "operation_unknown", pausedDetail: { operation_counts: { unknown: 1 } } });
    const unknown = await pausedRun("unknown-op");
    expect(unknown.outcome.go_on).toMatchObject({ resume: null, commands: [`cavelon loop resume ${unknown.runId} --loop ${unknown.loopId}`] });
    expect(unknown.text).toContain("Not yet: the instance refuses a resume while one of its Sandbox operations has an unknown outcome;");
  });

  it("a plain resume of a verdict is answered by the instance, and the kit names the command with the pause reason", async () => {
    addTrigger("blocked", { iterations: 3, blockAt: 1, publishResume: false });
    const { runId, loopId, outcome } = await pausedRun("blocked");
    const review = `cavelon loop resume ${runId} --loop ${loopId} --reason task_blocked`;
    expect(outcome.go_on).toMatchObject({ resume: null, decided_by: "loop_state", if_review_required: review });

    const bare = await cli(sb, ["loop", "resume", runId, "--json"]);
    expect(bare.code).toBe(5);
    const error = bare.json<{ error: { code: string; hint: string } }>().error;
    expect(error.code).toBe("loop_resume_review_required");
    // The catalog's hint first, then the command with the pause reason filled in.
    expect(error.hint).toMatch(new RegExp(`^${REVIEW_REQUIRED.hint} A person checks the cause .* then: ${review}$`));

    const resumed = await cli(sb, ["loop", "resume", runId, "--reason", "task_blocked", "--json"]);
    expect(resumed.code, resumed.stdout).toBe(0);
    expect(resumed.json()).toMatchObject({ reviewed_reason: "task_blocked" });
  });

  it("a refusal because the loop cannot go on names cancel and a new run", async () => {
    addTrigger("ended", { iterations: 3, blockAt: 1, publishResume: false, pauseReason: "child_result_unavailable", resume: "none" });
    const { runId, outcome } = await pausedRun("ended");
    expect(outcome.go_on).toMatchObject({ resume: null });
    const refused = await cli(sb, ["loop", "resume", runId, "--json"]);
    expect(refused.code).toBe(4);
    const error = refused.json<{ error: { code: string; hint: string } }>().error;
    expect(error.code).toBe("loop_control_unavailable");
    expect(error.hint).toBe(`${CONTROL_UNAVAILABLE.hint} The loop cannot go on. Instead, stop the run, fix the cause and start a new run: cavelon loop cancel ${runId} --confirm, then cavelon loop start ended`);
  });

  it("loop pause takes no --reason: the instance accepts one only on a resume", async () => {
    const help = await cli(sb, ["loop", "pause", "--help"]);
    expect(help.stdout).not.toMatch(/--reason/);
    const resumeHelp = await cli(sb, ["loop", "resume", "--help"]);
    expect(resumeHelp.stdout).toMatch(/--reason <pause_reason>/);
    expect(resumeHelp.stdout).not.toMatch(/checked the output/);
  });
});
