import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let reader: string;
let harness: string;
const readerPermissions = ["knowledge_bases.view", "end_users.read"];
const commands = [["chat", "My orders", "--harness", "support"], ["test", "run", "--suite", "Smoke"]];

beforeEach(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("test");
  sb = sandbox();
  sb.env.SHELL = "/bin/sh";
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
  harness = server.state.harnesses.find((h) => h.tenant_id === tenant && h.slug === "support")!.id;
  reader = randomUUID();
  server.state.chatUsers.push({ id: reader, tenant_id: tenant, email: "reader@example.com", email_verified: true });
  for (const name of ["Smoke", "Other"]) server.state.suites.push({
    id: randomUUID(), tenant_id: tenant, name, harness_id: harness, archived_at: null,
    settings: { reader_mode: "audience", auto_evaluate: false },
  });
  server.state.requests.length = 0;
});

afterEach(async () => {
  sb.cleanup();
  await server.close();
});

function sentRuns() {
  return server.state.requests.filter((r) => r.method === "POST" && /\/test-suites\/[^/]+\/runs$/.test(r.path));
}

async function withPermissions(permissions: string[]) {
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant, permissions }));
  server.state.requests.length = 0;
}

describe("chosen Chat User readers", () => {
  it("sends the PAT chat reader with the message and carries it in the continuation", async () => {
    const result = await cli(sb, [...commands[0]!, "--as-chat-user", reader, "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(server.state.requests.find((r) => r.path === "/api/v1/chat")!.body).toEqual({
      message: "My orders", stream: false, harness_id: harness, reader_mode: "as_chat_user", reader_chat_user_id: reader,
    });
    const data = result.json<{ session_id: string; next: { continue: string } }>();
    expect(data.next.continue).toContain(`--as-chat-user ${reader}`);
    expect(data.next.continue).toContain(`--harness support`);
    const next = await cli(sb, ["chat", "More", "--harness", "support", "--session", data.session_id, "--as-chat-user", reader]);
    expect(next.code, next.stderr).toBe(0);
    expect(next.stdout).toContain(reader);
    expect(server.state.requests.filter((r) => r.path === "/api/v1/chat").pop()!.body).toMatchObject({ session_id: data.session_id, reader_chat_user_id: reader });
  });

  it("puts the override on every run request and never edits the saved suites", async () => {
    const saved = structuredClone(server.state.suites);
    const result = await cli(sb, ["test", "run", "--harness", "support", "--as-chat-user", reader, "--idempotency-key", "readers", "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(sentRuns()).toHaveLength(2);
    for (const sent of sentRuns()) {
      expect(sent.body).toEqual({ harness_id: harness, reader_mode: "as_chat_user", reader_chat_user_id: reader });
      expect(sent.headers["idempotency-key"]).toMatch(/^readers:/);
    }
    expect(server.state.suites).toEqual(saved);
    expect(server.state.requests.filter((r) => ["PUT", "PATCH", "DELETE"].includes(r.method))).toEqual([]);
    expect(result.json()).toMatchObject({ reader_mode: "as_chat_user", reader_chat_user_id: reader });
  });

  it("keeps the selected reader in the bounded wait result", async () => {
    const result = await cli(sb, [...commands[1]!, "--as-chat-user", reader, "--wait", "--timeout", "2s", "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.json()).toMatchObject({ reader_mode: "as_chat_user", reader_chat_user_id: reader });
    expect(sentRuns()).toHaveLength(1);
  });

  it("leaves a suite's saved reader in effect when no override is requested", async () => {
    const suite = server.state.suites[0]!;
    suite.settings = { reader_mode: "as_chat_user", reader_chat_user_id: reader };
    const saved = structuredClone(suite);
    const result = await cli(sb, [...commands[1]!, "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(sentRuns().pop()!.body).toEqual({});
    expect(suite).toEqual(saved);
  });

  it.each(commands)("preserves the payload without reader selection: %s", async (...args) => {
    const result = await cli(sb, [...args, "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const sent = server.state.requests.find((r) => r.method === "POST")!;
    expect(sent.body).not.toHaveProperty("reader_mode");
    expect(sent.body).not.toHaveProperty("reader_chat_user_id");
    expect(result.json()).not.toHaveProperty("reader_mode");
  });

  it.each(readerPermissions)("refuses a published missing %s permission before sending chat or runs", async (missing) => {
    await withPermissions(["playground.use", ...readerPermissions.filter((p) => p !== missing)]);
    for (const command of commands) {
      const result = await cli(sb, [...command, "--as-chat-user", reader, "--json"]);
      expect(result.code).toBe(7);
      expect(result.json()).toMatchObject({ error: { code: "chat_user_reader_forbidden", details: { missing_permissions: [missing], sent: false } } });
      expect(result.stdout).toContain(missing);
      expect(result.stdout).toContain("whoami");
    }
    expect(server.state.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("refuses a tenant API key on chat and preserves normal default chat", async () => {
    const h = server.state.harnesses.find((h) => h.id === harness)!;
    [h.status, h.is_default] = ["active", true];
    await login(sb, server.url, server.addToken({ kind: "key", tenantIds: [tenant], defaultTenant: tenant }), ["--tenant", tenant]);
    server.state.requests.length = 0;
    const refused = await cli(sb, ["chat", "My orders", "--as-chat-user", reader, "--json"]);
    expect(refused.code).toBe(7);
    expect(refused.stdout).toContain("personal access token");
    expect(server.state.requests.filter((r) => r.path === "/api/v1/chat")).toEqual([]);
    const ordinary = await cli(sb, ["chat", "Hello", "--json"]);
    expect(ordinary.code, ordinary.stderr).toBe(0);
    expect(server.state.requests.filter((r) => r.path === "/api/v1/chat").pop()!.body).toEqual({ message: "Hello", stream: false });
  });

  it("uses the published test-run permissions for an API key too", async () => {
    await login(sb, server.url, server.addToken({ kind: "key", tenantIds: [tenant], defaultTenant: tenant, permissions: ["playground.use", ...readerPermissions] }), ["--tenant", tenant]);
    const result = await cli(sb, [...commands[1]!, "--as-chat-user", reader, "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(sentRuns().pop()!.body).toMatchObject({ reader_chat_user_id: reader });
  });

  it.each(["unknown", "deleted", "cross-tenant"])("keeps an actionable server refusal for a %s reader", async (kind) => {
    if (kind === "unknown") reader = randomUUID();
    if (kind === "deleted") server.state.chatUsers.length = 0;
    if (kind === "cross-tenant") server.state.chatUsers[0]!.tenant_id = server.addTenant("other");
    for (const command of commands) {
      const result = await cli(sb, [...command, "--as-chat-user", reader, "--json"]);
      expect(result.code).toBe(3);
      expect(result.json()).toMatchObject({ error: { status: 422 } });
      expect(result.stdout).toContain("list_chat_users");
      expect(result.stdout).toContain("tenant");
    }
    expect(server.state.chats).toEqual([]);
    expect(server.state.runs).toEqual([]);
  });

  it("preserves a revoked reader's server code and suggests choosing a current identity", async () => {
    server.state.failures.push({ method: "POST", path: /^\/api\/v1\/chat$/, status: 403, code: "reader_revoked", detail: "The selected Chat User reader has been revoked." });
    const result = await cli(sb, [...commands[0]!, "--as-chat-user", reader, "--json"]);
    expect(result.code).toBe(7);
    expect(result.json()).toMatchObject({ error: { code: "reader_revoked", status: 403 } });
    expect(result.stdout).toContain("list_chat_users");
    expect(server.state.chats).toEqual([]);
  });

  it("keeps older instances' PAT refusal actionable even when they publish reader fields", async () => {
    server.state.failures.push({ method: "POST", path: /^\/api\/v1\/(chat|test-suites\/[^/]+\/runs)$/, status: 403, detail: "Only an operator test surface may choose its reader; omit reader_mode." });
    for (const command of commands) {
      const result = await cli(sb, [...command, "--as-chat-user", reader, "--json"]);
      expect(result.code).toBe(7);
      expect(result.stdout).toContain("older instance");
      expect(result.stdout).toContain("personal access token");
    }
    expect(server.state.chats).toEqual([]);
    expect(server.state.runs).toEqual([]);
  });

  it("refuses revoked credentials without falling back to another reader", async () => {
    server.state.tokens.clear();
    for (const command of commands) expect((await cli(sb, [...command, "--as-chat-user", reader, "--json"])).code).toBe(7);
    expect(server.state.chats).toEqual([]);
    expect(server.state.runs).toEqual([]);
  });

  it.each(["not-a-uuid", " "])("rejects an invalid reader id %j without sending", async (id) => {
    for (const command of commands) {
      const result = await cli(sb, [...command, "--as-chat-user", id, "--json"]);
      expect([2, 3]).toContain(result.code);
      expect(result.stdout).toContain("Chat User");
    }
    expect(server.state.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  it.each([true, false])("lets the server decide where principal permissions are unpublished (principal available: %s)", async (servePrincipal) => {
    server.state.servePrincipal = servePrincipal;
    server.state.servePermissions = false;
    for (const command of commands) {
      const result = await cli(sb, [...command, "--as-chat-user", reader, "--json"]);
      expect(result.code, result.stderr + result.stdout).toBe(0);
    }
    await withPermissions(["playground.use", "knowledge_bases.view"]);
    const refused = await cli(sb, [...commands[1]!, "--as-chat-user", reader, "--json"]);
    expect(refused.code).toBe(7);
    expect(refused.stdout).toContain("end_users.read");
  });

  it.each([true, false])("refuses unsupported selection while keeping ordinary calls (OpenAPI available: %s)", async (serveOpenapi) => {
    server.state.serveOpenapi = serveOpenapi;
    server.state.readerOverrides = false;
    rmSync(sb.env.CAVELON_CACHE_DIR!, { recursive: true, force: true });
    for (const command of commands) {
      const refused = await cli(sb, [...command, "--as-chat-user", reader, "--json"]);
      expect(refused.code).toBe(1);
      expect(refused.json()).toMatchObject({ error: { code: "operation_unavailable", details: { sent: false } } });
      expect(refused.stdout).toContain("older");
    }
    expect(server.state.requests.filter((r) => r.method === "POST")).toEqual([]);
    for (const command of commands) expect((await cli(sb, command)).code).toBe(0);
  });

  it("shows the published email verification flag when choosing identities, without deriving it on older instances", async () => {
    server.state.chatUsers.push({ id: randomUUID(), tenant_id: tenant, email: "unverified@example.com", email_verified: false });
    const command = ["api", "list_chat_users", "-p", `tenant_id=${tenant}`];
    const listed = await cli(sb, [...command, "--json"]);
    expect(listed.code, listed.stderr + listed.stdout).toBe(0);
    expect(listed.json<{ items: unknown[] }>().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: "reader@example.com", email_verified: true }),
      expect.objectContaining({ email: "unverified@example.com", email_verified: false }),
    ]));
    expect((await cli(sb, command)).stdout).toContain('"email_verified": false');
    server.state.chatUserEmailVerified = false;
    const older = await cli(sb, [...command, "--json"]);
    expect(older.code, older.stderr).toBe(0);
    expect(older.json<{ items: Record<string, unknown>[] }>().items.every((u) => !("email_verified" in u))).toBe(true);
  });

  it("exposes the reader selection in both MCP tools and sends their requests", async () => {
    const mcp = createMcpServer({
      stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream,
      env: sb.env, cwd: sb.home, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }, COMMANDS);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = askingClient();
    try {
      await mcp.connect(serverSide);
      await client.connect(clientSide);
      const tools = await client.listTools();
      for (const name of ["chat", "test_run"]) expect(tools.tools.find((t) => t.name === name)!.inputSchema.properties).toHaveProperty("as_chat_user");
      for (const [name, args] of [["chat", { message: "My orders", harness: "support" }], ["test_run", { suite: ["Smoke"] }]] as const) {
        const result = await client.callTool({ name, arguments: { ...args, as_chat_user: reader } });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      }
      expect(server.state.requests.filter((r) => r.method === "POST").every((r) => (r.body as Record<string, unknown>).reader_chat_user_id === reader)).toBe(true);
    } finally {
      await client.close();
    }
  });
});
