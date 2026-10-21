import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenApiDoc } from "../src/contracts.js";
import { schemaErrors } from "../src/openapi.js";
import { COMMANDS } from "../src/commands/index.js";
import type { Io, InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { previewText } from "../src/commands/solution.js";
import { openapiSnapshot, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, askingClient, type Sandbox } from "./helpers.js";
let sb: Sandbox;
let server: FakeServer;
let id: string;
let publication: Record<string, any>;
const mutations = () => server.state.requests.filter(r => r.method === "POST" && /\/(publish|rollback|discard-draft)$/.test(r.path));
beforeEach(async () => {
  sb = sandbox(); sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
  server = await startFakeServer(); const tenant = server.addTenant("acme");
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: true }));
  id = randomUUID();
  server.state.harnesses.push({ id, tenant_id: tenant, slug: "support", name: "Support", status: "active", is_default: false, memory_config: {}, settings: {} });
  publication = { published_version: 3, draft_revision: 5, has_draft: true, draft_change_count: 1, changes: [{ entity: "node", id: "node-1", name: "Answer", action: "changed" }], readiness: { harness_id: id, status: "active", ready_to_activate: null, blockers: [], warnings: [], checks: [] }, waiting_runs_affected: 1, review_run_ids: ["00000000-0000-4000-8000-000000000001"], waiting_runs: [{ id: "00000000-0000-4000-8000-000000000001", node_ref: { kind: "node", id: "node-1" }, node_name: "Approval" }], published_snapshots: [{ id: "00000000-0000-4000-8000-000000000002", version: 2, label: "published v2", created_at: "2026-10-20T01:00:00Z" }], activation_override: null, can_rollback: true };
  server.state.publications.set(id, publication);
});
afterEach(async () => { sb.cleanup(); await server.close(); });
it("reads publication and previews live changes even with YOLO, without a mutation", async () => {
  const read = await cli(sb, ["harness", "publication", "support", "--json"]);
  expect(read.code, read.stderr).toBe(0); expect(read.json()).toMatchObject({ published_version: 3, has_draft: true });
  expect(schemaErrors(JSON.parse(openapiSnapshot()) as OpenApiDoc, { $ref: "#/components/schemas/HarnessPublicationResponse" }, read.json())).toEqual([]);
  const preview = await cli(sb, ["publish", "--harness", "support", "--yolo", "--json"]);
  expect(preview.code, preview.stderr).toBe(0); expect(preview.json()).toMatchObject({ changed: false, publication: { waiting_runs_affected: 1 } });
  expect(mutations()).toEqual([]);
});
it("shows readiness warnings and checks before asking anyone to publish", async () => {
  publication.readiness.warnings = [{ key: "tests", label: "Solution tests", state: "warning", detail: "The last suite failed; review the trace", href: "/tests" }];
  publication.readiness.checks = [{ key: "graph", label: "Graph Check", state: "passed", detail: "All nodes are connected", href: "/graph" }];
  for (const args of [["harness", "publication", "support"], ["publish", "--harness", "support"]]) {
    const result = await cli(sb, args);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("readiness warnings");
    expect(result.stdout).toContain("Solution tests");
    expect(result.stdout).toContain("The last suite failed; review the trace");
    expect(result.stdout).toContain("Graph Check");
    expect(result.stdout).toContain("All nodes are connected");
  }
  expect(mutations()).toEqual([]);
});
it.each([true, false])("shows one publication-specific risk form and publishes only with its explicit yes (%s)", async approve => {
  publication.readiness.warnings = [{ key: "tests", label: "Solution tests", state: "warning", detail: "The last suite failed", href: "/tests" }];
  const io: Io = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); const mcp = createMcpServer(io, COMMANDS); const client = askingClient();
  const forms: Array<{ message: string; requestedSchema: unknown }> = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    if (request.params.mode === "url") throw new Error("Expected a publish form");
    forms.push(request.params);
    return { action: "accept", content: { approve } };
  });
  await mcp.connect(serverSide); await client.connect(clientSide);
  const call = async (confirm?: string) => {
    const result = await client.callTool({ name: "solution_publish", arguments: { harness: "support", ...(confirm ? { confirm } : {}) } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  try {
    const preview = await call();
    expect(forms).toEqual([]); expect(mutations()).toEqual([]);
    const result = await call(preview.confirm_token);
    expect(forms).toHaveLength(1);
    expect(forms[0]!.requestedSchema).toMatchObject({ properties: { approve: { type: "boolean", title: "Publish this solution", description: expect.stringContaining("remaining warnings") } }, required: ["approve"] });
    expect(forms[0]!.message).toContain("Support");
    expect(forms[0]!.message).toContain(server.url);
    expect(forms[0]!.message).toContain("revision 5");
    expect(forms[0]!.message).toContain("The last suite failed");
    expect(forms[0]!.message).toContain("live traffic");
    expect(forms[0]!.message).toContain("accept any remaining warnings");
    expect(forms[0]!.message).toContain("00000000-0000-4000-8000-000000000001");
    expect(mutations()).toHaveLength(approve ? 1 : 0);
    expect(result).toMatchObject(approve ? { changed: true } : { error: { code: "confirm_declined" } });
  } finally { await client.close(); await mcp.close(); }
});
it.each(["warnings", "checks"])("requires a fresh review when readiness %s change, even at the same draft revision", async field => {
  publication.readiness[field] = [{ key: "tests", label: "Tests", state: "warning", detail: "No recent tests", href: "/tests" }];
  const io: Io = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); const mcp = createMcpServer(io, COMMANDS); const client = askingClient();
  await mcp.connect(serverSide); await client.connect(clientSide);
  const call = async (confirm?: string) => {
    const result = await client.callTool({ name: "solution_publish", arguments: { harness: "support", ...(confirm ? { confirm } : {}) } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  try {
    const preview = await call();
    publication.readiness[field][0].detail = "The latest suite failed";
    expect(await call(preview.confirm_token)).toMatchObject({ changed: false, token_mismatch: true, exit_code: 4 });
    expect(client.asked).toEqual([]); expect(mutations()).toEqual([]);
    expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toEqual([]);
  } finally { await client.close(); await mcp.close(); }
});
it("allows older publication reports without optional warnings or checks", async () => {
  delete publication.readiness.warnings; delete publication.readiness.checks;
  const preview = await cli(sb, ["publish", "--harness", "support"]);
  expect(preview.code, preview.stderr).toBe(0); expect(preview.stdout).toContain("not reported");
  expect((await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"])).json()).toMatchObject({ changed: true });
});
it.each(["warnings", "checks"])("refuses malformed readiness %s instead of hiding findings", async field => {
  publication.readiness[field] = { detail: "Not a usable review" };
  const result = await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"]);
  expect(result.code).not.toBe(0); expect(result.stdout).toContain("publication_state_unknown");
  expect(mutations()).toEqual([]);
});
it("does not publish if the review changes while the person is reading the form", async () => {
  const io: Io = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); const mcp = createMcpServer(io, COMMANDS); const client = askingClient();
  let forms = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    forms++;
    publication.readiness.warnings.push({ key: "tests", label: "Tests", state: "warning", detail: "A new suite failed while the form was open", href: "/tests" });
    return { action: "accept", content: { approve: true } };
  });
  await mcp.connect(serverSide); await client.connect(clientSide);
  const call = async (confirm?: string) => {
    const result = await client.callTool({ name: "solution_publish", arguments: { harness: "support", ...(confirm ? { confirm } : {}) } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  try {
    const preview = await call();
    expect(await call(preview.confirm_token)).toMatchObject({ error: { code: "publication_review_changed" } });
    expect(forms).toBe(1); expect(mutations()).toEqual([]);
    expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toEqual([]);
  } finally { await client.close(); await mcp.close(); }
});
it("publishes the reviewed version/revision and waiting set after a person's terminal confirmation", async () => {
  const result = await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"]);
  expect(result.code, result.stderr).toBe(0); expect(result.json()).toMatchObject({ changed: true, result: { published_version: 4, has_draft: false } });
  expect(mutations()).toMatchObject([{ body: { expected_version: 3, expected_draft_revision: 5, expected_waiting_run_ids: ["00000000-0000-4000-8000-000000000001"], confirm_affected_runs: true } }]);
  expect(mutations()[0]!.body).not.toHaveProperty("force");
  const confirmations = server.state.requests.filter(r => r.path === "/api/v1/confirmations");
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]!.body).toMatchObject({ method: "POST", path: `/api/v1/harnesses/${id}/publish`, body: mutations()[0]!.body });
  expect(schemaErrors(JSON.parse(openapiSnapshot()) as OpenApiDoc, { $ref: "#/components/schemas/HarnessPublicationMutationResponse" }, result.json<{ result: unknown }>().result)).toEqual([]);
});
it("blocks readiness, unknown state and duplicate publication without mutation", async () => {
  publication.readiness.blockers = [{ key: "graph", state: "blocked", detail: "Select the tool on Answer" }];
  const blocked = await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"]);
  expect(blocked.code).toBe(3); expect(blocked.stdout).toContain("Select the tool");
  publication.readiness.blockers = []; publication.has_draft = false;
  expect((await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"])).json()).toMatchObject({ changed: false });
  delete publication.draft_revision;
  expect((await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"])).stdout).toContain("publication_state_unknown");
  expect(mutations()).toEqual([]);
});
it("keeps older instances unavailable and preserves server stale/permission refusals", async () => {
  server.state.openapiWithout.push("GET /api/v1/harnesses/{harness_id}/publication");
  expect((await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"])).stdout).toContain("operation_unavailable");
  expect(mutations()).toEqual([]); server.state.openapiWithout = [];
  for (const status of [403, 409]) {
    server.state.failures = [{ method: "POST", path: /\/publish$/, status, code: status === 409 ? "publication_changed" : "forbidden", detail: "Review denied" }];
    const result = await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"]);
    expect(result.code).not.toBe(0); expect(publication.published_version).toBe(3);
  }
});
it("reviews a pinned rollback and protects the draft revision before restoring it", async () => {
  const preview = await cli(sb, ["harness", "rollback", "--harness", "support", "--json"]);
  expect(preview.code, preview.stderr).toBe(0); expect(preview.json()).toMatchObject({ changed: false, rollback_snapshot: { id: "00000000-0000-4000-8000-000000000002" } });
  expect(server.state.requests.some(r => r.path.endsWith("/publication") && r.query.get("snapshot_id") === "00000000-0000-4000-8000-000000000002")).toBe(true);
  const result = await cli(sb, ["harness", "rollback", "--harness", "support", "--confirm", "--json"]);
  expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("recovery");
  expect(mutations()).toMatchObject([{ body: { snapshot_id: "00000000-0000-4000-8000-000000000002", expected_version: 3, expected_draft_revision: 5, expected_waiting_run_ids: ["00000000-0000-4000-8000-000000000001"] } }]);
});
it("discards only after confirmation and leaves published version unchanged", async () => {
  expect((await cli(sb, ["harness", "discard-draft", "--harness", "support", "--yolo", "--json"])).json()).toMatchObject({ changed: false });
  expect(mutations()).toEqual([]);
  expect((await cli(sb, ["harness", "discard-draft", "--harness", "support", "--confirm", "--json"])).json()).toMatchObject({ changed: true, result: { published_version: 3, has_draft: false } });
});
it("labels explicit active-solution import drafts and leaves older reports unknown", () => {
  expect(previewText({ ready: true, publication: { target: "draft", published_version: 3 } })).toContain("live traffic stays on published v3");
  expect(previewText({ ready: true })).not.toContain("published v");
});
it.each(["approves", "declines"] as const)("asks a fresh MCP person, who %s; a changed revision cannot reuse the preview", async answer => {
  const io: Io = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream, env: sb.env, cwd: sb.home, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); const mcp = createMcpServer(io, COMMANDS); const client = askingClient({ person: answer });
  await mcp.connect(serverSide); await client.connect(clientSide);
  const call = async (extra: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: "solution_publish", arguments: { harness: "support", ...extra } });
    return { error: result.isError, data: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) };
  };
  try {
    publication.changes.push({ entity: "node", id: "node-2", name: "Second", action: "changed" });
    publication.readiness.warnings = [
      { key: "tests", label: "Tests", state: "warning", detail: "No recent tests", href: "/tests" },
      { key: "knowledge", label: "Knowledge", state: "warning", detail: "A source is stale", href: "/knowledge" },
    ];
    publication.readiness.checks = [...publication.readiness.warnings];
    publication.waiting_runs.push({ id: "00000000-0000-4000-8000-000000000003", node_ref: { kind: "node", id: "node-2" }, node_name: "Second approval" });
    publication.review_run_ids.push("00000000-0000-4000-8000-000000000003");
    publication.waiting_runs_affected = 2;
    const preview = await call(); expect(preview.error).not.toBe(true);
    expect(preview.data).toMatchObject({ changed: false, needs_person: "client" });
    publication.draft_revision++;
    expect((await call({ confirm: preview.data.confirm_token })).data).toMatchObject({ changed: false, token_mismatch: true, exit_code: 4 });
    expect(client.asked).toEqual([]); expect(mutations()).toEqual([]);
    expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toEqual([]);
    const fresh = await call();
    publication.changes.reverse(); publication.waiting_runs.reverse(); publication.review_run_ids.reverse();
    publication.readiness.warnings.reverse(); publication.readiness.checks.reverse();
    await call({ confirm: fresh.data.confirm_token });
    expect(client.asked).toHaveLength(1); expect(client.asked[0]).toContain("00000000-0000-4000-8000-000000000001");
    expect(mutations()).toHaveLength(answer === "approves" ? 1 : 0);
    expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toHaveLength(answer === "approves" ? 1 : 0);
  } finally { await client.close(); await mcp.close(); }
});

it("refuses a PAT without May activate before approval, while draft discard needs only manage", async () => {
  const tenant = server.state.harnesses.find(h => h.id === id)!.tenant_id;
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, mayActivate: false, permissions: ["harnesses.view", "harnesses.manage"] }));
  const refused = await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"]);
  expect(refused.code).toBe(7); expect(refused.stdout).toContain("token_activation_refused"); expect(mutations()).toEqual([]);
  expect((await cli(sb, ["harness", "discard-draft", "--harness", "support", "--confirm", "--json"])).code).toBe(0);
});

it("handles a late bound-confirmation challenge without asking the person twice", async () => {
  server.state.confirmationMarks = false;
  const result = await cli(sb, ["publish", "--harness", "support", "--confirm", "--json"]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(publication.published_version).toBe(4);
  expect(mutations()).toHaveLength(2); // The 428 is refusal, followed by the one confirmed change.
  expect(mutations()[0]!.headers["x-cavelon-confirmation"]).toBeUndefined();
  expect(mutations()[1]!.headers["x-cavelon-confirmation"]).toBeTruthy();
  expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toHaveLength(1);
});
