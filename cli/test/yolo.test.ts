import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import { createMcpServer } from "../src/mcp.js";
import type { InStream } from "../src/io.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { seedQueryTool } from "./fake-database.js";
import { askingClient, cli, login, sandbox, type PersonAtClient, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let dir: string;
let tenant: string;
const agent = { CLAUDECODE: "1" };
const imports = () => server.state.requests.filter(r => r.path === "/api/v1/agent-graph/import");
const support = () => server.state.harnesses.find(h => h.tenant_id === tenant && h.slug === "support")!;

async function mcp(yolo = true, person: PersonAtClient = "approves") {
  const io = { cwd: dir, env: sb.env, stdout: { write: () => true }, stderr: { write: () => true },
    stdin: Readable.from([]) as unknown as InStream, now: () => new Date(), sleep: async () => {} };
  const serverMcp = createMcpServer(io, COMMANDS, {}, { yolo });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await serverMcp.connect(b);
  const client = askingClient({ person });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;
  };
  // Finish launch-scope resolution before a test mutates the selected target.
  await call("apply");
  server.state.requests.length = 0;
  return { client, call };
}

beforeEach(async () => {
  server = await startFakeServer();
  server.state.features = { ...server.state.features, masterloop_enabled: true, database_connector_enabled: true };
  sb = sandbox();
  tenant = server.addTenant("acme", "Acme");
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  dir = path.join(sb.home, "solution");
  mkdirSync(dir);
  expect((await cli(sb, ["init", "--harness", "support"], { cwd: dir })).code).toBe(0);
  expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
  const file = path.join(dir, "package", "agents.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("temperature: 0.2", "temperature: 0.5"));
  server.state.requests.length = 0;
});

afterEach(async () => { sb.cleanup(); await server.close(); });

it("YOLO previews and applies a routine draft in one command without person approval", async () => {
  const result = await cli(sb, ["--yolo", "apply", "--json"], { cwd: dir, env: agent });
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.json()).toMatchObject({ applied: true, approval: { source: "yolo" } });
  const preview = server.state.requests.find(r => r.path === "/api/v1/agent-graph/import/preview")!;
  const imported = server.state.requests.find(r => r.path === "/api/v1/agent-graph/import")!;
  expect(preview).toBeDefined();
  expect(imported.body).toMatchObject({ ...preview.body as object, preview_id: expect.any(String) });
  expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toEqual([]);
});

it.each([false, true])("the published MCP launch forwards --yolo and its environment (env: %s)", async environment => {
  const client = askingClient();
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp", "--yolo", ...(environment ? ["--env", "test"] : [])], cwd: dir, env: sb.env, stderr: "pipe" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "apply", arguments: {} });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ applied: true, approval: { source: "yolo" } });
    expect(client.asked).toEqual([]);
  } finally { await client.close(); }
});

it.each(["saved", "disabled", "invalid"])("a normal plugin MCP launch uses the personal startup mode (%s)", async mode => {
  expect((await cli(sb, ["setup", "--mcp-mode", "yolo", "--yes"])).code).toBe(0);
  if (mode === "invalid") writeFileSync(path.join(sb.env.CAVELON_CONFIG_DIR!, "automation.json"), '{"format":2,"mcp_mode":"yolo"}');
  const client = askingClient();
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp", ...(mode === "disabled" ? ["--no-yolo"] : [])], cwd: dir, env: sb.env, stderr: "pipe" });
  try {
    await client.connect(transport);
    // Editing the preference must not change an already-running MCP session.
    if (mode !== "invalid") expect((await cli(sb, ["setup", "--mcp-mode", "standard", "--yes"])).code).toBe(0);
    const result = await client.callTool({ name: "apply", arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(data).toMatchObject(mode === "saved" ? { applied: true, approval: { source: "yolo" } } : { previewed: true });
    expect(client.asked).toEqual([]);
    if (mode === "saved") {
      support().status = "active";
      const previewResult = await client.callTool({ name: "apply", arguments: {} });
      const preview = JSON.parse((previewResult.content as Array<{ text: string }>)[0]!.text);
      expect(preview).toMatchObject({ show_to_person: true, needs_person: "client" });
      const confirmed = await client.callTool({ name: "apply", arguments: { confirm: preview.preview_id } });
      expect(JSON.parse((confirmed.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ applied: true });
      expect(client.asked).toHaveLength(1);
    }
  } finally { await client.close(); }
});

it("saving MCP YOLO does not enable it for ordinary CLI commands", async () => {
  await cli(sb, ["setup", "--mcp-mode", "yolo", "--yes"]);
  const result = await cli(sb, ["apply", "--json"], { cwd: dir, env: agent });
  expect(result.json()).toMatchObject({ previewed: true });
  expect(imports()).toHaveLength(0);
});

it("installer skill updates refresh this solution's owned copies and preserve custom files", async () => {
  expect((await cli(sb, ["init", "--agents", "cursor"], { cwd: dir })).code).toBe(0);
  const owned = path.join(dir, ".agents", "skills", "cavelon-loop", "SKILL.md");
  writeFileSync(owned, readFileSync(owned, "utf8") + "\nOutdated loop\n");
  const foreign = path.join(dir, ".agents", "skills", "cavelon-authoring", "SKILL.md");
  writeFileSync(foreign, "Custom skill: keep my instructions.\n");
  const updated = await cli(sb, ["setup", "--installer", "--update", "--non-interactive", "--json"], { cwd: dir });
  expect(updated.code, updated.stdout + updated.stderr).toBe(0);
  expect(readFileSync(owned, "utf8")).not.toContain("Outdated loop");
  expect(readFileSync(foreign, "utf8")).toBe("Custom skill: keep my instructions.\n");
  expect(updated.json()).toMatchObject({ update: { project: { solution: dir } } });
  expect(server.state.requests.filter(r => r.method !== "GET")).toEqual([]);
});

it("standard MCP draft previews can be confirmed without a human dialog", async () => {
  const { client, call } = await mcp(false);
  try {
    const preview = await call("apply");
    expect(preview).toMatchObject({ previewed: true, show_to_person: false });
    expect(imports()).toHaveLength(0);
    expect(await call("apply", { confirm: preview.preview_id })).toMatchObject({ applied: true });
    expect(client.asked).toEqual([]);
  } finally { await client.close(); }
});

it("YOLO MCP applies a draft automatically, but live changes ask exactly once", async () => {
  const { client, call } = await mcp();
  try {
    expect(await call("apply")).toMatchObject({ applied: true, approval: { source: "yolo" } });
    expect(client.asked).toEqual([]);
    support().status = "active";
    const preview = await call("apply");
    expect(preview).toMatchObject({ show_to_person: true, needs_person: "client" });
    const before = imports().length;
    expect(await call("apply", { confirm: preview.preview_id })).toMatchObject({ applied: true });
    expect(client.asked).toHaveLength(1);
    expect(imports()).toHaveLength(before + 1);
  } finally { await client.close(); }
});

it("YOLO never turns a declined critical dialog into approval", async () => {
  const { client, call } = await mcp(true, "declines");
  try {
    support().status = "active";
    const preview = await call("apply");
    expect((await call("apply", { confirm: preview.preview_id })).error.code).toBe("confirm_declined");
    expect(client.asked).toHaveLength(1);
    expect(imports()).toHaveLength(0);
  } finally { await client.close(); }
});

it("rejects stale critical previews before bothering the person", async () => {
  const { client, call } = await mcp();
  try {
    support().status = "active";
    const preview = await call("apply");
    const file = path.join(dir, "package", "agents.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("temperature: 0.5", "temperature: 0.7"));
    expect((await call("apply", { confirm: preview.preview_id })).error.code).toBe("preview_files_changed");
    expect(client.asked).toEqual([]);
    expect(imports()).toHaveLength(0);
  } finally { await client.close(); }
});

it.each(["deletions", "query definitions", "shared settings", "unknown impact"])("does not automatically apply %s", async kind => {
  if (kind === "deletions") server.state.previewExtras = { summary: { creates: {}, updates: {}, deletes: { agents: 1 } } };
  if (kind === "query definitions") server.state.previewExtras = { database_queries: { would_write: ["lookup"] } };
  if (kind === "shared settings") server.state.previewExtras = { impact: { active_harnesses: [{ harness_slug: "another-live-solution" }] } };
  if (kind === "unknown impact") server.state.previewExtras = { impact: undefined };
  const result = await cli(sb, ["apply", "--yolo", "--json"], { cwd: dir, env: agent });
  expect(result.code, result.stdout).toBe(0);
  expect(result.json()).toMatchObject({ previewed: true });
  expect(imports()).toHaveLength(0);
});

it("does not carry YOLO to another selected harness", async () => {
  expect((await cli(sb, ["harness", "new", "other"])).code).toBe(0);
  const { client, call } = await mcp();
  try {
    expect(await call("apply", { harness: "other" })).toMatchObject({ previewed: true, warnings: [expect.stringContaining("selected at startup")] });
    expect(imports()).toHaveLength(0);
  } finally { await client.close(); }
});

it("does not carry YOLO to another credential", async () => {
  const { client, call } = await mcp();
  try {
    await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
    expect(await call("apply")).toMatchObject({ previewed: true, warnings: [expect.stringContaining("does not cover")] });
    expect(imports()).toHaveLength(0);
  } finally { await client.close(); }
});

it("does not carry YOLO to another tenant even with the same solution slug", async () => {
  const other = server.addTenant("other", "Other");
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant, other], defaultTenant: tenant }));
  expect((await cli(sb, ["harness", "new", "support", "--tenant", other])).code).toBe(0);
  const { client, call } = await mcp();
  try {
    expect(await call("apply", { tenant: other })).toMatchObject({ previewed: true, warnings: [expect.stringContaining("does not cover")] });
    expect(imports()).toHaveLength(0);
  } finally { await client.close(); }
});

it("does not carry YOLO to another solution folder or environment", async () => {
  const child = path.join(dir, "nested");
  mkdirSync(child);
  expect((await cli(sb, ["init", "--harness", "support"], { cwd: child })).code).toBe(0);
  expect((await cli(sb, ["pull"], { cwd: child })).code).toBe(0);
  const { client, call } = await mcp();
  try {
    expect(await call("apply", { solution_dir: "nested" })).toMatchObject({ previewed: true, warnings: [expect.stringContaining("does not cover")] });
    expect(await call("apply", { env: "test" })).toMatchObject({ previewed: true, warnings: [expect.stringContaining("does not cover")] });
    expect(imports()).toHaveLength(0);
  } finally { await client.close(); }
});

it("refuses enabling YOLO through a tool argument", async () => {
  const { client, call } = await mcp(false);
  try {
    expect((await call("apply", { yolo: true })).error.code).toBe("unknown_argument");
    expect(imports()).toHaveLength(0);
  } finally { await client.close(); }
});

it("uses the real process scope for routine API creation and cloning", async () => {
  const { client, call } = await mcp();
  try {
    expect(await call("api", { operation: "create_harness", body: JSON.stringify({ slug: "api-draft", name: "API Draft" }) })).toMatchObject({ slug: "api-draft", status: "draft" });
    expect(await call("api", { operation: "clone_harness", params: [`harness_id=${support().id}`], body: JSON.stringify({ slug: "api-clone", name: "API Clone" }) })).toMatchObject({ slug: "api-clone", status: "draft" });
    expect(client.asked).toEqual([]);
  } finally { await client.close(); }
});

it("does not grant automatic imports a person approval or a server nonce after an unexpected 428", async () => {
  server.state.failures.push({ method: "POST", path: /^\/api\/v1\/agent-graph\/import$/, status: 428,
    code: "confirmation_required", detail: "Confirmation required" });
  const result = await cli(sb, ["apply", "--yolo", "--json"], { cwd: dir });
  expect(result.code).toBe(5);
  expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toEqual([]);
});

it("keeps the preview step when an older instance omits database query effects", async () => {
  const seeded = seedQueryTool(server.state.db, tenant);
  server.editConfig(tenant, pkg => { (pkg.tools as object[]).push(structuredClone(seeded.tool)); });
  expect((await cli(sb, ["pull", "--force"], { cwd: dir })).code).toBe(0);
  server.state.previewExtras = { database_queries: undefined };
  server.state.requests.length = 0;
  const result = await cli(sb, ["apply", "--yolo", "--json"], { cwd: dir, env: agent });
  expect(result.code, result.stdout).toBe(0);
  expect(result.json()).toMatchObject({ previewed: true });
  expect(imports()).toHaveLength(0);
});

it("automates only the selected draft trigger and keeps supplied stale tokens meaningful", async () => {
  server.state.features = { ...server.state.features, masterloop_enabled: true };
  server.state.lr.triggers.push({ id: randomUUID(), tenant_id: tenant, slug: "draft-loop", name: "Draft", harness_id: support().id,
    trigger_type: "schedule", is_active: true, identity: { api_key_id: null, version: 1 }, required_solutions: [], loop: { iterations: 1 } });
  const { client, call } = await mcp();
  try {
    expect(await call("loop_start", { trigger: "draft-loop" })).toMatchObject({ run_id: expect.any(String), approval: { source: "yolo" } });
    expect(await call("loop_start", { trigger: "draft-loop", confirm: "000000000000" })).toMatchObject({ token_mismatch: true });
    expect((await call("loop_start", { trigger: "draft-loop", confirm: true })).error.code).toBe("confirm_token_required");
    support().status = "active";
    expect(await call("loop_start", { trigger: "draft-loop" })).toMatchObject({ started: false, needs_person: "client" });
    expect(client.asked).toHaveLength(0);
    expect(server.state.requests.filter(r => r.method === "POST" && /\/triggers\/[^/]+\/run$/.test(r.path))).toHaveLength(1);
  } finally { await client.close(); }
});
