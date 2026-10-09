import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { checkEvidence, cleanupOwnedChild, createApprovalFixture, digest, execute, isolatedEnv, observeExit, requirePersonTerminal, selected, toolBody, type Evidence, type Observation } from "./fixtures/approval-qualification.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(repo, ".wt/approval-qualification-tests", String(process.pid));
let fixture: Awaited<ReturnType<typeof createApprovalFixture>>;
const observations: Record<string, Observation> = {};
let exported: Evidence;

// Every UI answer in this file is SIMULATED. No person/client platform acceptance.
beforeAll(async () => {
  await fs.mkdir(path.dirname(directory), { recursive: true });
  fixture = await createApprovalFixture(directory, { command: process.execPath, args: [path.join(repo, "cli/dist/cli.js")] });
});
afterAll(async () => { await fixture?.close(); });

it("keeps missing UI, headless and sibling scope safe for the deleting/query-limit import", async () => {
  const bridge = await fixture.bridge();
  try {
    const preview = toolBody(await bridge.call("apply", { ...selected, mode: "replace" }));
    expect(preview.show_to_person).toBe(true);
    expect(preview.database_queries.would_write).toHaveLength(1);
    const noUi = toolBody(await bridge.call("apply", { ...selected, confirm: preview.preview_id }));
    const sibling = toolBody(await bridge.call("apply", { ...selected, solution_dir: "solutions/assistant", confirm: preview.preview_id }));
    observations.headless = { code: noUi.error.code, ...fixture.counts() };
    observations.sibling = { code: sibling.error.code, ...fixture.counts() };
    expect(noUi.error.code).toBe("confirm_needs_person");
    expect(sibling.error.code).toBe("preview_unknown");
    expect(fixture.counts()).toEqual({ confirmations: 0, imports: 0 });
    expect(fixture.seeded.query.max_rows).toBe(5);
  } finally { await bridge.close(); }
  const interactive = await fixture.bridge(true);
  try {
    const preview = toolBody(await interactive.call("apply", { ...selected, mode: "replace" }));
    await interactive.call("apply", { ...selected, confirm: preview.preview_id });
    expect(fixture.counts()).toEqual({ confirmations: 0, imports: 0 });
  } finally { await interactive.close(); }
});

it.each([false, undefined, "yes", { approve: true }])("SIMULATED decline/non-boolean answer %j sends zero nonces/imports", async value => {
  const bridge = await fixture.bridge(true);
  try {
    const preview = toolBody(await bridge.call("apply", { ...selected, mode: "replace" }));
    const result = toolBody(await bridge.call("apply", { ...selected, confirm: preview.preview_id }, { ask: async () => value }));
    observations.decline = { code: result.error.code, ...fixture.counts() };
    expect(result.error.code).toBe("confirm_declined");
    expect(fixture.counts()).toEqual({ confirmations: 0, imports: 0 });
  } finally { await bridge.close(); }
});

it("SIMULATED abort rejects a late yes and requires a fresh connection", async () => {
  const bridge = await fixture.bridge(true), abort = new AbortController();
  let answer: (value: boolean) => void = () => undefined, visible: () => void = () => undefined;
  const shown = new Promise<void>(resolve => { visible = resolve; });
  try {
    const preview = toolBody(await bridge.call("apply", { ...selected, mode: "replace" }));
    const pending = bridge.call("apply", { ...selected, confirm: preview.preview_id }, {
      signal: abort.signal, ask: () => { visible(); return new Promise(resolve => { answer = resolve; }); },
    });
    const rejected = expect(pending).rejects.toThrow();
    await shown;
    abort.abort();
    await rejected;
    answer(true);
    await expect(bridge.call("apply", { ...selected, confirm: preview.preview_id }, { ask: async () => true })).rejects.toThrow(/disconnected/);
    expect(fixture.counts()).toEqual({ confirmations: 0, imports: 0 });
  } finally { await bridge.close(); }
});

it("SIMULATED preview expiry asks nobody and sends zero nonces/imports", async () => {
  const bridge = await fixture.bridge(true);
  try {
    const preview = toolBody(await bridge.call("apply", { ...selected, mode: "replace" }));
    const previews = path.join(fixture.root, "solutions/review/.cavelon/previews");
    const file = path.join(previews, preview.preview_id + ".json");
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    saved.created_at = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(file, JSON.stringify(saved));
    let asked = false;
    const result = toolBody(await bridge.call("apply", { ...selected, confirm: preview.preview_id }, { ask: async () => { asked = true; return true; } }));
    expect(result.error.code).toBe("preview_expired");
    expect(asked).toBe(false);
    expect(fixture.counts()).toEqual({ confirmations: 0, imports: 0 });
  } finally { await bridge.close(); }
});

it("SIMULATED decline then a fresh yes sends one bound nonce/import and exports inspectable evidence", async () => {
  const bridge = await fixture.bridge(true);
  let asked = 0;
  try {
    const preview = toolBody(await bridge.call("apply", { ...selected, mode: "replace" }));
    const refused = toolBody(await bridge.call("apply", { ...selected, confirm: preview.preview_id }, { ask: async () => { asked++; return false; } }));
    expect(refused.error.code).toBe("confirm_declined");
    expect(fixture.counts()).toEqual({ confirmations: 0, imports: 0 });
    const fresh = toolBody(await bridge.call("apply", { ...selected, mode: "replace" }));
    const approved = toolBody(await bridge.call("apply", { ...selected, confirm: fresh.preview_id }, { ask: async message => {
      asked++; expect(message).toContain("review"); expect(fixture.counts()).toEqual({ confirmations: 0, imports: 0 }); return true;
    } }));
    observations.approve = { applied: approved.applied };
    expect(asked).toBe(2);
    expect(fixture.counts()).toEqual({ confirmations: 1, imports: 1 });
    exported = fixture.evidence("simulated", observations);
    checkEvidence(exported);
    await fs.writeFile(path.join(directory, "evidence.json"), JSON.stringify(exported, null, 2));
    expect(exported.actual_person_ui).toBe(false);
    expect(JSON.stringify(exported)).not.toContain(fixture.home);
    expect(JSON.stringify(exported)).not.toContain("authorization");
  } finally { await bridge.close(); }
});

it.each(["count", "body", "result", "provenance", "scope"]) ("rejects altered %s evidence", kind => {
  const altered = structuredClone(exported);
  if (kind === "count") altered.confirmations = 2;
  if (kind === "body") (altered.binding.import!.body as any).mode = "overwrite";
  if (kind === "result") altered.obsolete_agent_deleted = false;
  if (kind === "provenance") altered.actual_person_ui = true as any;
  if (kind === "scope") altered.binding.selected_harness = false;
  expect(() => checkEvidence(altered)).toThrow();
});

it("accepts reordered canonical request keys while keeping attestation digests exact", () => {
  const reverse = (value: any): any => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  const reordered = structuredClone(exported);
  reordered.binding.confirmation = reverse(reordered.binding.confirmation);
  expect(() => checkEvidence(reordered)).not.toThrow();
  expect(digest(reordered)).not.toBe(digest(exported));
});

it.each(["windows-failed", "windows-unobserved", "posix-unobserved", "windows-exited", "posix-exited"]) (
  "SIMULATED cleanup requires positive owned-child exit: %s", async scenario => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as unknown as ChildProcess;
    const exit = observeExit(child), signals: string[] = [];
    const cleanup = cleanupOwnedChild({ platform: scenario.startsWith("windows") ? "win32" : "linux", pid: 123, exit, graceMs: 5, forceMs: 5,
      windowsKill: async () => { if (scenario === "windows-exited") child.emit("exit", 0); return { code: scenario === "windows-failed" ? 1 : 0 }; },
      signalGroup: signal => { signals.push(signal); if (scenario === "posix-exited" && signal === "SIGKILL") child.emit("exit", 0); },
    });
    if (scenario.endsWith("exited")) { await cleanup; expect(exit.observed()).toBe(true); }
    else { await expect(cleanup).rejects.toThrow(/unverified/); expect(exit.observed()).toBe(false); }
    if (scenario.startsWith("posix")) expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  },
);

it("records a real owned subprocess exit without launching a client or form", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const exit = observeExit(child);
  expect(exit.observed()).toBe(false);
  expect(await exit.wait(3000)).toBe(true);
  expect(exit.observed()).toBe(true);
});

it("refuses agent/headless terminal helpers and isolates personal provider/credential settings", () => {
  expect(() => requirePersonTerminal({ CODEX_THREAD_ID: "fixture" }, true)).toThrow(/person/);
  expect(() => requirePersonTerminal({}, false)).toThrow(/person/);
  expect(() => requirePersonTerminal({}, true)).not.toThrow();
  const env = isolatedEnv(directory);
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.CAVELON_AGENT).toBe("1");
  expect(env.CAVELON_CREDENTIAL_STORE).toBe("file");
});

it("portable check exports simulated evidence and refuses promotion to actual person provenance", async () => {
  const candidate = { command: process.execPath, args: [path.join(repo, "cli/scripts/qualify-approval.mjs")] };
  const checked = await execute(candidate, ["check", "--run", directory], fixture.env, repo);
  expect(checked.code, checked.err).toBe(0);
  const report = JSON.parse(await fs.readFile(path.join(directory, "export.json"), "utf8"));
  expect(report.provenance).toBe("simulated");
  expect(report.actual_person_ui).toBe(false);
  const rejected = await execute(candidate, ["attest", "--run", directory], fixture.env, repo);
  expect(rejected.code).toBe(1);
  expect(rejected.err).toContain("person's own interactive terminal");
});

it("portable check requires a digest-bound person attestation for observed imports", async () => {
  const candidate = { command: process.execPath, args: [path.join(repo, "cli/scripts/qualify-approval.mjs")] };
  const file = path.join(directory, "evidence.json");
  try {
    await fs.writeFile(file, JSON.stringify({ ...exported, provenance: "unattested-observation", route: "terminal" }));
    await fs.writeFile(path.join(directory, "supervisor-state.json"), JSON.stringify({ status: "failed", cleanup_completed: false }));
    const unsafe = await execute(candidate, ["check", "--run", directory], fixture.env, repo);
    expect(unsafe.code).toBe(1);
    expect(unsafe.err).toContain("cleanup did not complete safely");
    await fs.writeFile(path.join(directory, "supervisor-state.json"), JSON.stringify({ status: "completed", cleanup_completed: true }));
    await fs.writeFile(path.join(directory, "person-attestation.json"), JSON.stringify({ provenance: "operator-attested-person", evidence_sha256: "wrong" }));
    const checked = await execute(candidate, ["check", "--run", directory], fixture.env, repo);
    expect(checked.code, checked.err).toBe(2);
    const report = JSON.parse(await fs.readFile(path.join(directory, "export.json"), "utf8"));
    expect(report.provenance).toBe("unattested-observation");
    expect(report.operator_attestation_valid).toBe(false);
    expect(report.operator_attested_coverage).toBeNull();
  } finally {
    await fs.writeFile(file, JSON.stringify(exported, null, 2));
    await fs.rm(path.join(directory, "person-attestation.json"));
  }
});
