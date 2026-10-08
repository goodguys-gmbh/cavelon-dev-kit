import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONTRACTS, startFakeServer, type FakeServer } from "./fake-server.js";
import { cli, login, sandbox, type Sandbox } from "./helpers.js";

let server: FakeServer;
let sb: Sandbox;
let tenant: string;
const snapshot = JSON.parse(readFileSync(path.join(CONTRACTS, "meta-capabilities.json"), "utf8"));
const operatorChange = snapshot.limits.values.find((v: any) => v.key === "max_concurrent_agent_runs_per_tenant").tenant_change;
const connectionLimit = { limit: 10, current: 9, source: "platform", platform_limit: 10 };
const queryLimit = { limit: 100, current: 101, source: "tenant", platform_limit: 200 };
const entries = [
  ["database_connections_per_tenant", "max_database_connections", 10, 1000],
  ["database_queries_per_tenant", "max_database_queries", 100, 10000],
].map(([key, field, value, maximum]) => ({ key, value, unit: "count", source: field === "max_database_queries" ? "tenant" : "platform", changeable_by: "operator", setting: field, scope: "tenant", docs: "/docs/concepts/database-connections#limits-per-tenant", description: "Published per-tenant database limit.", tenant_change: { ...operatorChange, field, minimum: 1, maximum } }));

beforeAll(async () => {
  server = await startFakeServer();
  server.state.features.database_connector_enabled = true;
  tenant = server.addTenant("example", "Example");
  sb = sandbox();
  await login(sb, server.url, server.addToken({ kind: "pat", tenantIds: [tenant], defaultTenant: tenant }));
});
beforeEach(() => {
  server.state.features.database_connector_enabled = true;
  server.state.capsPatch = { limits: { ...snapshot.limits, values: entries } };
  Object.assign(server.state.db.instance, { limits: { connections: connectionLimit, queries: queryLimit } });
  server.state.requests.length = 0;
  server.state.failures = [];
  server.state.tenantDatabaseCaps.clear();
});
afterAll(async () => { sb.cleanup(); await server.close(); });

it("shows the instance's effective database limits and counts in human output", async () => {
  const result = await cli(sb, ["db", "instance"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/database_connections_per_tenant\s+9\s+10\s+platform\s+10/);
  expect(result.stdout).toMatch(/database_queries_per_tenant\s+101\s+100\s+tenant\s+200/);
  expect((await cli(sb, ["db", "instance", "--json"])).json()).toMatchObject({ limits: { connections: connectionLimit, queries: queryLimit } });
});

it("limits reads published database counts, preserves over-limit counts, and filters keys", async () => {
  const result = await cli(sb, ["limits", "--key", "database_queries_per_tenant", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.json()).toMatchObject({ database_limits: [{ key: "database_queries_per_tenant", ...queryLimit }] });
  const text = await cli(sb, ["limits", "--key", "database_connections_per_tenant"]);
  expect(text.stdout).toMatch(/database_connections_per_tenant\s+9\s+10\s+platform\s+10/);
});

it("a tenant-only change asks for an explicit tenant instead of claiming a deploy is required", async () => {
  const result = await cli(sb, ["limits", "set", "database_queries_per_tenant", "250", "--json"]);
  expect(result.code).toBe(2);
  expect(result.json()).toMatchObject({ error: { code: "tenant_required", hint: expect.stringContaining("--tenant"), details: { sent: false } } });
  expect(server.state.requests.some(r => r.method === "PATCH")).toBe(false);
});

it("older instances and unreadable counts retain the published limit values", async () => {
  delete server.state.db.instance.limits;
  const older = await cli(sb, ["limits", "--json"]);
  expect(older.code, older.stderr).toBe(0);
  expect(older.json()).not.toHaveProperty("database_limits");
  server.state.failures = [{ method: "GET", path: /^\/api\/v1\/database-connectors\/instance$/, status: 403, detail: "Unavailable for this credential" }];
  const denied = await cli(sb, ["limits", "--json"]);
  expect(denied.code, denied.stderr).toBe(0);
  expect(denied.json()).toMatchObject({ groups: expect.arrayContaining([expect.objectContaining({ limits: expect.any(Array) })]) });
});

it("a platform operator previews, sets and resets a tenant-only database override", async () => {
  const operator = sandbox();
  const env = { CAVELON_URL: server.url, CAVELON_TOKEN: server.addToken({ kind: "pat", tenantIds: [tenant], platform: true, globalRole: "platform_admin" }) };
  try {
    const args = ["limits", "set", "database_queries_per_tenant", "250", "--tenant", "example"];
    const preview = await cli(operator, [...args, "--json"], { env });
    expect(preview.code, preview.stdout).toBe(0);
    expect(preview.json()).toMatchObject({ sent: false, operation: { body: { max_database_queries: 250 }, path: "/api/v1/tenants/{tenant_id}/limits" } });
    expect(server.state.requests.some(r => r.method === "PATCH")).toBe(false);
    const applied = await cli(operator, [...args, "--confirm", "--json"], { env });
    expect(applied.code, applied.stdout).toBe(0);
    expect(server.state.tenantDatabaseCaps.get(tenant)).toEqual({ max_database_queries: 250 });
    const sent = server.state.requests.find(r => r.method === "PATCH");
    expect(sent?.path).toBe(`/api/v1/tenants/${tenant}/limits`);
    expect(sent?.headers["x-tenant-id"]).toBeUndefined();
    const reset = await cli(operator, ["limits", "set", "database_queries_per_tenant", "none", "--tenant", "example", "--confirm", "--json"], { env });
    expect(reset.code, reset.stdout).toBe(0);
    expect(server.state.tenantDatabaseCaps.get(tenant)).toEqual({});
  } finally { operator.cleanup(); }
});

it("tenant owners and values beyond the published bounds cannot send a database limit change", async () => {
  const owner = await cli(sb, ["limits", "set", "database_connections_per_tenant", "20", "--tenant", "example", "--confirm", "--json"]);
  expect(owner.code).toBe(7);
  expect(owner.json()).toMatchObject({ error: { details: { sent: false } } });
  const invalid = await cli(sb, ["limits", "set", "database_connections_per_tenant", "1001", "--tenant", "example", "--confirm", "--json"]);
  expect(invalid.code).toBe(3);
  expect(server.state.requests.some(r => r.method === "PATCH")).toBe(false);
});

it.each(["database_connection_limit_reached", "database_query_limit_reached"])("explains the published %s refusal", async code => {
  const explained = await cli(sb, ["explain", code, "--json"]);
  expect(explained.code, explained.stdout).toBe(0);
  expect(explained.json()).toMatchObject({ code, kind: "api", hint: expect.stringContaining("platform operator") });
});
