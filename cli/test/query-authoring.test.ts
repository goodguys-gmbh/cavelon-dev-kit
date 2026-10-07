import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { COMMANDS } from "../src/commands/index.js";
import type { InStream } from "../src/io.js";
import { createMcpServer } from "../src/mcp.js";
import { seedQueryTool } from "./fake-database.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { askingClient, cli, login, sandbox, type PersonAtClient, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
let seeded: ReturnType<typeof seedQueryTool>;
let serial = 0;
const IMPORT = "/api/v1/agent-graph/import";
const QUERIES = "/api/v1/database-connectors/queries";
const HEADER = "x-cavelon-confirmation";
const AGENT = { CLAUDECODE: "1" };
const requests = (method: string, route: string) => server.state.requests.filter((r) => r.method === method && r.path === route);
const nonces = () => requests("POST", "/api/v1/confirmations");
const queryPath = () => `${QUERIES}/${seeded.query.id}`;

async function pulled(home = sb): Promise<string> {
  const cwd = path.join(home.home, `solution-${++serial}`);
  mkdirSync(cwd);
  expect((await cli(home, ["init", "--instance", server.url, "--tenant", tenant, "--harness", "support"], { cwd })).code).toBe(0);
  expect((await cli(home, ["pull"], { cwd })).code).toBe(0);
  return cwd;
}

function changeQuery(cwd: string, create = false): void {
  const file = path.join(cwd, "package", "tools.yaml");
  const tools = parse(readFileSync(file, "utf8")) as Array<Record<string, any>>;
  const tool = tools.find((t) => t.slug === "order_status")!;
  if (create) tools.push({ ...structuredClone(tool), slug: "order_copy" });
  else tool.database_query.max_rows = 10;
  writeFileSync(file, stringify(tools));
}

async function mcpClient(cwd: string, person: PersonAtClient = "approves") {
  const mcp = createMcpServer({
    stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) as unknown as InStream,
    env: sb.env, cwd, now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }, COMMANDS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = askingClient({ person });
  if (person !== "cannot ask") client.setRequestHandler(ElicitRequestSchema, async (request) => {
    // Approval precedes both issuance and mutation, including when a future hook changes the request ordering.
    expect(nonces()).toEqual([]);
    expect(requests("POST", IMPORT)).toEqual([]);
    expect(server.state.requests.filter((r) => ["POST", "PATCH", "DELETE"].includes(r.method) && r.path.startsWith(QUERIES))).toEqual([]);
    client.asked.push(request.params.message);
    return person === "approves" ? { action: "accept", content: { approve: true } } : { action: "decline" };
  });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
  return {
    asked: client.asked,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return { isError: Boolean(result.isError), body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
    },
    close: () => client.close(),
  };
}

beforeAll(async () => {
  server = await startFakeServer();
  tenant = server.addTenant("acme", "Acme");
  sb = sandbox();
  sb.env.SHELL = "/bin/sh";
  sb.env.CAVELON_CONTRACT_TTL_SECONDS = "0";
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
  await cli(sb, ["harness", "new", "support", "--name", "Support"]);
});
afterAll(async () => { await server.close(); sb.cleanup(); });
beforeEach(() => {
  server.state.db.connections.length = 0;
  server.state.db.queries.length = 0;
  seeded = seedQueryTool(server.state.db, tenant);
  server.editConfig(tenant, (pkg) => {
    pkg.tools = (pkg.tools as Array<Record<string, unknown>>).filter((t) => t.tool_type !== "database_query");
    (pkg.tools as unknown[]).push(structuredClone(seeded.tool));
  });
  server.state.features.database_connector_enabled = true;
  server.state.confirmations = { enforced: true };
  server.state.previewExtras = {};
  server.state.capsPatch = {};
  server.state.servePrincipal = true;
  server.state.requests.length = 0;
});

describe("query imports", () => {
  it.each([false, true])("round-trips a permitted query change (create: %s) with the server report and a nonce after the person's confirm", async (create) => {
    const cwd = await pulled();
    changeQuery(cwd, create);
    expect((await cli(sb, ["fmt"], { cwd })).code).toBe(0);
    const validated = await cli(sb, ["validate", "--json"], { cwd });
    expect(validated.json<{ error_count: number }>().error_count).toBe(0);
    const preview = await cli(sb, ["apply", "--json"], { cwd });
    expect(preview.code, preview.stdout).toBe(0);
    const data = preview.json<Record<string, any>>();
    expect(data.database_queries).toMatchObject({ may_write_queries: true, would_write: [{ slug: create ? "order_copy" : "order_status", action: create ? "create" : "change" }] });
    expect(data.show_to_person).toBe(true);
    expect(nonces()).toEqual([]);
    expect(requests("POST", IMPORT)).toEqual([]);
    const applied = await cli(sb, ["apply", "--confirm", data.preview_id, "--json"], { cwd });
    expect(applied.code, applied.stdout).toBe(0);
    const sent = requests("POST", IMPORT);
    expect(sent).toHaveLength(1);
    expect(nonces().map((r) => r.body)).toEqual([{ method: "POST", path: IMPORT, body: sent[0]!.body }]);
    expect(server.state.requests.indexOf(nonces()[0]!)).toBeLessThan(server.state.requests.indexOf(sent[0]!));
    expect(sent[0]!.headers[HEADER]).toMatch(/^cfm_/);
    expect((await cli(sb, ["pull"], { cwd })).code).toBe(0);
    const tools = parse(readFileSync(path.join(cwd, "package", "tools.yaml"), "utf8")) as Array<Record<string, any>>;
    expect(tools.find((t) => t.slug === (create ? "order_copy" : "order_status"))!.database_query.max_rows).toBe(create ? 5 : 10);
    expect((await cli(sb, ["validate", "--json"], { cwd })).json<{ findings: Array<{ code: string }> }>().findings.filter((f) => f.code === "database_query_changed")).toEqual([]);
  });

  it("trusts the server's query-write report without a local baseline, and leaves the confirmation to a person in an agent's shell", async () => {
    const cwd = await pulled();
    changeQuery(cwd);
    rmSync(path.join(cwd, ".cavelon", "database-queries.json"));
    const preview = (await cli(sb, ["apply", "--json"], { cwd, env: AGENT })).json<Record<string, any>>();
    expect(preview).toMatchObject({ show_to_person: true, needs_person: "terminal" });
    expect(preview.confirm_token).toBeUndefined();
    expect(preview.database_queries.would_write).toEqual([{ slug: "order_status", action: "change" }]);
    const refused = await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd, env: AGENT });
    expect(refused.code).toBe(5);
    expect(refused.json<Record<string, any>>().error).toMatchObject({ code: "confirm_needs_person", details: { person_command: expect.stringContaining(`cavelon apply --confirm ${preview.preview_id}`) } });
    expect(nonces()).toEqual([]);
    expect(requests("POST", IMPORT)).toEqual([]);
    expect(seeded.query.max_rows).toBe(5);
  });

  it.each(["approves", "declines", "cannot ask"] as const)("MCP asks the person before any nonce or import: %s", async (person) => {
    const cwd = await pulled();
    changeQuery(cwd);
    const mcp = await mcpClient(cwd, person);
    try {
      const preview = await mcp.call("apply");
      expect(preview.body.show_to_person).toBe(true);
      expect(nonces()).toEqual([]);
      expect(requests("POST", IMPORT)).toEqual([]);
      const result = await mcp.call("apply", { confirm: preview.body.preview_id });
      expect(result.isError, JSON.stringify(result.body)).toBe(person !== "approves");
      expect(mcp.asked).toHaveLength(person === "cannot ask" ? 0 : 1);
      expect(nonces()).toHaveLength(person === "approves" ? 1 : 0);
      expect(requests("POST", IMPORT)).toHaveLength(person === "approves" ? 1 : 0);
      expect(seeded.query.max_rows).toBe(person === "approves" ? 10 : 5);
    } finally { await mcp.close(); }
  });

  it("refuses a PAT without manage and an API key, naming the Owner and how to apply the rest", async () => {
    for (const kind of ["pat", "key"] as const) {
      const home = sandbox();
      try {
        await login(home, server.url, server.addToken({ kind, tenantIds: [tenant], defaultTenant: tenant, permissions: ["agents.view", "harnesses.view", "agents.edit"] }));
        const cwd = await pulled(home);
        changeQuery(cwd);
        const preview = await cli(home, ["apply", "--json"], { cwd });
        expect(preview.code).toBe(3);
        expect(preview.json<Record<string, any>>().blocker_details[0]).toMatchObject({ code: "database_query_needs_superadmin", hint: expect.stringContaining("tenant Owner") });
        expect(preview.json<Record<string, any>>().database_query_hint).toMatch(/Owner.*restore.*remove its database_query/s);
        expect(nonces()).toEqual([]);
        expect(requests("POST", IMPORT)).toEqual([]);
      } finally { home.cleanup(); }
    }
  });

  it.each([undefined, []])("an unchanged definition stays unguarded with other draft edits and report %j, even when the last pull differs", async (wouldWrite) => {
    const cwd = await pulled();
    changeQuery(cwd);
    seeded.query.max_rows = 10;
    server.state.previewExtras = { database_queries: wouldWrite ? { would_write: wouldWrite } : undefined };
    const mcp = await mcpClient(cwd, "cannot ask");
    try {
      const preview = await mcp.call("apply");
      expect(preview.body.database_queries.changed).toHaveLength(1);
      expect(preview.body.show_to_person).toBe(false);
      const done = await mcp.call("apply", { confirm: preview.body.preview_id });
      expect(done.isError, JSON.stringify(done.body)).toBe(false);
      expect(mcp.asked).toEqual([]);
      expect(nonces()).toEqual([]);
      expect(requests("POST", IMPORT)[0]!.headers[HEADER]).toBeUndefined();
      expect(seeded.query.version).toBe(1);
    } finally { await mcp.close(); }
  });

  it.each([
    { impact: { active_harnesses: [{ harness_slug: "live_orders" }] }, reason: "reaches the active solution live_orders" },
    { summary: { creates: {}, updates: { tools: 1 }, deletes: { agents: 1 } }, reason: "deletes" },
  ])("retains the existing person reason $reason when the import also writes queries", async ({ reason, ...previewExtra }) => {
    const cwd = await pulled();
    changeQuery(cwd);
    server.state.previewExtras = previewExtra;
    const preview = (await cli(sb, ["apply", "--json"], { cwd })).json<Record<string, any>>();
    const stored = JSON.parse(readFileSync(path.join(cwd, ".cavelon", "previews", `${preview.preview_id}.json`), "utf8"));
    expect(stored.person_reason).toBe(reason);
    expect(preview.show_to_person).toBe(true);
    expect((await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd })).code).toBe(0);
    expect(nonces()).toHaveLength(1);
  });

  it("a no-op preview stores nothing and asks for no confirmation", async () => {
    const cwd = await pulled();
    server.state.previewExtras = { summary: { creates: {}, updates: {}, deletes: {}, references: {} }, changes: { items: [], total: 0 } };
    const preview = await cli(sb, ["apply", "--json"], { cwd, env: AGENT });
    expect(preview.json()).toMatchObject({ nothing_to_import: true });
    expect(preview.json()).not.toHaveProperty("preview_id");
    expect(nonces()).toEqual([]);
    expect(requests("POST", IMPORT)).toEqual([]);
  });

  it("a disabled connector's false capability does not misreport a permitted query write as blocked", async () => {
    const cwd = await pulled();
    changeQuery(cwd);
    server.state.features.database_connector_enabled = false;
    const result = await cli(sb, ["apply", "--json"], { cwd });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json()).toMatchObject({ ready: true, show_to_person: true, database_queries: { may_write_queries: false, connector_enabled: false } });
    expect(result.stderr).toContain("database connector switched off");
    expect(result.stderr).not.toContain("which this credential may not do");
    expect(nonces()).toEqual([]);
  });

  it("a server-reported query write takes precedence over an empty generic summary", async () => {
    const cwd = await pulled();
    changeQuery(cwd);
    server.state.previewExtras = { summary: { creates: {}, updates: {}, deletes: {}, references: {} }, changes: { items: [], total: 0 } };
    const preview = (await cli(sb, ["apply", "--json"], { cwd, env: AGENT })).json<Record<string, any>>();
    expect(preview).toMatchObject({ show_to_person: true, needs_person: "terminal", preview_id: expect.any(String) });
    expect(preview).not.toHaveProperty("nothing_to_import");
    expect(nonces()).toEqual([]);
    expect(requests("POST", IMPORT)).toEqual([]);
  });

  it.each([false, true])("older metadata keeps person approval with nonce enforcement %s", async (enforced) => {
    const cwd = await pulled();
    changeQuery(cwd);
    server.state.capsPatch = { database_connector: undefined, confirmations: undefined };
    server.state.servePrincipal = false;
    server.state.confirmations = enforced ? { enforced: true } : null;
    const preview = (await cli(sb, ["apply", "--json"], { cwd })).json<Record<string, any>>();
    expect(preview.database_queries.may_write_queries).toBeNull();
    expect(preview.show_to_person).toBe(true);
    expect((await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd })).code).toBe(0);
    expect(nonces()).toHaveLength(enforced ? 1 : 0);
    expect(requests("POST", IMPORT)).toHaveLength(enforced ? 2 : 1);
    expect(requests("POST", IMPORT)[0]!.headers[HEADER]).toBeUndefined();
    if (enforced) expect(requests("POST", IMPORT)[1]!.headers[HEADER]).toMatch(/^cfm_/);
  });

  it("rechecks the stored server report when an older kit recorded no person reason", async () => {
    const cwd = await pulled();
    changeQuery(cwd);
    const preview = (await cli(sb, ["apply", "--json"], { cwd })).json<Record<string, any>>();
    const file = path.join(cwd, ".cavelon", "previews", `${preview.preview_id}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.person_reason = null;
    writeFileSync(file, JSON.stringify(stored));
    expect((await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd, env: AGENT })).code).toBe(5);
    expect(nonces()).toEqual([]);
    expect(requests("POST", IMPORT)).toEqual([]);
  });

  it("an expired query-import nonce gives an actionable refusal and leaves the saved query unchanged", async () => {
    const cwd = await pulled();
    changeQuery(cwd);
    const preview = (await cli(sb, ["apply", "--json"], { cwd })).json<Record<string, any>>();
    server.state.confirmationTtlMs = 0;
    try {
      const refused = await cli(sb, ["apply", "--confirm", preview.preview_id, "--json"], { cwd });
      expect(refused.code).toBe(5);
      expect(refused.json<Record<string, any>>().error).toMatchObject({ code: "confirmation_invalid", hint: expect.stringMatching(/^Run the command again: it previews the change/), details: { confirmation_sent: true } });
      expect(seeded.query.max_rows).toBe(5);
      expect(requests("POST", IMPORT)).toHaveLength(1);
    } finally { server.state.confirmationTtlMs = 600_000; }
  });
});

describe("published query mutations through api", () => {
  const mutation = (method: string) => ({
    operation: method === "POST" ? "create_database_query" : method === "PATCH" ? "update_database_query" : "delete_database_query",
    ...(method !== "POST" ? { params: [`query_id=${seeded.query.id}`] } : {}),
    ...(method !== "DELETE" ? { body: JSON.stringify(method === "POST" ? { connection_id: seeded.connection.id, slug: "api_query", name: "API query", description: "A read-only query.", sql_text: "SELECT 1", parameters: [] } : { max_rows: 10 }) } : {}),
  });
  it.each(["POST", "PATCH", "DELETE"])("%s is a person change and carries the published nonce header after MCP approval", async (method) => {
    const mcp = await mcpClient(sb.home);
    try {
      const route = method === "POST" ? QUERIES : queryPath();
      const operation = method === "POST" ? "create_database_query" : method === "PATCH" ? "update_database_query" : "delete_database_query";
      const body = method === "POST" ? { connection_id: seeded.connection.id, slug: "api_query", name: "API query", description: "A read-only query.", sql_text: "SELECT 1", parameters: [] } : method === "PATCH" ? { max_rows: 10 } : undefined;
      const args = { operation, ...(method !== "POST" ? { params: [`query_id=${seeded.query.id}`] } : {}), ...(body ? { body: JSON.stringify(body) } : {}) };
      const preview = await mcp.call("api", args);
      expect(preview.body.instance_confirmation).toMatch(/^Always:/);
      expect(nonces()).toEqual([]);
      expect(requests(method, route)).toEqual([]);
      const result = await mcp.call("api", { ...args, confirm: preview.body.confirm_token });
      expect(result.isError, JSON.stringify(result.body)).toBe(false);
      expect(mcp.asked).toHaveLength(1);
      expect(nonces().map((r) => r.body)).toEqual([{ method, path: route, body: body ?? null }]);
      expect(requests(method, route)).toHaveLength(1);
      expect(requests(method, route)[0]!.headers[HEADER]).toMatch(/^cfm_/);
    } finally { await mcp.close(); }
  });

  it.each(["POST", "PATCH", "DELETE"])("%s cannot mutate when the person declines or an agent shell supplies the preview token", async (method) => {
    const args = mutation(method);
    const route = method === "POST" ? QUERIES : queryPath();
    const mcp = await mcpClient(sb.home, "declines");
    try {
      const preview = await mcp.call("api", args);
      const result = await mcp.call("api", { ...args, confirm: preview.body.confirm_token });
      expect(result.body.error.code).toBe("confirm_declined");
      const shellArgs = ["api", args.operation, ...(args.params ?? []), ...(args.body ? ["--body", args.body] : []), "--confirm", preview.body.confirm_token, "--json"];
      const shell = await cli(sb, shellArgs, { env: AGENT });
      expect(shell.code).toBe(5);
      expect(shell.json<Record<string, any>>().error).toMatchObject({ code: "confirm_needs_person", details: { person_command: expect.stringContaining(`cavelon api ${args.operation}`) } });
      expect(nonces()).toEqual([]);
      expect(requests(method, route)).toEqual([]);
      expect(seeded.query.version).toBe(1);
    } finally { await mcp.close(); }
  });

  it.each(["POST", "PATCH", "DELETE"])("%s refuses a PAT without manage and an API key with an actionable permission error", async (method) => {
    for (const kind of ["pat", "key"] as const) {
      const home = sandbox();
      try {
        await login(home, server.url, server.addToken({ kind, tenantIds: [tenant], defaultTenant: tenant, permissions: ["agents.view"] }));
        const args = mutation(method);
        const result = await cli(home, ["api", args.operation, ...(args.params ?? []), ...(args.body ? ["--body", args.body] : []), "--json"]);
        expect(result.code).toBe(7);
        expect(result.json<Record<string, any>>().error).toMatchObject({ status: 403, hint: expect.stringContaining("database_connectors.manage") });
        expect(nonces()).toEqual([]);
        expect(seeded.query.version).toBe(1);
      } finally { home.cleanup(); }
    }
  });
});
