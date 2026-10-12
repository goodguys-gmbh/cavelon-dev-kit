import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { COMMANDS } from "../src/commands/index.js";
import { createMcpServer } from "../src/mcp.js";
import type { InStream, Io } from "../src/io.js";
import { seedQueryTool } from "./fake-database.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type PersonAtClient, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let seeded: ReturnType<typeof seedQueryTool>;
beforeEach(async () => {
  server = await startFakeServer(); tenant = server.addTenant("acme"); sb = sandbox();
  server.state.features.database_connector_enabled = true;
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant,
    permissions: ["database_connectors.manage", "database_connectors.view", "database_connectors.test", "agents.view", "agents.edit", "harnesses.manage", "harnesses.view", "settings.view"] }));
  seeded = seedQueryTool(server.state.db, tenant);
});
afterEach(async () => { await server.close(); sb.cleanup(); });
const writes = () => server.state.requests.filter(r => ["PATCH", "DELETE"].includes(r.method) && r.path.includes("/queries/"));

async function mcp(person: PersonAtClient, cwd = sb.home) {
  const io: Io = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream,
    env: { ...sb.env }, cwd, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(io, COMMANDS).connect(b);
  const client = askingClient({ person }); await client.connect(a); return client;
}

describe("saved query lifecycle", () => {
  it.each(["enable", "disable", "rename", "delete"])("previews %s without mutation and sends only after confirmation", async change => {
    const args = ["db", "queries", change, seeded.query.slug, ...(change === "rename" ? ["order_lookup"] : [])];
    const preview = await cli(sb, [...args, "--json"]);
    expect(preview.code, preview.stdout).toBe(0); expect(preview.json()).toMatchObject({ sent: false, change }); expect(writes()).toEqual([]);
    const result = await cli(sb, [...args, "--confirm", "--json"]);
    expect(result.code, result.stdout).toBe(0); expect(result.json()).toMatchObject({ sent: true, next_step: expect.stringContaining("pull") });
    expect(writes()).toHaveLength(1);
    if (change === "rename") expect(seeded.query.slug).toBe("order_lookup");
    if (change === "disable") expect(seeded.query.is_enabled).toBe(false);
    if (change === "enable") expect(seeded.query.is_enabled).toBe(true);
    if (change === "delete") { expect(server.state.db.queries).toEqual([]); expect(result.json()).toHaveProperty("removed_references"); }
  });

  it("refuses an agent's self-confirmation", async () => {
    const args = ["db", "queries", "disable", seeded.query.slug, "--json"];
    const preview = await cli(sb, args, { env: { CAVELON_AGENT: "1" } });
    expect(preview.code, preview.stdout).toBe(0);
    const result = await cli(sb, [...args, "--confirm"], { env: { CAVELON_AGENT: "1" } });
    expect(result.code).toBe(5); expect(writes()).toEqual([]);
  });

  it("refuses a stale MCP query version without asking the person", async () => {
    const client = await mcp("approves");
    try {
      const preview = await client.callTool({ name: "db_query_disable", arguments: { query: seeded.query.slug } });
      const body = JSON.parse((preview.content as Array<{ text: string }>)[0]!.text) as { confirm_token: string };
      seeded.query.version++;
      const stale = await client.callTool({ name: "db_query_disable", arguments: { query: seeded.query.slug, confirm: body.confirm_token } });
      expect(JSON.parse((stale.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ sent: false, token_mismatch: true });
      expect(client.asked).toEqual([]); expect(writes()).toEqual([]);
    } finally { await client.close(); }
  });

  it.each(["version", "sql"])("refuses a query's changed %s while its approval dialog is open, before requesting an instance confirmation", async field => {
    const client = await mcp("approves");
    client.setRequestHandler(ElicitRequestSchema, async () => {
      if (field === "version") seeded.query.version++;
      else seeded.query.sql_text += " /* another editor */";
      return { action: "accept", content: { approve: true } };
    });
    try {
      const preview = await client.callTool({ name: "db_query_enable", arguments: { query: seeded.query.slug } });
      const body = JSON.parse((preview.content as Array<{ text: string }>)[0]!.text) as { confirm_token: string };
      const result = await client.callTool({ name: "db_query_enable", arguments: { query: seeded.query.slug, confirm: body.confirm_token } });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ error: { code: "token_mismatch" } });
      expect(writes()).toEqual([]);
      expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toEqual([]);
    } finally { await client.close(); }
  });

  it.each(["declines", "approves"] as const)("MCP waits for the person's %s before any guarded request", async person => {
    const client = await mcp(person);
    try {
      const preview = await client.callTool({ name: "db_query_disable", arguments: { query: seeded.query.slug } });
      const body = JSON.parse((preview.content as Array<{ text: string }>)[0]!.text) as { confirm_token: string };
      expect(writes()).toEqual([]); expect(client.asked).toEqual([]);
      expect(server.state.requests.filter(r => r.path === "/api/v1/confirmations")).toEqual([]);
      const result = await client.callTool({ name: "db_query_disable", arguments: { query: seeded.query.slug, confirm: body.confirm_token } });
      expect(client.asked).toHaveLength(1);
      expect(writes()).toHaveLength(person === "approves" ? 1 : 0);
      const confirmations = server.state.requests.filter(r => r.path === "/api/v1/confirmations");
      expect(confirmations).toHaveLength(person === "approves" ? 1 : 0);
      if (person === "approves") expect(confirmations[0]?.body).toMatchObject({ method: "PATCH", path: `/api/v1/database-connectors/queries/${seeded.query.id}`, body: { is_enabled: false } });
      expect(Boolean(result.isError)).toBe(person === "declines");
    } finally { await client.close(); }
  });
});

async function project() {
  expect((await cli(sb, ["harness", "new", "support", "--name", "Support"])).code).toBe(0);
  server.editConfig(tenant, pkg => { (pkg.tools as unknown[]).push(structuredClone(seeded.tool)); });
  const dir = path.join(sb.home, "solution"); mkdirSync(dir);
  expect((await cli(sb, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd: dir })).code).toBe(0);
  expect((await cli(sb, ["pull"], { cwd: dir })).code).toBe(0);
  const file = path.join(dir, "package", "tools.yaml");
  const tools = parse(readFileSync(file, "utf8")) as Array<Record<string, any>>;
  return { dir, file, tools, query: tools.find(t => t.slug === seeded.query.slug)!.database_query as Record<string, any> };
}

describe("unsaved query tests", () => {
  it("accepts the draft flag through MCP and sends the same unsaved definition", async () => {
    const p = await project(); p.query.sql_text += " /* MCP draft */"; writeFileSync(p.file, stringify(p.tools));
    const client = await mcp("declines", p.dir);
    try {
      const result = await client.callTool({ name: "db_test_run", arguments: { query: seeded.query.slug, draft: true, value: ["order_no=A-10023", "email=ada@example.com"] } });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ query: { draft: true } });
      expect(server.state.requests.find(r => r.path.endsWith("/queries/test-run"))?.body).toMatchObject({ sql_text: p.query.sql_text });
      expect(client.asked).toEqual([]); expect(writes()).toEqual([]);
    } finally { await client.close(); }
  });

  it("validates and tests edited SQL without applying or changing the saved query", async () => {
    const p = await project(); p.query.sql_text += " /* edited draft */"; writeFileSync(p.file, stringify(p.tools));
    const before = structuredClone(seeded.query);
    const result = await cli(sb, ["db", "test-run", seeded.query.slug, "--draft", "--value", "order_no=A-10023", "--value", "email=ada@example.com", "--json"], { cwd: p.dir });
    expect(result.code, result.stdout).toBe(0); expect(result.json()).toMatchObject({ query: { slug: seeded.query.slug, draft: true }, rows: [["shipped"]] });
    const request = server.state.requests.find(r => r.path === "/api/v1/database-connectors/queries/test-run");
    expect(request?.body).toMatchObject({ connection_id: seeded.connection.id, sql_text: p.query.sql_text, values: { order_no: "A-10023", email: "ada@example.com" } });
    expect(request?.body).not.toHaveProperty("requires_confirmation");
    expect(seeded.query).toEqual(before); expect(writes()).toEqual([]); expect(server.state.db.testRuns).toEqual([]);
  });

  it("does not run an invalid draft and explains an API key refusal", async () => {
    const p = await project(); p.query.sql_text = "SELECT :undeclared"; writeFileSync(p.file, stringify(p.tools));
    expect((await cli(sb, ["db", "test-run", seeded.query.slug, "--draft", "--json"], { cwd: p.dir })).code).toBe(3);
    expect(server.state.requests.filter(r => r.path.endsWith("/queries/test-run"))).toEqual([]);
    await login(sb, server.url, server.addToken({ kind: "key", tenantIds: [tenant], defaultTenant: tenant, scopes: ["admin"] }));
    const key = await cli(sb, ["db", "test-run", seeded.query.slug, "--draft", "--json"], { cwd: p.dir });
    expect(key.code).toBe(5); expect(key.stdout).toContain("Owner's personal access token");
  });

  it("reports write rollback evidence and never retries an ambiguous draft write", async () => {
    const p = await project();
    p.query.kind = "write"; p.query.sql_text = "UPDATE orders SET status = 'done' WHERE number = :order_no AND email = :email";
    p.query.max_affected_rows = 1; writeFileSync(p.file, stringify(p.tools));
    const args = ["db", "test-run", seeded.query.slug, "--draft", "--value", "order_no=A-10023", "--value", "email=ada@example.com", "--json"];
    const result = await cli(sb, args, { cwd: p.dir });
    expect(result.code, result.stdout).toBe(0); expect(result.json()).toMatchObject({ kind: "write", affected_rows: 1, dry_run: true, rolled_back: true, committed: false });
    server.state.db.draftResult = { outcome: "error", error_code: "write_outcome_unknown", model_text: "unknown", duration_ms: 10 };
    const uncertain = await cli(sb, args.filter(a => a !== "--json"), { cwd: p.dir });
    expect(uncertain.code).toBe(3);
    expect(server.state.requests.filter(r => r.path.endsWith("/queries/test-run"))).toHaveLength(2);
    expect(uncertain.stdout).toContain("Do not retry");
  });
});
