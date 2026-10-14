import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiApproval } from "../src/api-approval-policy.js";
import { yoloAllows } from "../src/automation-policy.js";
import { api } from "../src/commands/api.js";
import { createContext } from "../src/context.js";
import type { InStream, Io } from "../src/io.js";
import type { CallArguments } from "../src/invoke.js";
import { operationAt, type Operation } from "../src/openapi.js";
import type { OpenApiDoc } from "../src/contracts.js";
import { openapiSnapshot, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

vi.mock("../src/automation-policy.js", () => ({ yoloAllows: vi.fn(async () => false) }));

const draftBody = { slug: "draft", name: "Draft" };
const resourceId = "45c9d44b-249a-4d04-bd24-76c382d8a67b";
const snapshot = JSON.parse(openapiSnapshot()) as OpenApiDoc;
const operation = (path: string, method = "POST") => operationAt(snapshot, method, path)!;

describe("known API effects", () => {
  it.each([
    ["/api/v1/harnesses", { body: draftBody }, "routine"],
    ["/api/v1/harnesses/{harness_id}/clone", { params: { harness_id: [resourceId] }, body: { slug: "copy", include_triggers: false } }, "routine"],
    ["/api/v1/agent-graph/import/preview", { body: { package: {}, mode: "replace", include_tenant_wide: true } }, "read"],
    ["/api/v1/database-connectors/connections/{connection_id}/schema", { params: { connection_id: [resourceId] }, body: { schema: "public" } }, "read"],
  ] as Array<[string, CallArguments, string]>)("classifies the restricted %s request", (path, args, expected) => {
    expect(apiApproval(operation(path), structuredClone(args))).toBe(expected);
  });

  it.each([
    ["/api/v1/harnesses", { body: { ...draftBody, settings: {} } }],
    ["/api/v1/harnesses", { body: draftBody, params: { activate: ["true"] } }],
    ["/api/v1/harnesses", { body: draftBody, headers: { "X-New-Effect": "true" } }],
    ["/api/v1/harnesses", { body: draftBody, files: [{ field: "data", path: "file" }] }],
    ["/api/v1/harnesses/{harness_id}/clone", { body: { include_triggers: "true" } }],
    ["/api/v1/harnesses/{harness_id}/clone", { body: { activate: true } }],
    ["/api/v1/harnesses/{harness_id}/clone", { params: { harness_id: ["../other"] }, body: {} }],
    ["/api/v1/agent-graph/import/preview", { body: { package: {}, commit: true } }],
    ["/api/v1/agent-graph/import/preview", { body: { package: {}, runtime_bindings: { unexpected: {} } } }],
    ["/api/v1/agent-graph/import", { body: { package: {} } }],
    ["/api/v1/database-connectors/connections/{connection_id}/schema", { body: { schema: "public", sql: "DELETE FROM orders" } }],
    ["/api/v1/database-connectors/connections/{connection_id}/schema", { params: { connection_id: [resourceId, resourceId] }, body: {} }],
    ["/api/v1/database-connectors/queries/{query_id}/test-run", { body: { values: {} } }],
    ["/api/v1/harnesses/{harness_id}/activate", { body: { force: false } }],
  ])("keeps an unproven effect on %s with a person", (path, args) => {
    expect(apiApproval(operation(path), args)).toBe("person");
  });

  it("never infers routine effects from a name, verb or missing marker", () => {
    const known = operation("/api/v1/harnesses");
    for (const op of [
      { ...known, confirmation: true }, { ...known, personOnly: { marked: true } },
      { ...known, method: "PUT" }, { ...known, path: "/api/v1/new-harnesses" },
    ] as Operation[]) expect(apiApproval(op, { body: draftBody })).toBe("person");
  });
});

let server: FakeServer;
let sb: Sandbox;

beforeAll(async () => {
  server = await startFakeServer();
  const tenant = server.addTenant("api-routine", "API routine");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  expect((await cli(sb, ["harness", "new", "source-draft"])).code).toBe(0);
});

afterAll(async () => {
  sb.cleanup();
  await server.close();
});

beforeEach(() => { vi.mocked(yoloAllows).mockResolvedValue(false); });

function context() {
  const io: Io = {
    stdout: { write: () => true }, stderr: { write: () => true },
    stdin: Readable.from([]) as unknown as InStream,
    env: sb.env, cwd: sb.home, now: () => new Date(), sleep: ms => new Promise(r => setTimeout(r, ms)),
  };
  const ctx = createContext(io, { json: true }, "mcp");
  ctx.askPerson = vi.fn(async () => "declined" as const);
  return ctx;
}

it("creates an ordinary draft with its request token without asking a person", async () => {
  const input = { positionals: { operation: "create_harness" }, options: { body: JSON.stringify({ slug: "draft-one", name: "Draft one" }) } };
  const ctx = context();
  const preview = await api.run(ctx, input);
  const data = preview.data as Record<string, unknown>;
  expect(data.sent).toBe(false);
  expect(data.needs_person).toBeUndefined();
  expect(data.confirm_token).toMatch(/^[0-9a-f]{12}$/);
  expect(ctx.askPerson).not.toHaveBeenCalled();
  const result = await api.run(ctx, { ...input, options: { ...input.options, confirm: data.confirm_token as string } });
  expect(result.data).toMatchObject({ slug: "draft-one", status: "draft" });
  expect(ctx.askPerson).not.toHaveBeenCalled();
  expect(ctx.approved).toBeUndefined();
});

it("also gives an agent's CLI a usable routine token without redirecting them to a person", async () => {
  const args = ["api", "create_harness", "--body", JSON.stringify({ slug: "cli-draft", name: "CLI draft" }), "--json"];
  const preview = await cli(sb, args, { env: { CAVELON_AGENT: "1" } });
  const data = preview.json();
  expect(data.needs_person).toBeUndefined();
  expect(data.confirm_token).toMatch(/^[0-9a-f]{12}$/);
  expect(data.confirm).toContain(`--confirm ${data.confirm_token}`);
  const done = await cli(sb, [...args, "--confirm", data.confirm_token as string], { env: { CAVELON_AGENT: "1" } });
  expect(done.code, done.stdout + done.stderr).toBe(0);
  expect(done.json()).toMatchObject({ slug: "cli-draft", status: "draft" });
});

it("sends a known import preview at once, without importing or asking a person", async () => {
  const before = server.state.requests.length;
  const ctx = context();
  await api.run(ctx, { positionals: { operation: "preview_agent_graph_package_import" }, options: { body: '{"package":{}}' } });
  expect(server.state.requests.slice(before).filter(r => r.method === "POST").map(r => r.path)).toEqual(["/api/v1/agent-graph/import/preview"]);
  expect(ctx.askPerson).not.toHaveBeenCalled();
  expect(ctx.approved).toBeUndefined();
});

it("uses scoped YOLO only for the first call of a known routine operation", async () => {
  vi.mocked(yoloAllows).mockResolvedValue(true);
  const ctx = context();
  const done = await api.run(ctx, { positionals: { operation: "create_harness" }, options: { body: '{"slug":"yolo-draft","name":"YOLO draft"}' } });
  expect(done.data).toMatchObject({ slug: "yolo-draft", status: "draft" });
  expect(ctx.askPerson).not.toHaveBeenCalled();
  expect(ctx.approved).toBeUndefined();
});

it("binds a YOLO clone to its actual source solution and falls back to a token when that scope is refused", async () => {
  const source = server.state.harnesses.find(h => h.slug === "source-draft")!;
  const ctx = context();
  const input = { positionals: { operation: "clone_harness", params: [`harness_id=${source.id}`] }, options: { body: '{"slug":"copy","name":"Copy"}' } };
  const preview = await api.run(ctx, input);
  expect(yoloAllows).toHaveBeenLastCalledWith(ctx, { id: source.id });
  expect(preview.data).toMatchObject({ sent: false, confirm_token: expect.any(String) });
  vi.mocked(yoloAllows).mockResolvedValue(true);
  const done = await api.run(ctx, input);
  expect(done.data).toMatchObject({ slug: "copy", status: "draft" });
  expect(ctx.askPerson).not.toHaveBeenCalled();
});

it.each([
  ["create_harness", '{"slug":"stale-draft","name":"Stale draft"}'],
  ["preview_agent_graph_package_import", '{"package":{}}'],
])("does not ignore stale or true confirmation on %s, even in YOLO", async (operation, body) => {
  vi.mocked(yoloAllows).mockResolvedValue(true);
  const ctx = context();
  const input = { positionals: { operation }, options: { body } };
  const before = server.state.requests.length;
  const stale = await api.run(ctx, { ...input, options: { ...input.options, confirm: "000000000000" } });
  expect(stale).toMatchObject({ data: { token_mismatch: true, sent: false }, exitCode: 4 });
  await expect(api.run(ctx, { ...input, options: { ...input.options, confirm: true } })).rejects.toMatchObject({ code: "confirm_token_required" });
  expect(server.state.requests.slice(before).filter(r => r.method === "POST")).toEqual([]);
  expect(ctx.askPerson).not.toHaveBeenCalled();
});

it("keeps shared writes and person-only operations out of YOLO", async () => {
  vi.mocked(yoloAllows).mockResolvedValue(true);
  const ctx = context();
  const input = { positionals: { operation: "set_variable", params: ["name=shared"] }, options: { body: '{"value":"new"}' } };
  const preview = await api.run(ctx, input);
  const data = preview.data as Record<string, unknown>;
  expect(data).toMatchObject({ sent: false, needs_person: "client" });
  await expect(api.run(ctx, { ...input, options: { ...input.options, confirm: data.confirm_token as string } })).rejects.toMatchObject({ code: "confirm_declined" });
  expect(ctx.askPerson).toHaveBeenCalledTimes(1);
  await expect(api.run(ctx, { positionals: { operation: "set_secret", params: ["name=token"] }, options: { body: '{"value":"secret"}' } })).rejects.toMatchObject({ code: "operation_for_a_person" });
  expect(ctx.approved).toBeUndefined();
});

it("never obtains an instance nonce if a routine operation starts requiring one", async () => {
  vi.mocked(yoloAllows).mockResolvedValue(true);
  const ctx = context();
  const client = await ctx.client();
  const original = client.fetchRaw.bind(client);
  vi.spyOn(client, "fetchRaw").mockImplementation(async (method, route, options) => method === "POST" && route === "/api/v1/harnesses"
    ? new Response(JSON.stringify({ detail: { code: "confirmation_required", message: "A bound confirmation is required." } }), { status: 428, headers: { "Content-Type": "application/json" } })
    : original(method, route, options));
  const before = server.state.requests.length;
  await expect(api.run(ctx, { positionals: { operation: "create_harness" }, options: { body: '{"slug":"new-guard","name":"New guard"}' } })).rejects.toMatchObject({ code: "confirmation_required" });
  expect(server.state.requests.slice(before).filter(r => r.path === "/api/v1/confirmations")).toEqual([]);
  expect(ctx.askPerson).not.toHaveBeenCalled();
  expect(ctx.approved).toBeUndefined();
});
