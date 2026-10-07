import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessOf, operationAccess } from "../src/access.js";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer, toolFor } from "../src/mcp.js";
import type { MetaPrincipal } from "../src/principal.js";
import { seedQueryTool } from "./fake-database.js";
import { startFakeServer, type FakeServer, type TokenInfo } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type Sandbox } from "./helpers.js";

const queryPath = "/api/v1/database-connectors/queries/{query_id}/test-run";
const runPath = "/api/v1/test-suites/{suite_id}/runs";
const queryRestriction = { operation: null, method: "POST", path: queryPath, reason: "Tests a query with an end_user.* parameter" };
const runRestriction = { operation: null, method: "POST", path: runPath, reason: "Chooses reader_mode: as_chat_user" };
const restrictions = [queryRestriction, runRestriction];
let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let reader: string;
let suite: string;
let query: ReturnType<typeof seedQueryTool>["query"];

beforeEach(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("test");
  sb = sandbox();
  sb.env.SHELL = "/bin/sh";
  server.state.features.database_connector_enabled = true;
  server.state.serveConditionalPersonAccess = true;
  await credential("pat");
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
  const harness = server.state.harnesses.find(h => h.tenant_id === tenant)!;
  reader = randomUUID();
  suite = randomUUID();
  server.state.chatUsers.push({ id: reader, tenant_id: tenant, email: "reader@example.com", email_verified: true });
  server.state.suites.push({ id: suite, tenant_id: tenant, name: "Smoke", harness_id: harness.id, archived_at: null, settings: { reader_mode: "as_chat_user", reader_chat_user_id: reader } });
  query = seedQueryTool(server.state.db, tenant).query;
  await credential("key");
});

afterEach(async () => {
  sb.cleanup();
  await server.close();
});

async function credential(kind: "key" | "pat", published: unknown = kind === "key" ? restrictions : []) {
  await login(sb, server.url, server.addToken({ kind, tenantIds: [tenant], defaultTenant: tenant, needsAPersonWhen: published } satisfies TokenInfo), kind === "key" ? ["--tenant", tenant] : []);
  server.state.requests.length = 0;
}

const sent = () => server.state.requests.filter(r => r.method === "POST" && (r.path.endsWith("/test-run") || r.path === `/api/v1/test-suites/${suite}/runs`));
const queryCommand = () => ["db", "test-run", query.slug, "--value", "order_no=A-10023", "--value", "email=reader@example.com", "--json"];
const runCommand = () => ["test", "run", "--suite", "Smoke", "--as-chat-user", reader, "--json"];

async function mcpCall(name: string, args: Record<string, unknown>) {
  const stdin = Readable.from([]) as unknown as InStream;
  stdin.isTTY = false;
  const mcp = createMcpServer({
    stdout: { write: () => true }, stderr: { write: () => true }, stdin,
    env: sb.env, cwd: sb.home, now: () => new Date(), sleep: async () => {},
  }, COMMANDS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = askingClient();
  try {
    await mcp.connect(serverSide);
    await client.connect(clientSide);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await mcp.close();
  }
}

describe("conditional identity restrictions", () => {
  it.each(["query", "reader"])("CLI refuses the known %s case before its outbound execution request", async kind => {
    const result = await cli(sb, kind === "query" ? queryCommand() : runCommand());
    expect(result.code).toBe(5);
    expect(result.json()).toMatchObject({ error: { code: "key_needs_a_person", details: { sent: false, needs_a_person_when: true, reason: restrictions[kind === "query" ? 0 : 1]!.reason } } });
    expect(result.stdout).toContain("personal access token");
    expect(sent()).toEqual([]);
  });

  it.each(["query", "reader"])("MCP refuses the known %s case before its outbound execution request", async kind => {
    const result = await mcpCall(kind === "query" ? "db_test_run" : "test_run", kind === "query" ? { query: query.slug, value: ["order_no=A-10023", "email=reader@example.com"] } : { suite: ["Smoke"], as_chat_user: reader });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("key_needs_a_person");
    expect(JSON.stringify(result)).toContain("personal access token");
    expect(sent()).toEqual([]);
  });

  it.each(["CLI", "MCP"])("allows ordinary query tests and a suite whose reader a person saved through %s", async mode => {
    query.parameters = query.parameters.filter(p => p.source === "model");
    const saved = structuredClone(server.state.suites[0]);
    if (mode === "CLI") {
      for (const args of [["db", "test-run", query.slug, "--value", "order_no=A-10023", "--json"], ["test", "run", "--suite", "Smoke", "--json"]]) {
        const result = await cli(sb, args);
        expect(result.code, result.stderr + result.stdout).toBe(0);
      }
    } else {
      for (const [name, args] of [["db_test_run", { query: query.slug, value: ["order_no=A-10023"] }], ["test_run", { suite: ["Smoke"] }]] as const) {
        const result = await mcpCall(name, args);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
    }
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.body).toEqual({});
    expect(server.state.suites[0]).toEqual(saved);
  });

  it.each(["CLI", "MCP"])("keeps PAT identity choices available through %s", async mode => {
    await credential("pat", restrictions);
    if (mode === "CLI") {
      for (const args of [queryCommand(), runCommand()]) {
        const result = await cli(sb, args);
        expect(result.code, result.stderr + result.stdout).toBe(0);
      }
    } else {
      for (const [name, args] of [["db_test_run", { query: query.slug, value: ["order_no=A-10023", "email=reader@example.com"] }], ["test_run", { suite: ["Smoke"], as_chat_user: reader }]] as const) {
        const result = await mcpCall(name, args);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
    }
    expect(sent()).toHaveLength(2);
  });

  it.each(["omitted", "empty", "unmatched", "without principal"])("leaves dedicated identity choices to the server when restrictions are %s", async mode => {
    if (mode === "omitted") server.state.serveConditionalPersonAccess = false;
    if (mode === "without principal") server.state.servePrincipal = false;
    if (mode === "empty") await credential("key", []);
    if (mode === "unmatched") await credential("key", restrictions.map(r => ({ ...r, method: "PUT" })));
    for (const args of [queryCommand(), runCommand()]) {
      const result = await cli(sb, args);
      expect(result.code, result.stderr + result.stdout).toBe(0);
    }
    for (const [name, args] of [["db_test_run", { query: query.slug, value: ["order_no=A-10023", "email=reader@example.com"] }], ["test_run", { suite: ["Smoke"], as_chat_user: reader }]] as const) {
      const result = await mcpCall(name, args);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    }
    expect(sent()).toHaveLength(4);
  });

  it("keeps changed reason text advisory while the known input decides the refusal", async () => {
    const reason = "Future wording without any identity keywords";
    await credential("key", restrictions.map(r => ({ ...r, reason })));
    for (const args of [queryCommand(), runCommand()]) {
      const result = await cli(sb, args);
      expect(result.code).toBe(5);
      expect(result.json()).toMatchObject({ error: { details: { reason } } });
    }
    expect(sent()).toEqual([]);
    query.parameters = query.parameters.filter(p => p.source === "model");
    const ordinary = await cli(sb, ["db", "test-run", query.slug, "--value", "order_no=A-10023"]);
    expect(ordinary.code, ordinary.stderr + ordinary.stdout).toBe(0);
  });

  it("keeps conditional metadata independent of an omitted unconditional list", async () => {
    server.state.serveCredentialAccess = false;
    for (const args of [queryCommand(), runCommand()]) {
      expect((await cli(sb, args)).code).toBe(5);
    }
    expect(sent()).toEqual([]);
  });

  it("shows MCP conditional advice without marking the whole dedicated tool unavailable", async () => {
    const principal = { kind: "api_key", mode: "tenant", permissions: ["database_connectors.test", "playground.use"], needs_a_person: [], needs_a_person_when: restrictions, api_key: null } as unknown as MetaPrincipal;
    for (const name of ["db_test_run", "test_run"]) {
      const tool = toolFor(COMMANDS.find(c => c.mcpTool === name)!, COMMANDS, accessOf(principal));
      expect(tool.description).toContain("Needs a person only when");
      expect(tool.description).not.toMatch(/^Not for this credential/);
    }
    const who = await mcpCall("whoami", {});
    expect(JSON.stringify(who)).toContain("needs_a_person_when");
    const description = await mcpCall("api_describe", { operation: "start_run" });
    expect(JSON.stringify(description)).toContain(runRestriction.reason);
  });

  it.each(["end_user.id", "end_user.external_subject", "end_user.email", "end_user.future_field"])("detects published %s parameter sources regardless of supplied values", async source => {
    query.parameters[1]!.source = source;
    const result = await cli(sb, ["db", "test-run", query.slug, "--json"]);
    expect(result.code).toBe(5);
    expect(sent()).toEqual([]);
  });

  it("shows the conditional list separately in whoami and usable API discovery/description", async () => {
    const who = await cli(sb, ["whoami", "--json"]);
    expect(who.json()).toMatchObject({ credential: { needs_a_person_when: restrictions } });
    const text = await cli(sb, ["whoami"]);
    expect(text.stdout).toContain("needs a person when");
    expect(text.stdout).toContain(runRestriction.reason);
    const listed = await cli(sb, ["api", "list", "--usable", "--limit", "0", "--json"]);
    const items = listed.json<{ items: Array<{ path: string; method: string; operation: string; needs_a_person_when: string | null; needs_a_person: string | null; may_send: boolean | null }> }>().items;
    for (const r of restrictions) {
      const item = items.find(i => i.path === r.path && i.method === r.method)!;
      expect(item).toMatchObject({ needs_a_person_when: r.reason, needs_a_person: null });
      expect(item.may_send).not.toBe(false);
      const description = await cli(sb, ["api", "describe", item.operation, "--json"]);
      expect(description.json()).toMatchObject({ needs_a_person_when: r.reason });
      expect((await cli(sb, ["api", "describe", item.operation])).stdout).toContain(r.reason);
    }
    expect((await cli(sb, ["api", "list", "--search", "test-run"])).stdout).toContain(queryRestriction.reason);
  });

  it("unknown conditional operations remain advisory and unrestricted generic requests still send", async () => {
    const unknown = { ...runRestriction, path: "/api/v1/test-suites", method: "GET", reason: "Future identity choice" };
    await credential("key", [...restrictions, unknown]);
    const doc = await cli(sb, ["api", "describe", "list_suites", "--json"]);
    expect(doc.json()).toMatchObject({ needs_a_person_when: unknown.reason });
    const read = await cli(sb, ["api", "list_suites", "--json"]);
    expect(read.code, read.stderr + read.stdout).toBe(0);
    const run = await cli(sb, ["api", "start_run", "-p", `suite_id=${suite}`, "--body", '{"reader_mode":"unrestricted"}', "--json"]);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(sent().pop()!.body).toEqual({ reader_mode: "unrestricted" });
  });

  it("sanitizes the optional list without leaking malformed entries into whoami or access", async () => {
    await credential("key", [null, 42, [], {}, { ...runRestriction, method: 2 }, { ...runRestriction, method: "CONNECT" }, { ...runRestriction, path: "bad" }, { ...runRestriction, reason: {} }, { ...runRestriction, operation: 8 }, { ...runRestriction, method: "post", extra: "discard" }]);
    const who = await cli(sb, ["whoami", "--json"]);
    expect(who.json()).toMatchObject({ credential: { needs_a_person_when: [runRestriction] } });
  });

  it("does not turn unknown overlapping path templates into dedicated-command authority", async () => {
    await credential("key", restrictions.map(r => ({ ...r, path: r.path.replace(/\/(?:test-run|runs)$/, "/{action}") })));
    for (const args of [queryCommand(), runCommand()]) {
      const result = await cli(sb, args);
      expect(result.code, result.stderr + result.stdout).toBe(0);
    }
    for (const [name, args] of [["db_test_run", { query: query.slug, value: ["order_no=A-10023", "email=reader@example.com"] }], ["test_run", { suite: ["Smoke"], as_chat_user: reader }]] as const) {
      const result = await mcpCall(name, args);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    }
    expect(sent()).toHaveLength(4);
  });

  it.each([null, "bad", 3, {}])("treats malformed optional list %j as unpublished", async value => {
    await credential("key", value);
    const who = await cli(sb, ["whoami", "--json"]);
    expect(who.json()).toMatchObject({ credential: { needs_a_person_when: null } });
    expect((await cli(sb, runCommand())).code).toBe(0);
  });

  it("older principals expose an unknown conditional list and do not change unconditional refusals", async () => {
    server.state.serveConditionalPersonAccess = false;
    const who = await cli(sb, ["whoami", "--json"]);
    expect(who.json()).toMatchObject({ credential: { needs_a_person_when: null, needs_a_person: expect.arrayContaining([expect.objectContaining({ path: "/api/v1/agent-graph/import" })]) } });
  });

  it.each(["session", "personal_access_token", "api_key"] as const)("keeps unconditional operation access separate for %s", kind => {
    const principal = { kind, mode: "tenant", permissions: ["playground.use"], needs_a_person: [], needs_a_person_when: restrictions, api_key: null, token: null } as unknown as MetaPrincipal;
    expect(operationAccess(accessOf(principal), `POST ${runPath}`)).toMatchObject({ allowed: true });
  });
});
